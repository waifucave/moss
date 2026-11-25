// Which CI jobs a change needs (ci.yml's `changes` job). Each area lists the paths its jobs read; a change to CI itself,
// the toolchain, the root manifest or a lockfile runs every area but the Swift kits, which a change to CI itself runs. The names-and-layout checks and the gate run always.
// A path no area, no global list and no inert list knows runs EVERY area (fail closed): a new top-level folder, a new app or a
// new native library is mapped here when it is added, never run by accident with less than it needs.
//
//   bun scripts/ci-changes.ts --base <rev>   the files changed between <rev> and HEAD decide (a pull request's base,
//                                            the main a merge-queue group was built on, or a lane's merge-base with its
//                                            integration branch); a revision that cannot be read runs every area
//   bun scripts/ci-changes.ts --all          every area (a push to an integration branch, a manual run of everything)
//   bun scripts/ci-changes.ts --only-acceptance   no area but the acceptance run, every unit of it (a manual `only: acceptance`)
//   --refuse-empty                           a diff of no file is every area, not none (a lane's scoped run)
//   --queue                                  a pull request or a merge-queue group: the new map UNIONED with the frozen old one (ci/queue-map.ts)
//   --why <text>                             what the scope line says about why (the event that chose it)
//
// Prints `<area>=true|false` per area, `acceptance_units=<json list>` (the acceptance units the run starts) and the scope
// (`scope=` one line, `scope_ran=` and `scope_skipped=` the areas that ran and the ones skipped as untouched), and appends
// the same lines to $GITHUB_OUTPUT when it is set.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { legacyAreasFor } from "./ci/queue-map";
import { acceptanceUnitsFor, ACCEPTANCE_ALL } from "./ci/acceptance-scope";
import { ON_GITHUB } from "./ci/acceptance-units";

export type CiArea =
  | "workspaces" | "daemon" | "app" | "packages" | "installers" | "gallery" | "typecheck" | "lockfiles"
  | "extension" | "core" | "cli" | "scripts" | "scriptsmac" | "codegen" | "swift" | "verify" | "tree" | "link" | "linuxrepo" | "adapters"
  | "acceptance" | "cowork" | "windows" | "corelinux" | "fenceguard";

/** A path pattern: `dir/` is a prefix, a `*` matches within one segment, `**` across segments, else an exact path. A `!` in front
 *  takes the paths it matches back out of the patterns before it in the same list (an area's list only). */
type Pattern = string;

/** Changes to any of these run every area: CI itself, the toolchain, the root manifest and the lockfiles. */
export const CI_GLOBAL: readonly Pattern[] = [
  ".github/workflows/ci.yml", "scripts/ci-changes.ts", ".bun-version", ".bun-sha256", "package.json", "bun.lock", "pnpm-lock.yaml",
  "pnpm-workspace.yaml", "tsconfig.base.json", "bunfig.toml", ".npmrc", ".gitattributes",
  // the scoping itself: what ci-changes.ts imports (the acceptance units' list and the step-to-unit map) and the lane tool that starts and
  // previews a scoped run. A change to how a run is sized is checked by the largest run.
  "scripts/ci/acceptance-units.ts", "scripts/ci/acceptance-scope.ts", "scripts/ci/queue-map.ts", "scripts/ci/test-reads.ts", "scripts/ci/test-reads.test.ts", "scripts/ci/queue-map.test.ts", "scripts/ci/plan.ts", "scripts/ci/lane",
];

/** The Windows fence's own definition: the called workflow and its PowerShell. It is the `windows` area alone: it starts `windows-fence` (a Windows runner) and no macOS job.
 *  (`machine-windows` has no step for these files: its steps run on the workspaces, the daemon and the app. The merge queue's frozen map, scripts/ci/queue-map.ts, still sends it to the old areas.) */
const WINDOWS_CI: readonly Pattern[] = [".github/workflows/windows-fence.yml", "scripts/ci/windows-fence/"];

/** Paths no job reads: documents and the repository's own housekeeping. A change to only these runs no area (the names-and-layout
 *  checks and the gate run always). Everything else must be in an area, or it runs every area. */
// docs/ is inert but for what a test reads: the live gates' page (the app's test asserts it equals its generator's output), the three guides the
// core's tests pin (usage, release, settings) and the Cowork specs and notes its tests read, by exact file. A `!` takes those back out.
export const CI_INERT: readonly Pattern[] = ["docs/", "*.md", "LICENSE", ".gitignore", "!docs/live-gates/",
  "!docs/claude/release.md", "!docs/claude/settings-and-migrations.md", "!docs/claude/usage.md", "!docs/RELEASE-NOTES-cowork-schema.md",
  "!docs/cowork-execution-contracts.md", "!docs/cowork-host-protocol.md", "!docs/cowork-implementation.md", "!docs/cowork-native-worker.md", "!docs/cowork-spec.md"];

/** What the tests READ outside their own folder (scripts/ci/test-reads.ts finds them; scripts/ci/test-reads.test.ts holds this to it): each
 *  list is added to the area whose job runs those tests, so a change to a file a test reads starts the test. */
const READ_BY_CORE_MAC: readonly Pattern[] = [
  // what the core's macOS tests read (the `*.darwin.test.ts` files and the ones marked with the darwin-only helper; the macOS legs run no other file):
  // the launcher's code identity, the app's file grants, the entitlements; and, on purpose, all of apple/ and the Cowork specs and notes (Cowork is
  // paused: nothing reaches a macOS leg by accident, a Cowork read keeps the leg it had)
  "apple/", "apps/desktop/src/main/ui/file-grants.ts", "packaging/macos/entitlements.mac.plist",
  // and what a macOS-run test IMPORTS from outside the core (scripts/ci/test-reads.ts: importsOf): the Cowork native helper script, the CLI's client
  "scripts/cowork-native-lib.ts", "packages/cli/src/client.ts",
  "docs/RELEASE-NOTES-cowork-schema.md", "docs/cowork-execution-contracts.md", "docs/cowork-host-protocol.md", "docs/cowork-implementation.md", "docs/cowork-native-worker.md", "docs/cowork-spec.md",
];
const READ_BY_CORE_LINUX: readonly Pattern[] = [
  // what only the core's Linux shards read (every core test file that is not darwin-only runs there and nowhere else): a change here starts
  // `core · linux` and no macOS leg. The plugins, the scripts and the examples are walked by the core's own scans (the plugin reach, the
  // daemon-spawn pin over scripts/, the SDK examples); the guides are three exact files (docs/claude/ has 18, tests pin these)
  "plugins/", "scripts/", "examples/", "packages/", "!packages/core/", "!packages/protocol/", "!packages/plugin-sdk/", "!packages/update-feed/", "assets/brand/moss-code/", "services/shared/", "services/forwarder/",
  "docs/claude/release.md", "docs/claude/settings-and-migrations.md", "docs/claude/usage.md",
  "apps/desktop/package.json", "apps/desktop/src/main/browser/network.ts", "apps/desktop/src/main/ui/", "VERSION", "VERSIONS.json", ".github/workflows/",
];
const READ_BY_SCRIPTS: readonly Pattern[] = [
  // brand-icons.test.ts reads the theme and the sidebar's, the conversation's and the plugin index's marks; packaging.test.ts checks every bundled plugin's moss.json;
  // the release tests read the bundled plugins; the preview tests read the canvas and the theme
  "plugins/",
  // the services' deploy tests read the services' wrangler configs and env example
  "services/",
];
const READ_BY_SCRIPTSMAC: readonly Pattern[] = [
  // the helper embed test reads the helper's own version, the Cowork bundle tests its pins and sources, the runtimes test the pins file and the core's runtime-sdk
  "VERSIONS.json", "apple/ComputerUse/VERSION", "apple/Cowork/", "apple/Winter/project.yml", "packages/cli/src/", "packages/core/src/", "packages/core/test/cowork/",
];
const READ_BY_WORKSPACES: readonly Pattern[] = [
  // apps/desktop's file-log test imports the acceptance's evidence list (the one file; the steps' needle scan is a scripts test)
  "scripts/acceptance/evidence-lines.ts",
];
const READ_BY_MACHINE: readonly Pattern[] = ["docs/live-gates/", "native/input/macos/screen.mm"];
const READ_BY_EXTENSION: readonly Pattern[] = ["packages/core/src/computer-use/browser/"];

// The update feed's check is in the daemon's binary (packages/cli's `__verify-feed`) and, after E-M1, the app's updater.
const CORE: readonly Pattern[] = ["packages/core/", "packages/protocol/", "packages/plugin-sdk/", "packages/update-feed/"];

/** What each area's jobs read. */
export const CI_AREAS: Readonly<Record<CiArea, readonly Pattern[]>> = {
  // every workspace package's own tests, on all four machines
  // (the iPhone apps and the phone core are no workspace packages: they have their own workflows, so they take no machine here)
  workspaces: ["packages/", "apps/desktop/", "apps/moss/", "apps/*/package.json", "plugins/", "services/", "native/*/package.json", "examples/", "spikes/", "scripts/workspaces.ts", "scripts/with-private-secret-service.sh", ...READ_BY_WORKSPACES, ...READ_BY_MACHINE],
  daemon: [...CORE, "packages/cli/", "scripts/build-daemon.ts", "scripts/seal-bun-doors.ts", "scripts/verify-sealed-core.ts", "scripts/moss-core.entitlements", ...READ_BY_MACHINE],
  // the app, and what it loads: MOSS's own plugins and the plugin SDK's UI API (E-M1)
  app: ["apps/desktop/", "apps/moss/", "plugins/moss/", "packages/plugin-sdk/", "packages/app-release/", ...READ_BY_MACHINE],
  // the Linux packages: the app, its builder config, packaging/, the scripts that build them, and the daemon and the
  // link sidecar they carry (the job installs the deb and runs its `moss`)
  // (MOSS's packages are built beside MOSS Code's: its builder config, its host layout script and its icons)
  packages: ["apps/desktop/", "apps/moss/electron-builder.yml", "apps/moss/package.json", "apps/moss/scripts/host-helper.mjs", "apps/moss/build/", "packaging/", "scripts/build-packages.ts", "scripts/build-daemon.ts", "scripts/seal-bun-doors.ts", "scripts/release/", ...CORE, "packages/app-release/", "packages/cli/", "native/link/"],
  // the macOS and Windows installers (the unsigned release build: dmg, zip, NSIS), on macOS and Windows machines: only
  // what makes them, so a code change alone doesn't spend a macOS job on them (the app and daemon jobs build those)
  installers: ["apps/desktop/electron-builder.yml", "apps/desktop/package.json", "apps/moss/electron-builder.yml", "apps/moss/package.json", "apps/moss/scripts/host-helper.mjs", "apps/moss/build/", "packaging/", "scripts/release/", "scripts/build-daemon.ts", "scripts/seal-bun-doors.ts",
    "scripts/build-packages.ts", "packages/update-feed/"],
  // (the galleries are built against the plugin SDK and the protocol the plugins import)
  gallery: ["plugins/", "packages/plugin-sdk/", "packages/protocol/"],
  typecheck: ["packages/", "apps/desktop/", "apps/moss/", "plugins/", "services/", "examples/", "scripts/", "**/tsconfig*.json"],
  lockfiles: ["**/package.json"],
  extension: ["extensions/", ...READ_BY_EXTENSION],
  // the core's sources and what its macOS tests read: `core · linux` and the three macOS legs
  core: [...CORE, ...READ_BY_CORE_MAC],
  // the Linux-only part of the core's reads: `core · linux` alone, no macOS leg (lane A's model plugins, which the core's catalog and
  // generator check reads, and the rest of READ_BY_CORE_LINUX: the account tests' services/shared and sign-in stub, the forwarder's Worker)
  corelinux: ["plugins/moss/plugins/model-*/**/*", ...READ_BY_CORE_LINUX],
  // the Windows fence's own files: the `windows-fence` job, on a Windows runner; nothing on macOS (`machine-windows` has no step for them)
  // (and the sources of the Windows-only core tests that job runs: the plugin host's pipe link and process, the plugin guard's run folder, the ACL read-back, the caller probe, the secrets store)
  windows: [...WINDOWS_CI, "packages/core/src/plugin-host/", "packages/core/src/registry/plugin-run.ts", "packages/core/src/platform/win-acl.ts", "packages/core/src/platform/caller-probe.ts",
    "packages/core/src/secrets/", "packages/core/test/platform/win-acl.test.ts"],
  // the fence and the approval checks, and the Windows launcher's own sources: the windows-fence end-to-end job as a guard IN the lane gate
  // (`windows-fence-guard`, lane WS11), so a change that weakens the fence or its share refusal never reaches the integration branch green
  // (and the guard's own test file: weakening the test weakens the guard)
  fenceguard: ["packages/core/src/fence/", "packages/core/src/approvals/", "packages/core/test/fence/win-fenced.e2e.test.ts", "scripts/build-srt-win.ps1", "vendor/srt-win/patches/",
    "scripts/ci/windows-fence/build-launcher.ps1"],
  cli: [...CORE, "packages/cli/"],
  // the repo scripts' tests read the core, the CLI, the app, the release inputs and the workflows; its job also runs the
  // repo-wide source scans (the native channel's anti-wiring test reads every package's src/ and scripts/), so any
  // package's source runs it: a CLI-only change that imports from the core once got past the core's skipped shards
  // Also what sits beside the repo's own tests and has no job of its own: the iPhone apps, the phone core and the native helpers (their own
  // workflows build them), the brand assets, the relay's infrastructure files, the release notes and feed, and the vendored patches: the
  // scripts' tests (the brand icons, the release and packaging checks, the rename scan) read them, so a change to one runs that one Linux job.
  scripts: ["scripts/", "packages/core/", "packages/cli/", "packages/*/src/**/*", "apps/desktop/", "apps/moss/", "apps/ios/", "apps/android/", "apple/", "packaging/", "VERSION", "VERSIONS.json", ".github/",
    "native/sandbox/", "native/input/", "native/link-sidecar/", "native/phone-core/", "native/README.md", "assets/", "infra/", "releases/", "vendor/", ...READ_BY_SCRIPTS],
  // the scripts' few macOS-only tests (scripts/**/*.darwin.test.ts, on a macOS runner): the scripts themselves only, so
  // a change under apple/ alone takes no macOS runner for them (a push to main still runs every area)
  // (not the acceptance harness and CI's own scripts: no `*.darwin.test.ts` reads them, and a macOS job per leg is the dear part of a lane's run)
  scriptsmac: ["scripts/", "!scripts/acceptance/", "!scripts/ci/", ...READ_BY_SCRIPTSMAC],
  codegen: ["packages/protocol/"],
  // PARKED (see PARKED): the browser host's Swift tests (apple/ComputerUse/WinterBrowserHost), on a macOS runner: that folder and nothing
  // else. The old Mac app's kits left this repository.
  swift: ["apple/ComputerUse/WinterBrowserHost/"],
  verify: [...CORE, "packages/cli/", "scripts/verify-", "scripts/stage-runtimes.ts", "scripts/fetch-ant.ts", "scripts/build-winter.ts", "VERSIONS.json"],
  // the tree and the computers on Linux and Windows (macOS runs them in the core suite): their code, their tests and
  // lane B's conformance suites for them
  tree: ["packages/core/src/computers/", "packages/core/src/tree/", "packages/core/test/computers/", "packages/core/test/tree/",
    "packages/core/src/contracts/tests/tree.test.ts", "packages/core/src/contracts/tests/computer-registry.test.ts",
    // an agent backend's bare command on PATH (its .exe or .cmd on Windows)
    "packages/core/src/agents/backend.ts", "packages/core/src/agents/process/launch.ts", "packages/core/src/agents/tests/windows-path.test.ts",
    // the bundled agent plugins' manifests, whose bare commands that check is about
    "plugins/moss/plugins/agent-*/moss.json",
    // the secrets file on Windows (its key in Credential Manager, its ACL), and the store's door
    "packages/core/src/secrets/", "packages/core/test/secrets/", "packages/core/src/auth/secret-store.ts", "packages/core/test/fence/secrets-file-fence.test.ts"],
  // the link sidecar (moss-link) built on every OS, and the core's link tests over it: the sidecar, the links, and
  // what they import (the devices and identity the handshake and pairing use, the contracts, the clock, the protocol)
  link: ["native/link/", "packages/core/src/links/", "packages/core/src/devices/", "packages/core/src/identity/",
    "packages/core/src/contracts/", "packages/core/src/clock/", "packages/protocol/"],
  // the Linux repositories' signatures, checked with gpgv and sqv
  linuxrepo: ["scripts/release/linux-repo.ts", "scripts/release/linux-repo-verify.ts"],
  // the real pinned agent adapters, fetched from the public registry and started on Bun (the `agent adapters` job, and a
  // step of the macOS job): the agent plugins that declare one, the agents' code, and the lock generator
  adapters: ["plugins/moss/plugins/agent-*/**/*", "packages/core/src/agents/", "scripts/agent-adapter-lock.ts"],
  // the acceptance run (scripts/acceptance, one macOS job per unit): the engine, the app, the SDK and the bundled plugins it drives, its own
  // harness and the pins of its driver. Which UNITS a change starts is scripts/ci/acceptance-scope.ts (a step file starts its own unit); this
  // area is true when it starts any. iOS and the phone core are not in it: no unit starts them.
  acceptance: [...ACCEPTANCE_ALL, "scripts/acceptance/"],
  // PARKED: the Cowork Swift launcher's tests (a macOS job) and the libkrun patch queue's guards: Cowork's own sources only (the Swift
  // packages and the engine's cowork folder), on a manual run. Cowork is paused (spec §12).
  cowork: ["apple/Cowork/", "packages/core/src/cowork/"],
};

/** Areas that build parts the first release does not ship, on a macOS runner (the old Chrome extension's native host, Cowork's launcher):
 *  they run ONLY when their own sources change (CI_AREAS), never for CI's own definition, the toolchain, a lockfile, an unmapped path
 *  or `--all` (a lane's `--all` and a no-diff run leave them out; `--parked` and `lane start --parked` run them). Nothing is deleted:
 *  the jobs, the workflows and the sources stay, and the gate treats a skipped one as passed. */
export const PARKED: readonly CiArea[] = ["swift", "cowork"];

export const CI_AREA_NAMES = Object.keys(CI_AREAS) as CiArea[];

function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += "(?:.*/)?";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Whether any pattern of a list takes `path` (a `!pattern` takes it back out). */
export function matchesAny(path: string, patterns: readonly Pattern[]): boolean {
  return patterns.some((g) => !g.startsWith("!") && matches(path, g)) && !patterns.some((g) => g.startsWith("!") && matches(path, g.slice(1)));
}

export function matches(path: string, pattern: Pattern): boolean {
  if (pattern.includes("*")) return globToRegex(pattern).test(path);
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  // `scripts/verify-` style: a file-name prefix within one folder
  if (pattern.endsWith("-")) return path.startsWith(pattern) && !path.slice(pattern.length).includes("/");
  return path === pattern;
}

/** Areas CI_GLOBAL turns on only through these of its files: the installers' release build (a macOS and a Windows machine for a
 *  quarter of an hour) through none, so a change keeps to three macOS jobs, and the parked areas through none either. A push to
 *  main still runs every other area. */
export const NARROW_GLOBAL: Readonly<Partial<Record<CiArea, readonly Pattern[]>>> = { swift: [], installers: [], cowork: [] };

/** Whether a path is in any list of this file (an area, CI_GLOBAL, CI_INERT): the ones that are not run every area. */
export function isKnown(path: string): boolean {
  const known = (patterns: readonly Pattern[]): boolean => matchesAny(path, patterns);
  return known(CI_GLOBAL) || known(CI_INERT) || CI_AREA_NAMES.some((a) => known(CI_AREAS[a]));
}

/** The paths of `changed` that run every area: the ones no list knows (fail closed). */
export function unmapped(changed: readonly string[]): string[] {
  return changed.filter((p) => !isKnown(p));
}

/** The areas `changed` takes (every one for no diff or a path no area maps), but for the PARKED ones, which only their own sources
 *  take. `parked` says what decides those: the default is `changed` itself (no diff: none), a list of paths is another diff
 *  (`lane start --all` keeps them to the lane's own changes), "all" runs them (a base that could not be read, `--parked`). */
export function areasFor(changed: readonly string[] | undefined, parked?: readonly string[] | "all"): Record<CiArea, boolean> {
  const decides = parked ?? changed;
  const ownSources = (a: CiArea): boolean => decides === "all" || (decides !== undefined && decides.some((p) => matchesAny(p, CI_AREAS[a])));
  const touched = changed === undefined || unmapped(changed).length > 0 ? undefined : changed;
  const touches = (patterns: readonly Pattern[]): boolean => touched !== undefined && touched.some((p) => matchesAny(p, patterns));
  const all = touches(CI_GLOBAL);
  return Object.fromEntries(CI_AREA_NAMES.map((a) => {
    if (PARKED.includes(a)) return [a, ownSources(a)];
    if (touched === undefined) return [a, true];
    if (a === "acceptance") return [a, acceptanceUnits(touched).length > 0];
    const narrow = NARROW_GLOBAL[a];
    return [a, (narrow === undefined ? all : touches(narrow)) || touches(CI_AREAS[a])];
  })) as Record<CiArea, boolean>;
}

/** What a pull request and the merge queue take: the UNION of the new map and the frozen old one (scripts/ci/queue-map.ts). A lane's own run is
 *  scoped by the new map alone; main's gate never selects less than it did before lanes were scoped. */
export function queueAreasFor(changed: readonly string[] | undefined, parked?: readonly string[] | "all"): Record<CiArea, boolean> {
  const now = areasFor(changed, parked);
  const old = legacyAreasFor(changed) as Partial<Record<CiArea, boolean>>;
  return Object.fromEntries(CI_AREA_NAMES.map((a) => [a, now[a] || old[a] === true])) as Record<CiArea, boolean>;
}

/** The acceptance units (of ON_GITHUB) `changed` starts: every one for no diff, a path no list knows, or CI's own definition, the
 *  toolchain, the root manifest or a lockfile; else what scripts/ci/acceptance-scope.ts selects. */
export function acceptanceUnits(changed: readonly string[] | undefined): string[] {
  if (changed === undefined || unmapped(changed).length > 0 || changed.some((p) => matchesAny(p, CI_GLOBAL))) return [...ON_GITHUB];
  return acceptanceUnitsFor(changed);
}

function changedSince(base: string): string[] | undefined {
  try {
    // No rename detection: a file moved out of one area into another counts in BOTH (the old path is a change too).
    return execFileSync("git", ["diff", "--name-only", "--no-renames", base, "HEAD"], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return undefined; // no such revision here: run everything rather than guess
  }
}

/** The scope of a run, in words a person reads: what ran, what was skipped as untouched, and why the run is as big as it is. */
export function scopeOf(input: { changed: readonly string[] | undefined; areas: Record<CiArea, boolean>; units: readonly string[]; why: string; base?: string; onlyAcceptance?: boolean }): { scope: string; ran: string[]; skipped: string[] } {
  const ran = CI_AREA_NAMES.filter((a) => input.areas[a]);
  const skipped = CI_AREA_NAMES.filter((a) => !input.areas[a]);
  const units = `${input.units.length} of ${ON_GITHUB.length} acceptance units`;
  if (input.onlyAcceptance === true) return { scope: `ACCEPTANCE ONLY: ${units}; no other area (${input.why})`, ran, skipped };
  const full = skipped.every((a) => PARKED.includes(a)) && input.units.length === ON_GITHUB.length;
  const parkedOff = skipped.filter((a) => PARKED.includes(a));
  // A run of everything still leaves the parked areas to their own sources; it says so, so "FULL" is never read as "all of them".
  const note = parkedOff.length > 0 ? `; parked, not run (none of their own sources changed): ${parkedOff.join(" ")}; lane start --parked runs them` : "";
  if (input.changed === undefined) return { scope: `FULL RUN: every area, ${units} (${input.why}${note})`, ran, skipped };
  const stray = unmapped(input.changed);
  const files = `${input.changed.length} file(s) changed${input.base !== undefined ? ` since ${input.base}` : ""}`;
  if (stray.length > 0) return { scope: `FULL RUN: every area, ${units}: ${stray.length} changed path(s) no area maps, e.g. ${stray.slice(0, 3).join(", ")} (fail closed; ${files}${note})`, ran, skipped };
  if (full) return { scope: `FULL RUN: every area, ${units}, as the ${files} touched them all (${input.why}${note})`, ran, skipped };
  // Two areas are narrower than their names: said in the line, so a reader never takes `corelinux` for the core's whole suite or `windows` for the Windows legs.
  const narrow = [
    input.areas.corelinux && !input.areas.core ? "corelinux: core · linux only, no macOS leg" : "",
    input.areas.windows ? "windows: windows-fence only" : "",
  ].filter((n) => n !== "");
  return { scope: `SCOPED RUN: ${ran.length} of ${CI_AREA_NAMES.length} areas ran, ${skipped.length} skipped as untouched; ${units} (${files}; ${input.why}${narrow.length > 0 ? `; ${narrow.join("; ")}` : ""})`, ran, skipped };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const at = argv.indexOf(name); return at === -1 ? undefined : (argv[at + 1] ?? ""); };
  const onlyAcceptance = argv.includes("--only-acceptance");
  const base = flag("--base");
  const parkedBase = flag("--parked-base");
  let changed = onlyAcceptance ? [] : argv.includes("--all") || base === undefined ? undefined : changedSince(base);
  // `--refuse-empty` (a lane's scoped run): a base that counts NO changed file is not a scope, it is a mistake (the base is HEAD, or the lane has
  // nothing of its own): the run starts every job (the parked ones too: not knowing is not a reason to skip) rather than a green over nothing.
  const emptyDiff = changed !== undefined && !onlyAcceptance && changed.length === 0 && argv.includes("--refuse-empty");
  if (emptyDiff) changed = undefined;
  // The parked areas (PARKED): their own sources in the diff, else nothing. A forced run (`--parked`), or a diff that could not be read
  // (a base this runner cannot fetch), runs them: not knowing is not a reason to skip.
  const parkedDiff = parkedBase === undefined ? undefined : changedSince(parkedBase);
  const unreadable = emptyDiff || (base !== undefined && !argv.includes("--all") && changed === undefined) || (parkedBase !== undefined && parkedDiff === undefined);
  const parked = argv.includes("--parked") || unreadable ? "all" : parkedDiff;
  // `--queue`: a pull request or a merge-queue group takes the old map too (queueAreasFor)
  const areaMap = argv.includes("--queue") ? queueAreasFor : areasFor;
  const areas: Record<CiArea, boolean> = onlyAcceptance ? { ...(Object.fromEntries(CI_AREA_NAMES.map((a) => [a, false])) as Record<CiArea, boolean>), acceptance: true } : areaMap(changed, parked);
  const units = onlyAcceptance ? [...ON_GITHUB] : areas.acceptance ? acceptanceUnits(changed) : [];
  let why = flag("--why") ?? (changed === undefined ? "no diff to go on" : "the diff decides");
  if (emptyDiff) why = `the base ${base!.slice(0, 12)} counts NO changed file: a scoped run over nothing would check nothing, so every job runs. ${why}`;
  else if (base !== undefined && !argv.includes("--all") && !onlyAcceptance && changed === undefined) why = `the base ${base.slice(0, 12)} could not be read here: fail closed. ${why}`;
  const { scope, ran, skipped } = scopeOf({ changed, areas, units, why, ...(base !== undefined && changed !== undefined ? { base: base.slice(0, 9) } : {}), onlyAcceptance });
  const lines = [
    ...CI_AREA_NAMES.map((a) => `${a}=${areas[a]}`),
    `acceptance_units=${JSON.stringify(units)}`,
    `scope=${scope}`,
    `scope_ran=${ran.join(" ")}`,
    `scope_skipped=${skipped.join(" ")}`,
  ];
  console.log(changed === undefined ? "ci-changes: every area" : `ci-changes: ${changed.length} file(s) changed`);
  for (const l of lines) console.log(l);
  const out = process.env.GITHUB_OUTPUT;
  if (out !== undefined && out !== "") appendFileSync(out, `${lines.join("\n")}\n`);
}
