// The merge queue's and the pull requests' map, FROZEN as it was on lane-int/moss at 8ce5aef0b (before lanes were scoped). A lane's own manual run
// takes the new, scoped map (scripts/ci-changes.ts); the pull request and the merge queue take the UNION of the two (queueAreasFor in
// ci-changes.ts), so scoping a lane can never make main's gate select less than it did: a path either map selects for an area selects it
// there. Do not edit the lists below to narrow the queue; widen the new map instead, and delete this file only with the owner's word.
export type LegacyArea =
  | "workspaces" | "daemon" | "app" | "packages" | "installers" | "gallery" | "typecheck" | "lockfiles"
  | "extension" | "core" | "cli" | "scripts" | "scriptsmac" | "codegen" | "swift" | "verify" | "tree" | "link" | "linuxrepo" | "adapters";
type Pattern = string;

/** Changes to any of these run every area: CI itself, the toolchain, the root manifest and the lockfiles. */
export const LEGACY_GLOBAL: readonly Pattern[] = [
  ".github/workflows/ci.yml", "scripts/ci-changes.ts", ".bun-version", ".bun-sha256", "package.json", "bun.lock", "pnpm-lock.yaml",
  "pnpm-workspace.yaml", "tsconfig.base.json", "bunfig.toml",
];

// The update feed's check is in the daemon's binary (packages/cli's `__verify-feed`) and, after E-M1, the app's updater.
const CORE: readonly Pattern[] = ["packages/core/", "packages/protocol/", "packages/plugin-sdk/", "packages/update-feed/"];

/** What each area's jobs read. */
export const LEGACY_AREAS: Readonly<Record<LegacyArea, readonly Pattern[]>> = {
  // every workspace package's own tests, on all four machines
  workspaces: ["packages/", "apps/", "plugins/", "services/", "native/", "examples/", "spikes/", "scripts/workspaces.ts", "scripts/with-private-secret-service.sh"],
  daemon: [...CORE, "packages/cli/", "scripts/build-daemon.ts", "scripts/seal-bun-doors.ts", "scripts/verify-sealed-core.ts", "scripts/moss-core.entitlements"],
  // the app, and what it loads: MOSS's own plugins and the plugin SDK's UI API (E-M1)
  app: ["apps/", "plugins/moss/", "packages/plugin-sdk/"],
  // the Linux packages: the app, its builder config, packaging/, the scripts that build them, and the daemon and the
  // link sidecar they carry (the job installs the deb and runs its `moss`)
  // (MOSS's packages are built beside MOSS Code's: its builder config, its host layout script and its icons)
  packages: ["apps/desktop/", "apps/moss/electron-builder.yml", "apps/moss/package.json", "apps/moss/scripts/host-helper.mjs", "apps/moss/build/", "packaging/", "scripts/build-packages.ts", "scripts/build-daemon.ts", "scripts/seal-bun-doors.ts", "scripts/release/", ...CORE, "packages/cli/", "native/link/"],
  // the macOS and Windows installers (the unsigned release build: dmg, zip, NSIS), on macOS and Windows machines: only
  // what makes them, so a code change alone doesn't spend a macOS job on them (the app and daemon jobs build those)
  installers: ["apps/desktop/electron-builder.yml", "apps/desktop/package.json", "apps/moss/electron-builder.yml", "apps/moss/package.json", "apps/moss/scripts/host-helper.mjs", "apps/moss/build/", "packaging/", "scripts/release/", "scripts/build-daemon.ts", "scripts/seal-bun-doors.ts",
    "scripts/build-packages.ts", "packages/update-feed/"],
  gallery: ["plugins/"],
  typecheck: ["packages/", "apps/", "plugins/", "services/", "examples/", "scripts/", "**/tsconfig*.json"],
  lockfiles: ["**/package.json"],
  extension: ["extensions/"],
  // lane A's model plugins: the core's catalog and generator check reads them; the core's account tests import the
  // services' shared account-token check and the harness's sign-in stub
  core: [...CORE, "plugins/moss/plugins/model-*/**/*", "services/shared/", "packages/test-harness/src/signin-stub.ts"],
  cli: [...CORE, "packages/cli/"],
  // the repo scripts' tests read the core, the CLI, the app, the release inputs and the workflows; its job also runs the
  // repo-wide source scans (the native channel's anti-wiring test reads every package's src/ and scripts/), so any
  // package's source runs it: a CLI-only change that imports from the core once got past the core's skipped shards
  scripts: ["scripts/", "packages/core/", "packages/cli/", "packages/*/src/**/*", "apps/", "apple/", "packaging/", "VERSION", "VERSIONS.json", ".github/"],
  // the scripts' few macOS-only tests (scripts/**/*.darwin.test.ts, on a macOS runner): the scripts themselves only, so
  // a change under apple/ alone takes no macOS runner for them (a push to main still runs every area)
  scriptsmac: ["scripts/"],
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
};

/** The CI_GLOBAL changes that still run the Swift kits: CI's own definition, not the toolchain or the lockfiles. */
const LEGACY_SWIFT_GLOBAL: readonly Pattern[] = [".github/workflows/ci.yml", "scripts/ci-changes.ts"];

const NAMES = Object.keys(LEGACY_AREAS) as LegacyArea[];

function legacyGlobToRegex(glob: string): RegExp {
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

function legacyMatches(path: string, pattern: Pattern): boolean {
  if (pattern.includes("*")) return legacyGlobToRegex(pattern).test(path);
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  // `scripts/verify-` style: a file-name prefix within one folder
  if (pattern.endsWith("-")) return path.startsWith(pattern) && !path.slice(pattern.length).includes("/");
  return path === pattern;
}

/** Areas CI_GLOBAL turns on only through these of its files: the Swift kits through CI's own definition, and the
 *  installers' release build (a macOS and a Windows machine for a quarter of an hour) through none, so a change keeps
 *  to three macOS jobs. A push to main still runs every area. */
const LEGACY_NARROW: Readonly<Partial<Record<LegacyArea, readonly Pattern[]>>> = { swift: LEGACY_SWIFT_GLOBAL, installers: [] };

/** The areas `changed` took in the old map. `undefined` (no diff to go on) is every area. */
export function legacyAreasFor(changed: readonly string[] | undefined): Record<LegacyArea, boolean> {
  if (changed === undefined) return Object.fromEntries(NAMES.map((a) => [a, true])) as Record<LegacyArea, boolean>;
  const touches = (patterns: readonly Pattern[]): boolean => changed.some((p) => patterns.some((g) => legacyMatches(p, g)));
  const all = touches(LEGACY_GLOBAL);
  return Object.fromEntries(NAMES.map((a) => {
    const narrow = LEGACY_NARROW[a];
    return [a, (narrow === undefined ? all : touches(narrow)) || touches(LEGACY_AREAS[a])];
  })) as Record<LegacyArea, boolean>;
}
