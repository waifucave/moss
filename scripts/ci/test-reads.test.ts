// The path map follows what the tests read: every file a test names outside its own folder starts the job that runs that test. A lane's scoped run
// is the only gate before the merge, so a test whose input changed and never ran is a hole: this test finds it from the tests' own source.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { areasFor } from "../ci-changes";
import { allReads, ALWAYS_ON, asChange, ownersOf, readsOf, ROOT, tracked, type Tracked } from "./test-reads";

const fake = (files: string[]): Tracked => {
  const set = new Set(files);
  const dirs = new Set<string>();
  for (const f of files) { const p = f.split("/"); for (let i = 1; i < p.length; i++) dirs.add(p.slice(0, i).join("/")); }
  return { files: set, dirs, top: new Set([...dirs].filter((d) => !d.includes("/")).concat(files.filter((f) => !f.includes("/")))) };
};

describe("the scan of what a test reads", () => {
  const t = fake(["docs/live-gates/browser.md", "plugins/moss/plugins/sidebar/client/icons.tsx", "plugins/moss/plugins/base-theme/theme.json", "scripts/a.ts", "VERSION", "README.md", "apple/ComputerUse/VERSION"]);

  test("a path from the root, written bare or climbing out of the test's folder, is a read", () => {
    expect([...readsOf(`readFileSync(resolve(import.meta.dir, "../../../docs/live-gates/browser.md"))`, t)]).toEqual(["docs/live-gates/browser.md"]);
    expect([...readsOf("const P = 'plugins/moss/plugins/sidebar/client/icons.tsx';", t)]).toEqual(["plugins/moss/plugins/sidebar/client/icons.tsx"]);
  });

  test("a join that walks down from a top-level folder is a read of the file at the end, a folder named alone in a join from the root is a read of all of it", () => {
    expect([...readsOf(`join(ROOT, "plugins", "moss", "plugins", "base-theme", "theme.json")`, t)]).toEqual(["plugins/moss/plugins/base-theme/theme.json"]);
    expect([...readsOf(`readdirSync(join(ROOT, "scripts"))`, t)]).toContain("scripts/");
    // a temp folder joined to a folder's name is not the repo's
    expect([...readsOf(`mkdirSync(join(dir, "docs"))`, t)]).toEqual([]);
  });

  test("a bare root name in a fixture (README.md, .gitignore) is no read; the version files are", () => {
    expect([...readsOf(`writeFileSync(join(dir, "README.md"), "x"); writeFileSync(join(dir, ".gitignore"), "")`, t)]).toEqual([]);
    expect([...readsOf(`readFileSync(join(ROOT, "VERSION"), "utf8")`, t)]).toEqual(["VERSION"]);
  });

  test("a name that is not in the repo is no read", () => {
    expect([...readsOf(`join(ROOT, "plugins", "nothing", "here.ts")`, t)]).toEqual([]);
    expect([...readsOf(`"docs/not-a-file-anywhere.md"`, t)]).toEqual([]);
  });
});

describe("the map starts the job that runs each test when a file the test reads changes", () => {
  const reads = allReads();

  test("the scan sees the tests' reads (a broken scan must not pass for nothing)", () => {
    expect(reads.length).toBeGreaterThan(300);
    expect(new Set(reads.map((r) => r.test)).size).toBeGreaterThan(100);
  });

  test("every path a test reads selects one of the areas whose job runs that test", () => {
    const uncovered = new Map<string, string[]>();
    for (const r of reads) {
      const a = areasFor([asChange(r.read)]) as Record<string, boolean>;
      if (!r.owners.some((o) => a[o] === true)) {
        const key = `${r.owners.join("|")} ← ${r.read}`;
        uncovered.set(key, [...(uncovered.get(key) ?? []), r.test]);
      }
    }
    // Each line: the area(s) that run the test, the path it reads, and the first tests that read it. Add the path to the area in scripts/ci-changes.ts (READ_BY_*).
    expect([...uncovered].map(([k, ts]) => `${k}  (${ts.slice(0, 2).join(", ")})`)).toEqual([]);
  });

  test("the named cases: the theme's colours and the marks start `scripts`, a bundled plugin's manifest too, the live-gates page the app's tests, a Cowork source the macOS script tests", () => {
    const on = (p: string): string[] => Object.entries(areasFor([p])).filter(([, v]) => v).map(([k]) => k);
    for (const p of ["plugins/moss/plugins/base-theme/theme.json", "plugins/moss/plugins/sidebar/client/icons.tsx", "plugins/moss/plugins/conversation/client/icons.tsx", "plugins/moss/plugins/plugin-index/client/icons.tsx", "plugins/moss/plugins/shell/moss.json"]) expect(on(p), p).toContain("scripts");
    for (const a of ["workspaces", "daemon", "app"]) expect(on("docs/live-gates/browser.md")).toContain(a);
    // the guides a core test pins start the core's Linux shards (those tests run on Linux only), by exact file: the others are inert
    for (const g of ["usage", "release", "settings-and-migrations"]) expect(on(`docs/claude/${g}.md`), g).toEqual(["corelinux"]);
    expect(on("docs/claude/testing.md")).toEqual([]);
    expect(on("docs/claude/tool-surface.md")).toEqual([]);
    for (const p of ["apple/ComputerUse/VERSION", "apple/Cowork/WinterCoworkHVFWorker/pins.json", "apple/Cowork/WinterCoworkLauncher/Sources/LauncherCore/Identity/CodeIdentity.swift", "packages/core/src/cowork/host-env/environment.ts"]) expect(on(p), p).toContain("scriptsmac");
    // documents no test reads, and the repository's own housekeeping, start nothing
    for (const p of ["docs/moss-plan.md", "docs/research/x.md", "README.md", "LICENSE", ".gitignore"]) expect(on(p), p).toEqual([]);
  });
});

describe("the tests the scan leaves out", () => {
  test("the always-on tests are what ci.yml's `names` job runs", () => {
    const ci = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).toContain("bun test test/rename/");
    expect(ci).toContain("bun test scripts/rename/ scripts/layout.test.ts scripts/workspaces.test.ts scripts/ci-changes.test.ts");
    expect(ALWAYS_ON.map((r) => r.source)).toEqual([String.raw`^packages\/core\/test\/rename\/`, String.raw`^scripts\/rename\/`, String.raw`^scripts\/layout\.test\.ts$`, String.raw`^scripts\/workspaces\.test\.ts$`, String.raw`^scripts\/ci-changes\.test\.ts$`]);
  });

  test("a test file has an owner, or is one no job runs (the spikes', the Swift packages')", () => {
    expect(ownersOf("scripts/brand-icons.test.ts")).toEqual(["scripts"]);
    expect(ownersOf("scripts/embed-runtimes.darwin.test.ts")).toEqual(["scriptsmac"]);
    // a core test file runs on the Linux shards, and on the macOS legs too only when it is darwin-only or marked with the darwin-only helper
    expect(ownersOf("packages/core/test/x.test.ts", "test('a', () => {})")).toEqual(["core", "corelinux"]);
    expect(ownersOf("packages/core/test/x.darwin.test.ts", "")).toEqual(["core"]);
    expect(ownersOf("packages/core/test/y.test.ts", 'import { darwinTest } from "./helpers/darwin-only";')).toEqual(["core"]);
    expect(ownersOf("packages/core/src/links/tests/z.test.ts", "")).toEqual(["core", "corelinux", "link"]);
    // the apps', plugins', services', examples' and packages' own tests run only where the workspaces' job runs them
    expect(ownersOf("apps/desktop/test/browser-live-gate.test.ts")).toEqual(["workspaces"]);
    for (const f of ["plugins/moss/plugins/shell/test/a.test.ts", "services/push/test/a.test.ts", "examples/x/a.test.ts", "packages/test-harness/test/a.test.ts"]) expect(ownersOf(f), f).toEqual(["workspaces"]);
    expect(ownersOf("spikes/s1-transport/x.test.ts")).toBeNull();
    expect(ownersOf("packages/core/test/rename/moss-residue.test.ts")).toBeNull();
    // every tracked test file is one of these three: owned, always on, or no job's
    const everyone = [...tracked().files].filter((f) => /\.(test|proof)\.tsx?$/.test(f));
    expect(everyone.length).toBeGreaterThan(1000);
  });
});
