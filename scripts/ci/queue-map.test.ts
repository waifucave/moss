// The merge queue and pull requests never select less than they did before lanes were scoped: they take the frozen old map UNIONED with the new one.
import { describe, expect, test } from "bun:test";
import { areasFor, CI_AREA_NAMES, queueAreasFor } from "../ci-changes";
import { legacyAreasFor } from "./queue-map";
import { tracked } from "./test-reads";

describe("queueAreasFor: what a pull request and a merge-queue group take", () => {
  const files = [...tracked().files];

  test("for every tracked file, the queue takes every area the old map took and every area the new map takes", () => {
    const missing: string[] = [];
    for (const f of files) {
      const q = queueAreasFor([f]);
      const old = legacyAreasFor([f]) as Record<string, boolean>;
      const now = areasFor([f]);
      for (const a of CI_AREA_NAMES) {
        if (old[a] === true && !q[a]) missing.push(`${f}: ${a} (old map)`);
        if (now[a] && !q[a]) missing.push(`${f}: ${a} (new map)`);
      }
    }
    expect(missing.slice(0, 10)).toEqual([]);
  });

  test("for a whole change (several files), the queue takes the union too", () => {
    const change = ["apps/ios/project.yml", "native/phone-core/Cargo.toml", "docs/moss-plan.md", "scripts/ci/lane", "services/push/src/index.ts"];
    const q = queueAreasFor(change);
    const old = legacyAreasFor(change) as Record<string, boolean>;
    for (const a of CI_AREA_NAMES) if (old[a] === true) expect(q[a], a).toBe(true);
  });

  test("the paths the new map stopped sending to a job still send them there in the queue: apps/ios, native/, scripts/ci, scripts/acceptance", () => {
    expect(areasFor(["apps/ios/project.yml"]).workspaces).toBe(false);
    expect(queueAreasFor(["apps/ios/project.yml"]).workspaces).toBe(true);
    expect(areasFor(["native/phone-core/src/lib.rs"]).workspaces).toBe(false);
    expect(queueAreasFor(["native/phone-core/src/lib.rs"]).workspaces).toBe(true);
    expect(areasFor(["scripts/ci/weston.sh"]).scriptsmac).toBe(false);
    expect(queueAreasFor(["scripts/ci/weston.sh"]).scriptsmac).toBe(true);
    expect(queueAreasFor(["scripts/acceptance/run.ts"]).scriptsmac).toBe(true);
  });

  test("no diff to go on is every area, as it always was", () => {
    expect(CI_AREA_NAMES.filter((a) => queueAreasFor(undefined)[a])).toEqual([...CI_AREA_NAMES]);
  });
});
