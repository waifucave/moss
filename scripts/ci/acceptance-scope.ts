// Which acceptance units a change needs (ci.yml's `changes` job hands the answer to the `acceptance` jobs' matrix).
//
// The units are scripts/acceptance/shards.ts; a unit that is on GitHub is in ON_GITHUB (acceptance-units.ts). A change selects
//   * nothing when it cannot reach a unit: a test file, a doc, an app or a native library the units never start;
//   * the unit or units that own a step file when only that step file changed (the file a unit's `rows:` takes its step
//     constants from, read here from shards.ts itself, so a new unit's step file is mapped the day it is added), and the units
//     whose own step files import it;
//   * EVERY unit for anything else under the engine, the app, the SDK, the bundled plugins or the harness: run.ts, steps.ts,
//     ui-steps.ts, a helper, a fixture, a file nobody maps (fail closed: a path this file does not know runs the whole run).
// Plain TypeScript over the files' text: it runs in the `changes` job, before any install.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ON_GITHUB } from "./acceptance-units";

const ACCEPTANCE_DIR = "scripts/acceptance/";

/** What every unit runs on: the engine, the app, the SDK, the bundled plugins, the harness and the units' own driver. */
export const ACCEPTANCE_ALL: readonly string[] = [
  "packages/core/", "packages/protocol/", "packages/plugin-sdk/", "packages/cli/", "packages/test-harness/", "packages/app-release/", "packages/update-feed/",
  "apps/desktop/", "apps/moss/", "plugins/",
  // the run's driver and its pins
  "scripts/ci/acceptance-unit.ts", "scripts/ci/acceptance-units.ts", "scripts/heavy", "scripts/pinned-bun", "scripts/with-private-secret-service.sh",
];

/** A test file: the suites run it in the scripts', core's and app's jobs, and no unit loads one (a fixture or helper under a
 *  `test/` folder is not a test file, and does select, as a unit imports a few). */
const TEST_FILE = /\.test\.tsx?$/;

export interface StepMap {
  /** Step file (repo path) → the units whose rows come from it, and the units of the step files that import it. */
  byFile: ReadonlyMap<string, readonly string[]>;
}

/** The step tables every unit shares (the chain's rows, the window's steps): a constant from them maps no unit, a change to them runs all. */
const SHARED = new Set(["steps", "ui-steps"]);

/** The files that only register or drive units: the tables (shards.ts, steps.ts, elsewhere.ts) and the driver (run.ts). They may import
 *  a step file's row constants and its one runner function and still leave it a unit's own: anything else a driver takes from a step
 *  file (a seeding helper, a fixture, a port, a constant it shares with another unit's start-up) makes the file a helper of every unit. */
const DRIVERS = new Set(["shards", "steps", "elsewhere", "run"]);

/** A name a driver may import from a unit's step file: the unit's rows (`CARDS_STEP`, `MOSS_STEPS`) or its runner (`cardsStep`,
 *  `mossUnit`). A type-only import has no run-time effect and is ignored. */
const OWN_NAME = /^(?:[A-Z][A-Z0-9_]*_STEPS?|[a-z][A-Za-z0-9]*(?:Step|Unit))$/;

/** `from "./x"` and `import("./x")` in a file: which file it takes and the names it takes from it (undefined for a dynamic import). */
function importsOf(text: string): Array<{ file: string; names: string[] | undefined }> {
  const out: Array<{ file: string; names: string[] | undefined }> = [];
  for (const m of text.matchAll(/import\s+(type\s+)?(?:\{([^}]*)\}|([A-Za-z_$][\w$]*)|\*\s+as\s+[\w$]+)\s+from\s*"\.\/([A-Za-z0-9_-]+)"/g)) {
    if (m[1] !== undefined) continue; // `import type`
    const names = m[2] === undefined ? ["*"] : m[2].split(",").map((n) => n.trim()).filter((n) => n !== "" && !n.startsWith("type ")).map((n) => n.split(/\s+as\s+/)[0]!.trim());
    out.push({ file: m[4]!, names });
  }
  for (const m of text.matchAll(/(?:export\s*(?:\{[^}]*\}|\*)\s*from|import\s*\()\s*"\.\/([A-Za-z0-9_-]+)"/g)) out.push({ file: m[1]!, names: undefined });
  return out;
}

/** Read shards.ts: each unit's `rows:` constants and the file each is imported from, then keep a file as a unit's own only when
 *  nothing but the drivers' row and runner imports and other units' step files reach it. */
export function readStepMap(root: string): StepMap {
  const shards = readFileSync(resolve(root, ACCEPTANCE_DIR, "shards.ts"), "utf8");
  const fileOf = new Map<string, string>(); // constant -> file base name
  for (const m of shards.matchAll(/import\s*\{([^}]+)\}\s*from\s*"\.\/([A-Za-z0-9_-]+)";/g)) {
    for (const name of m[1]!.split(",").map((n) => n.trim()).filter(Boolean)) fileOf.set(name, m[2]!);
  }
  const unitsOfEntry = new Map<string, Set<string>>(); // file base name -> units
  for (const m of shards.matchAll(/\{\s*id:\s*"([a-z0-9-]+)",\s*rows:\s*([^\n]*?),\s*phase:/g)) {
    const unit = m[1]!;
    for (const c of m[2]!.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) {
      const file = fileOf.get(c[0]);
      if (file === undefined || SHARED.has(file)) continue;
      if (!unitsOfEntry.has(file)) unitsOfEntry.set(file, new Set());
      unitsOfEntry.get(file)!.add(unit);
    }
  }
  // Who imports what, over every file of the folder (a test file is no importer: it runs in the scripts' job).
  const importers = new Map<string, Array<{ from: string; names: string[] | undefined }>>();
  for (const name of readdirSync(resolve(root, ACCEPTANCE_DIR))) {
    if (!/\.tsx?$/.test(name) || TEST_FILE.test(name)) continue;
    const from = name.replace(/\.tsx?$/, "");
    for (const i of importsOf(readFileSync(resolve(root, ACCEPTANCE_DIR, name), "utf8"))) {
      if (!importers.has(i.file)) importers.set(i.file, []);
      importers.get(i.file)!.push({ from, names: i.names });
    }
  }
  // A step file with a helper's reach is nobody's own: every unit takes its change.
  for (const file of [...unitsOfEntry.keys()]) {
    const reached = (importers.get(file) ?? []).some((i) => {
      if (unitsOfEntry.has(i.from)) return false; // another unit's step file: its units are added below
      if (!DRIVERS.has(i.from)) return true; // a helper (the harness's start-up, a fixture, another row's probe)
      return i.names === undefined || i.names.some((n) => !OWN_NAME.test(n));
    });
    if (reached) unitsOfEntry.delete(file);
  }
  // A step file imported by another unit's step file is that unit's too (one entry file using another's helpers).
  const result = new Map<string, Set<string>>([...unitsOfEntry].map(([f, u]) => [f, new Set(u)]));
  for (let changed = true; changed;) {
    changed = false;
    for (const [file, units] of result) {
      for (const dep of importsOf(readFileSync(resolve(root, ACCEPTANCE_DIR, `${file}.ts`), "utf8")).map((i) => i.file)) {
        const to = result.get(dep);
        if (to === undefined) continue; // only another unit's step file takes part: a helper is not mapped (it runs every unit)
        for (const u of units) if (!to.has(u)) { to.add(u); changed = true; }
      }
    }
  }
  return { byFile: new Map([...result].map(([file, units]) => [`${ACCEPTANCE_DIR}${file}.ts`, [...units].sort()])) };
}

/** Where this checkout's root is (the folder above scripts/). */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** The GitHub units a change needs: `[]` when none, every ON_GITHUB unit when `changed` is undefined (no diff to go on) or a path
 *  selects them all. Units that are not on GitHub (NOT_ON_GITHUB) are never in the answer. */
export function acceptanceUnitsFor(changed: readonly string[] | undefined, root: string = REPO_ROOT): string[] {
  if (changed === undefined) return [...ON_GITHUB];
  const wanted = new Set<string>();
  let map: StepMap | undefined;
  for (const path of changed) {
    if (TEST_FILE.test(path)) continue;
    if (path.startsWith(ACCEPTANCE_DIR)) {
      map ??= readStepMap(root);
      const units = map.byFile.get(path);
      if (units === undefined) return [...ON_GITHUB]; // the harness, a helper, a fixture, a file nobody maps: every unit
      for (const u of units) wanted.add(u);
      continue;
    }
    if (ACCEPTANCE_ALL.some((p) => (p.endsWith("/") ? path.startsWith(p) : path === p || path.startsWith(`${p}/`)))) return [...ON_GITHUB];
  }
  return ON_GITHUB.filter((u) => wanted.has(u));
}

/** Every file under scripts/acceptance/ (repo paths), for the tests. */
export function acceptanceFiles(root: string = REPO_ROOT): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (name.isDirectory()) walk(`${rel}${name.name}/`);
      else out.push(`${rel}${name.name}`);
    }
  };
  walk(ACCEPTANCE_DIR);
  return out;
}
