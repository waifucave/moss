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
//   --why <text>                             what the scope line says about why (the event that chose it)
//
// Prints `<area>=true|false` per area, `acceptance_units=<json list>` (the acceptance units the run starts) and the scope
// (`scope=` one line, `scope_ran=` and `scope_skipped=` the areas that ran and the ones skipped as untouched), and appends
// the same lines to $GITHUB_OUTPUT when it is set.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { acceptanceUnitsFor, ACCEPTANCE_ALL } from "./ci/acceptance-scope";
import { ON_GITHUB } from "./ci/acceptance-units";

export type CiArea =
  | "workspaces" | "daemon" | "app" | "packages" | "installers" | "gallery" | "typecheck" | "lockfiles"
  | "extension" | "core" | "cli" | "scripts" | "scriptsmac" | "codegen" | "swift" | "verify" | "tree" | "link" | "linuxrepo" | "adapters"
  | "acceptance" | "cowork";

/** A path pattern: `dir/` is a prefix, a `*` matches within one segment, `**` across segments, else an exact path. A `!` in front
 *  takes the paths it matches back out of the patterns before it in the same list (an area's list only). */
type Pattern = string;

/** Changes to any of these run every area: CI itself, the toolchain, the root manifest and the lockfiles. */
export const CI_GLOBAL: readonly Pattern[] = [
  ".github/workflows/ci.yml", "scripts/ci-changes.ts", ".bun-version", ".bun-sha256", "package.json", "bun.lock", "pnpm-lock.yaml",
  "pnpm-workspace.yaml", "tsconfig.base.json", "bunfig.toml", ".npmrc", ".gitattributes",
];

/** Paths no job reads: documents and the repository's own housekeeping. A change to only these runs no area (the names-and-layout
 *  checks and the gate run always). Everything else must be in an area, or it runs every area. */
export const CI_INERT: readonly Pattern[] = ["docs/", "*.md", "LICENSE", ".gitignore"];

// The update feed's check is in the daemon's binary (packages/cli's `__verify-feed`) and, after E-M1, the app's updater.
const CORE: readonly Pattern[] = ["packages/core/", "packages/protocol/", "packages/plugin-sdk/", "packages/update-feed/"];

/** What each area's jobs read. */
export const CI_AREAS: Readonly<Record<CiArea, readonly Pattern[]>> = {
  // every workspace package's own tests, on all four machines
  // (the iPhone apps and the phone core are no workspace packages: they have their own workflows, so they take no machine here)
  workspaces: ["packages/", "apps/desktop/", "apps/moss/", "apps/*/package.json", "plugins/", "services/", "native/*/package.json", "examples/", "spikes/", "scripts/workspaces.ts", "scripts/with-private-secret-service.sh"],
  daemon: [...CORE, "packages/cli/", "scripts/build-daemon.ts", "scripts/seal-bun-doors.ts", "scripts/verify-sealed-core.ts", "scripts/moss-core.entitlements"],
  // the app, and what it loads: MOSS's own plugins and the plugin SDK's UI API (E-M1)
  app: ["apps/desktop/", "apps/moss/", "plugins/moss/", "packages/plugin-sdk/", "packages/app-release/"],
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
  extension: ["extensions/"],
  // lane A's model plugins: the core's catalog and generator check reads them; the core's account tests import the
  // services' shared account-token check and the harness's sign-in stub
  core: [...CORE, "plugins/moss/plugins/model-*/**/*", "services/shared/", "packages/test-harness/src/signin-stub.ts"],
  cli: [...CORE, "packages/cli/"],
  // the repo scripts' tests read the core, the CLI, the app, the release inputs and the workflows; its job also runs the
  // repo-wide source scans (the native channel's anti-wiring test reads every package's src/ and scripts/), so any
  // package's source runs it: a CLI-only change that imports from the core once got past the core's skipped shards
  // Also what sits beside the repo's own tests and has no job of its own: the iPhone apps, the phone core and the native helpers (their own
  // workflows build them), the brand assets, the relay's infrastructure files, the release notes and feed, and the vendored patches: the
  // scripts' tests (the brand icons, the release and packaging checks, the rename scan) read them, so a change to one runs that one Linux job.
  scripts: ["scripts/", "packages/core/", "packages/cli/", "packages/*/src/**/*", "apps/desktop/", "apps/moss/", "apps/ios/", "apple/", "packaging/", "VERSION", "VERSIONS.json", ".github/",
    "native/sandbox/", "native/input/", "native/link-sidecar/", "native/phone-core/", "native/README.md", "assets/", "infra/", "releases/", "vendor/"],
  // the scripts' few macOS-only tests (scripts/**/*.darwin.test.ts, on a macOS runner): the scripts themselves only, so
  // a change under apple/ alone takes no macOS runner for them (a push to main still runs every area)
  // (not the acceptance harness and CI's own scripts: no `*.darwin.test.ts` reads them, and a macOS job per leg is the dear part of a lane's run)
  scriptsmac: ["scripts/", "!scripts/acceptance/", "!scripts/ci/"],
  codegen: ["packages/protocol/"],
  // the browser host's Swift tests (apple/ComputerUse/WinterBrowserHost), on a macOS runner: the apple/ tree and nothing
  // else (SWIFT_GLOBAL). The old Mac app's kits left this repository.
  swift: ["apple/"],
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
  // the Cowork Swift launcher's tests (a macOS job) and the libkrun patch queue's guards: apple/Cowork only, on a manual run. Cowork is paused (spec §12).
  cowork: ["apple/Cowork/"],
};

/** The CI_GLOBAL changes that still run the Swift kits: CI's own definition, not the toolchain or the lockfiles. */
export const SWIFT_GLOBAL: readonly Pattern[] = [".github/workflows/ci.yml", "scripts/ci-changes.ts"];

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

/** Areas CI_GLOBAL turns on only through these of its files: the Swift kits through CI's own definition, and the
 *  installers' release build (a macOS and a Windows machine for a quarter of an hour) through none, so a change keeps
 *  to three macOS jobs. A push to main still runs every area. */
export const NARROW_GLOBAL: Readonly<Partial<Record<CiArea, readonly Pattern[]>>> = { swift: SWIFT_GLOBAL, installers: [], cowork: SWIFT_GLOBAL };

/** Whether a path is in any list of this file (an area, CI_GLOBAL, CI_INERT): the ones that are not run every area. */
export function isKnown(path: string): boolean {
  const known = (patterns: readonly Pattern[]): boolean => matchesAny(path, patterns);
  return known(CI_GLOBAL) || known(CI_INERT) || CI_AREA_NAMES.some((a) => known(CI_AREAS[a]));
}

/** The paths of `changed` that run every area: the ones no list knows (fail closed). */
export function unmapped(changed: readonly string[]): string[] {
  return changed.filter((p) => !isKnown(p));
}

function everyArea(): Record<CiArea, boolean> {
  return Object.fromEntries(CI_AREA_NAMES.map((a) => [a, true])) as Record<CiArea, boolean>;
}

/** The areas `changed` needs. `undefined` (no diff to go on) and a diff holding a path no list knows run every area. */
export function areasFor(changed: readonly string[] | undefined): Record<CiArea, boolean> {
  if (changed === undefined || unmapped(changed).length > 0) return everyArea();
  const touches = (patterns: readonly Pattern[]): boolean => changed.some((p) => matchesAny(p, patterns));
  const all = touches(CI_GLOBAL);
  return Object.fromEntries(CI_AREA_NAMES.map((a) => {
    if (a === "acceptance") return [a, acceptanceUnits(changed).length > 0];
    const narrow = NARROW_GLOBAL[a];
    return [a, (narrow === undefined ? all : touches(narrow)) || touches(CI_AREAS[a])];
  })) as Record<CiArea, boolean>;
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
  const full = skipped.length === 0 && input.units.length === ON_GITHUB.length;
  if (input.changed === undefined) return { scope: `FULL RUN: every area, ${units} (${input.why})`, ran, skipped };
  const stray = unmapped(input.changed);
  const files = `${input.changed.length} file(s) changed${input.base !== undefined ? ` since ${input.base}` : ""}`;
  if (stray.length > 0) return { scope: `FULL RUN: every area, ${units}: ${stray.length} changed path(s) no area maps, e.g. ${stray.slice(0, 3).join(", ")} (fail closed; ${files})`, ran, skipped };
  if (full) return { scope: `FULL RUN: every area, ${units}, as the ${files} touched them all (${input.why})`, ran, skipped };
  return { scope: `SCOPED RUN: ${ran.length} of ${CI_AREA_NAMES.length} areas ran, ${skipped.length} skipped as untouched; ${units} (${files}; ${input.why})`, ran, skipped };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => { const at = argv.indexOf(name); return at === -1 ? undefined : (argv[at + 1] ?? ""); };
  const onlyAcceptance = argv.includes("--only-acceptance");
  const base = flag("--base");
  const changed = onlyAcceptance ? [] : argv.includes("--all") || base === undefined ? undefined : changedSince(base);
  const areas: Record<CiArea, boolean> = onlyAcceptance ? { ...(Object.fromEntries(CI_AREA_NAMES.map((a) => [a, false])) as Record<CiArea, boolean>), acceptance: true } : areasFor(changed);
  const units = onlyAcceptance ? [...ON_GITHUB] : areas.acceptance ? acceptanceUnits(changed) : [];
  let why = flag("--why") ?? (changed === undefined ? "no diff to go on" : "the diff decides");
  if (base !== undefined && !argv.includes("--all") && !onlyAcceptance && changed === undefined) why = `the base ${base.slice(0, 12)} could not be read here: fail closed. ${why}`;
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
