// The real AgentStartOptions: the contract's conformance suite (in memory), then the file the engine keeps (written whole,
// private, read back after a restart; a bad, old or foreign file is "nothing yet").
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentStartOptionsConformance } from "../../contracts/conformance/agent-start";
import { EngineAgentStartOptions, FileRecentStore, MemoryRecentStore } from "../start-options";

runAgentStartOptionsConformance((backends, catalog) => new EngineAgentStartOptions({ source: (b) => backends[b], catalog: () => catalog, store: new MemoryRecentStore() }));

describe("the person's last start, kept in a file", () => {
  const home = mkdtempSync(join(tmpdir(), "moss-recent-"));
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  const make = () => new EngineAgentStartOptions({ source: () => ({ from: "unknown" }), catalog: () => ({ models: [] }), store: FileRecentStore.in(home) });

  test("nothing yet with no file; a start is kept for the next engine; the file is private", () => {
    expect(make().recent()).toEqual({ roots: [] });
    make().remember({ backend: "codex", computer: "Studio", root: "home/Studio/app", model: "gpt-6", effort: "high" }, 5);
    expect(make().recent()).toEqual({ backend: "codex", computer: "Studio", model: "gpt-6", effort: "high", roots: [{ root: "home/Studio/app", at: 5 }] });
    const file = join(home, "run", "agents", "recent-start.json");
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8")).roots).toHaveLength(1);
  });

  test("a malformed, too-long or foreign file is nothing yet, never an error", () => {
    const file = join(home, "run", "agents", "recent-start.json");
    for (const bad of ["not json", "[]", '{"roots":"x"}', JSON.stringify({ roots: Array.from({ length: 50 }, (_, i) => ({ root: `home/S/p${i}`, at: i })) }), '{"roots":[{"root":"/etc/passwd","at":1}]}']) {
      writeFileSync(file, bad);
      expect(make().recent()).toEqual({ roots: [] });
    }
    // …and the next start writes a good file over it.
    make().remember({ backend: "codex", computer: "Studio", root: "home/Studio/x" }, 9);
    expect(make().recent().roots).toEqual([{ root: "home/Studio/x", at: 9 }]);
  });

  test("a home that can't be written never fails the start", () => {
    mkdirSync(join(home, "ro"), { recursive: true });
    writeFileSync(join(home, "ro", "run"), "a file where the folder should be");
    const o = new EngineAgentStartOptions({ source: () => undefined, catalog: () => ({ models: [] }), store: FileRecentStore.in(join(home, "ro")) });
    expect(() => o.remember({ backend: "codex", computer: "S", root: "home/S/a" }, 1)).not.toThrow();
    expect(o.recent().roots).toEqual([{ root: "home/S/a", at: 1 }]);
  });
});
