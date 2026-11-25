// scripts/ci/acceptance-scope.ts: which acceptance units a change starts.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { acceptanceFiles, acceptanceUnitsFor, readStepMap } from "./acceptance-scope";
import { NOT_ON_GITHUB, ON_GITHUB } from "./acceptance-units";

describe("acceptance-scope, over this checkout", () => {
  const map = readStepMap(join(import.meta.dir, "..", ".."));

  test("a unit's step file is read from shards.ts: each file starts the unit whose rows it holds", () => {
    expect(map.byFile.get("scripts/acceptance/canvas-step.ts")).toEqual(["canvas"]);
    expect(map.byFile.get("scripts/acceptance/canvas-app-step.ts")).toEqual(["canvas-app"]);
    expect(map.byFile.get("scripts/acceptance/cards-step.ts")).toEqual(["cards"]);
    expect(map.byFile.get("scripts/acceptance/workshop-points-step.ts")).toEqual(["workshop-points"]);
    expect(map.byFile.get("scripts/acceptance/child-notify-step.ts")).toEqual(["plugin-app"]);
    // A step file one unit's step file imports starts that unit too (the tool setting's is the bundled tools' code tools' to use).
    expect(map.byFile.get("scripts/acceptance/tool-setting-step.ts")).toEqual(["bundled-tools"]);
    // The shared tables are no unit's: a change to them runs every unit.
    for (const shared of ["steps", "ui-steps", "shards", "run", "client"]) expect(map.byFile.has(`scripts/acceptance/${shared}.ts`), shared).toBe(false);
  });

  test("a step file the driver or a helper takes more from than its rows and its runner starts every unit", () => {
    // run.ts takes helpers from these (a seed, a port, a constant the start-up shares) and daemon.ts takes the host's lock: a change to
    // one is a change to a start-up several units run, so none of them is one unit's own.
    for (const f of ["example-steps", "archive-step", "host-step", "moss-step", "workshop-step", "browser-step", "setup-step", "code-adapter-step", "routine-schedule-step"]) {
      expect(map.byFile.has(`scripts/acceptance/${f}.ts`), f).toBe(false);
      expect(acceptanceUnitsFor([`scripts/acceptance/${f}.ts`]), f).toEqual([...ON_GITHUB]);
    }
  });

  test("every file under scripts/acceptance starts a unit of ON_GITHUB, or every one (a file nobody maps), or none (a test file)", () => {
    for (const file of acceptanceFiles()) {
      const got = acceptanceUnitsFor([file]);
      expect(got.every((u) => ON_GITHUB.includes(u)), file).toBe(true);
      if (/\.test\.tsx?$/.test(file)) expect(got, file).toEqual([]);
      else if (map.byFile.has(file)) expect(got.length, file).toBeLessThan(ON_GITHUB.length);
      else expect(got, file).toEqual([...ON_GITHUB]);
    }
  });

  test("the engine, the app, the SDK and the bundled plugins start every unit, except through a test file", () => {
    for (const f of ["packages/core/src/daemon.ts", "packages/protocol/src/index.ts", "packages/plugin-sdk/src/views.ts", "packages/cli/src/main.ts", "apps/moss/src/main/press.ts", "apps/desktop/src/main/index.ts", "plugins/moss/plugins/composer/client/entry.tsx", "scripts/ci/acceptance-unit.ts", "scripts/heavy"]) {
      expect(acceptanceUnitsFor([f]), f).toEqual([...ON_GITHUB]);
    }
    for (const f of ["packages/core/test/fence/win-fenced.test.ts", "apps/moss/test/press-load.test.tsx", "plugins/moss/plugins/composer/test/entry.test.tsx"]) expect(acceptanceUnitsFor([f]), f).toEqual([]);
    // Not a test file: a helper under test/ that a step imports (builder-examples reads plugin-builder's test/examples).
    expect(acceptanceUnitsFor(["plugins/moss/plugins/plugin-builder/test/examples.ts"])).toEqual([...ON_GITHUB]);
  });

  test("what the units never start starts none", () => {
    for (const f of ["apps/ios/project.yml", "native/phone-core/src/lib.rs", "native/link/src/main.rs", "services/push/src/index.ts", "examples/sample-echo/src/index.ts", "docs/moss-spec.md", "extensions/winter-for-chrome/src/a.ts", "scripts/ci/lane", "scripts/release/lib.ts"]) {
      expect(acceptanceUnitsFor([f]), f).toEqual([]);
    }
  });

  test("several files start the union of their units, in ON_GITHUB's order; one that starts every unit starts every unit", () => {
    expect(acceptanceUnitsFor(["scripts/acceptance/canvas-step.ts", "scripts/acceptance/cards-step.ts"])).toEqual(["cards", "canvas"]);
    expect(acceptanceUnitsFor(["scripts/acceptance/canvas-step.ts", "scripts/acceptance/run.ts"])).toEqual([...ON_GITHUB]);
  });

  test("the units that are not on GitHub are never started by GitHub; their step files are read like any other", () => {
    for (const u of Object.keys(NOT_ON_GITHUB)) expect(ON_GITHUB).not.toContain(u);
    // (the release rows' constants are used by the driver beyond its rows, so its file runs every GitHub unit)
    expect(acceptanceUnitsFor(["scripts/acceptance/release-step.ts"])).toEqual([...ON_GITHUB]);
  });
});

describe("acceptance-scope, over a made-up checkout", () => {
  // shards.ts as the reader sees it: imports, then one `{ id, rows, phase }` line per unit.
  const SHARDS = `
import { A_STEP } from "./a-step";
import { B_STEP, B_TWO_STEP } from "./b-step";
import { C_STEPS } from "./c-step";
import { FULL_STEPS } from "./steps";
const OTHERS = [
  { id: "alpha", rows: [A_STEP], phase: "parallel", estimate: 1 },
  { id: "beta", rows: [B_STEP, B_TWO_STEP], phase: "parallel", estimate: 1 },
  { id: "gamma", rows: [...C_STEPS], phase: "parallel", estimate: 1 },
  { id: "chain", rows: FULL_STEPS, phase: "parallel", estimate: 1 },
];`;

  function checkout(files: Record<string, string>): { root: string; done: () => void } {
    const root = mkdtempSync(join(tmpdir(), "acceptance-scope-"));
    for (const [rel, text] of Object.entries({ "scripts/acceptance/shards.ts": SHARDS, ...files })) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), text);
    }
    return { root, done: () => rmSync(root, { recursive: true, force: true }) };
  }

  test("a step file another unit's step file imports starts that unit too; a helper nobody maps starts every unit; the driver taking more than rows and a runner makes a file every unit's", () => {
    const c = checkout({
      "scripts/acceptance/a-step.ts": `import { helper } from "./b-step";`,
      "scripts/acceptance/b-step.ts": ``,
      "scripts/acceptance/c-step.ts": ``,
      "scripts/acceptance/steps.ts": ``,
      "scripts/acceptance/helper.ts": ``,
      // The driver takes a-step's rows and its runner only, b-step's rows too, and c-step's rows and a seeding helper.
      "scripts/acceptance/run.ts": `import { A_STEP, aStep } from "./a-step";\nimport { B_STEP, type BCtx } from "./b-step";\nimport {\n  C_STEPS,\n  seedC,\n} from "./c-step";`,
    });
    try {
      const map = readStepMap(c.root);
      // a-step imports b-step: a change to b-step reaches alpha (which uses it) as well as beta.
      expect(map.byFile.get("scripts/acceptance/b-step.ts")).toEqual(["alpha", "beta"]);
      expect(map.byFile.get("scripts/acceptance/a-step.ts")).toEqual(["alpha"]);
      // run.ts takes `seedC` from c-step, a helper of whichever unit starts up with it: c-step is no unit's own.
      expect(map.byFile.has("scripts/acceptance/c-step.ts")).toBe(false);
      expect(map.byFile.has("scripts/acceptance/steps.ts")).toBe(false);
      // (the real unit names are filtered by ON_GITHUB: none of these is on GitHub)
      expect(acceptanceUnitsFor(["scripts/acceptance/helper.ts"], c.root)).toEqual([...ON_GITHUB]);
      expect(acceptanceUnitsFor(["scripts/acceptance/c-step.ts"], c.root)).toEqual([...ON_GITHUB]);
      expect(acceptanceUnitsFor(["scripts/acceptance/a-step.ts"], c.root)).toEqual([]);
    } finally {
      c.done();
    }
  });

  test("a helper that imports a step file makes it every unit's", () => {
    const c = checkout({ "scripts/acceptance/a-step.ts": ``, "scripts/acceptance/b-step.ts": ``, "scripts/acceptance/c-step.ts": ``, "scripts/acceptance/window.ts": `import { x } from "./a-step";` });
    try {
      const map = readStepMap(c.root);
      expect(map.byFile.has("scripts/acceptance/a-step.ts")).toBe(false);
      expect(map.byFile.get("scripts/acceptance/b-step.ts")).toEqual(["beta"]);
    } finally {
      c.done();
    }
  });
});
