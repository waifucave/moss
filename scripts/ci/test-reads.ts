// What the repo's tests READ from outside their own folder, found by reading the tests (no run): the inputs CI's path map must send to the job
// that runs the test. A test that reads `docs/live-gates/browser.md` or `plugins/.../icons.tsx` is a test of that file: a change to it has to
// start the job, whatever folder the file is in. scripts/ci/test-reads.test.ts holds the map to this list; ci-changes.ts holds the answer.
//
// The scan is on the SOURCE of each test file: a string literal that is a path from the repo root (`docs/live-gates/browser.md`, also
// written `../../docs/...`), and the literals of a `join(...)` or `resolve(...)` call that name a top-level folder of the repo and walk
// down it (`join(root, "plugins", "moss", "plugins")`). A path read that is built another way (a name assembled in a loop) is not seen:
// the scan finds what is written, which is what a person adding a read writes first.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..", "..");

/** Tests the always-on `names` job runs (ci.yml): they run for every change, so what they read needs no mapping. */
export const ALWAYS_ON: readonly RegExp[] = [/^packages\/core\/test\/rename\//, /^scripts\/rename\//, /^scripts\/layout\.test\.ts$/, /^scripts\/workspaces\.test\.ts$/, /^scripts\/ci-changes\.test\.ts$/];

/** Tests that name repo paths as DATA (the inputs of the path map, fixtures of a CI helper), not files they read: no read to map. */
export const PATHS_AS_DATA: readonly string[] = ["scripts/ci/acceptance-scope.test.ts", "scripts/ci/plan.test.ts", "scripts/ci/lane.test.ts", "scripts/ci/test-reads.test.ts", "scripts/ci/queue-map.test.ts"];

/** Root files whose bare name is read for what it holds; any other bare root name in a test (`README.md`, `.gitignore`) is a fixture's name in a temp folder. */
export const ROOT_FILES_READ: readonly string[] = ["VERSION", "VERSIONS.json"];

/** Top-level folders a test walks whole when it joins their bare name (`join(ROOT, "scripts")`): the read is of every file in them. */
export const BARE_FOLDERS: readonly string[] = ["scripts", "plugins", "packages", "apps", "services", "examples", "docs", "apple", "native", "packaging", "assets", "extensions", "releases", "infra", "vendor"];

/** A join whose first argument is the repo root (a temp folder named `dir` joined to "docs" is not a read of the repo's docs). */
const ROOT_ARG = /^(?:ROOT|REPO|repo|repoRoot|REPO_ROOT|ROOT_DIR|root|PROJECT_ROOT|projectRoot|import\.meta\.dir|__dirname|join\(import\.meta\.dir)/;

export type Tracked = { files: Set<string>; dirs: Set<string>; top: Set<string> };

export function tracked(root = ROOT): Tracked {
  const files = new Set(execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28 }).split("\n").filter(Boolean));
  const dirs = new Set<string>();
  for (const f of files) { const p = f.split("/"); for (let i = 1; i < p.length; i++) dirs.add(p.slice(0, i).join("/")); }
  const top = new Set([...dirs].filter((d) => !d.includes("/")).concat([...files].filter((f) => !f.includes("/"))));
  return { files, dirs, top };
}

/** Whether a core test file runs on the macOS legs: `*.darwin.test.ts`, or a file marked with the darwin-only helper (scripts/platform-tests.ts:
 *  `macosFiles`). Every other core test file runs on the Linux shards and nowhere else. */
export function runsOnMacos(testFile: string, src?: string): boolean {
  if (testFile.endsWith(".darwin.test.ts")) return true;
  let text = src;
  if (text === undefined) {
    try { text = readFileSync(join(ROOT, testFile), "utf8"); } catch { return false; }
  }
  return /from\s+["'][^"']*helpers\/darwin-only["']/.test(text);
}

/** The job areas that run a test file (any one of them runs it), or null for a file no CI job runs (the spikes', the apps' fixtures). A core test
 *  is `corelinux` too unless it runs on macOS: a change to what only Linux reads starts the Linux shards and no macOS leg. */
export function ownersOf(testFile: string, src?: string): string[] | null {
  if (testFile.startsWith("spikes/") || testFile.startsWith("apple/") || PATHS_AS_DATA.includes(testFile)) return null;
  if (ALWAYS_ON.some((r) => r.test(testFile))) return null;
  if (testFile.startsWith("scripts/")) return [/\.darwin\.test\./.test(testFile) ? "scriptsmac" : "scripts"];
  // (the core's link tests also run in the `link` job, which builds the sidecar they drive)
  if (testFile.startsWith("packages/core/")) {
    const linux = runsOnMacos(testFile, src) ? [] : ["corelinux"];
    return testFile.startsWith("packages/core/src/links/") ? ["core", ...linux, "link"] : ["core", ...linux];
  }
  if (testFile.startsWith("packages/cli/")) return ["cli"];
  if (testFile.startsWith("extensions/")) return ["extension"];
  // (the apps', plugins', services', examples' and packages' own tests run in the workspaces' job, where `WORKSPACES` is set: ci.yml's `machine`)
  if (/^(apps|plugins|services|examples|packages)\//.test(testFile)) return ["workspaces"];
  return null;
}

const LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

/** The repo paths (files or folders, as far as they exist) a test source names. */
export function readsOf(src: string, t: Tracked): Set<string> {
  const out = new Set<string>();
  const exists = (p: string): boolean => t.files.has(p) || t.dirs.has(p);
  const add = (raw: string): void => {
    let p = raw.replace(/^(\.\.?\/)+/, "").replace(/\$\{[^}]*\}.*$/, "").replace(/\*.*$/, "").replace(/\/+$/, "");
    if (p === "" || !t.top.has(p.split("/")[0]!)) return;
    const seg = p.split("/");
    while (seg.length > 0 && !exists(seg.join("/"))) seg.pop();
    const q = seg.join("/");
    if (q !== "" && (q.includes("/") || ROOT_FILES_READ.includes(q))) out.add(t.files.has(q) ? q : `${q}/`);
  };
  for (const m of src.matchAll(LITERAL)) {
    const s = m[2]!;
    if (/^[\w.@-]+\/[\w./@-]/.test(s) || ROOT_FILES_READ.includes(s)) add(s);
  }
  for (const m of src.matchAll(/\b(?:join|resolve)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    const parts = [...m[1]!.matchAll(LITERAL)].map((x) => x[2]!);
    for (let i = 0; i < parts.length; i++) {
      const first = parts[i]!.replace(/^(\.\.?\/)+/, "");
      if (t.top.has(first.split("/")[0]!) && first !== "") {
        const path = parts.slice(i).join("/");
        add(path);
        // A top-level FOLDER named alone in a join is a read of everything in it (a walk): `join(ROOT, "scripts")`.
        const bare = path.replace(/^(\.\.?\/)+/, "").replace(/\/+$/, "");
        if (t.dirs.has(bare) && !bare.includes("/") && BARE_FOLDERS.includes(bare) && ROOT_ARG.test(m[1]!.trimStart())) out.add(`${bare}/`);
        break;
      }
    }
  }
  return out;
}

/** A read as a changed path the map can be asked about: a folder read is any file in it. */
export const asChange = (read: string): string => (read.endsWith("/") ? `${read}__any__` : read);

/** Every (test file, path it reads) pair the CI jobs run, for tests with an owner. */
export function allReads(root = ROOT): Array<{ test: string; owners: string[]; read: string }> {
  const t = tracked(root);
  const out: Array<{ test: string; owners: string[]; read: string }> = [];
  for (const f of t.files) {
    if (!/\.(test|proof)\.tsx?$/.test(f)) continue;
    const src = readFileSync(join(root, f), "utf8");
    const owners = ownersOf(f, src);
    if (owners === null) continue;
    for (const read of readsOf(src, t)) if (read !== f) out.push({ test: f, owners, read });
  }
  return out;
}
