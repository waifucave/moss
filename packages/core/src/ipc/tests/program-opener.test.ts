// The real ProgramOpener: the contract's conformance suite, then what the real one adds (one start for two presses, a
// window that refuses the place, a start that throws).
import { describe, expect, test } from "bun:test";
import { runProgramOpenerConformance } from "../../contracts/conformance/program-opener";
import type { ProgramOpenerWorld } from "../../contracts/program-opener";
import { EngineProgramOpener } from "../program-opener";

runProgramOpenerConformance((world) => new EngineProgramOpener(world));

describe("EngineProgramOpener", () => {
  test("two presses while MOSS starts wait for one start, and each place is shown once", async () => {
    let up = false;
    let starts = 0;
    const shown: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const world: ProgramOpenerWorld = {
      connected: () => up,
      show: async (_p, what) => void shown.push(JSON.stringify(what)),
      start: async () => { starts++; await gate; up = true; return true; },
    };
    const o = new EngineProgramOpener(world);
    const a = o.openIn("code", "moss", { kind: "bot", bot: "a" });
    const b = o.openIn("code", "moss", { kind: "bot", bot: "b" });
    release();
    expect(await Promise.all([a, b])).toEqual([{ opened: true, started: true }, { opened: true, started: true }]);
    expect([starts, shown.sort()]).toEqual([1, ['{"kind":"bot","bot":"a"}', '{"kind":"bot","bot":"b"}']]);
    // After it is up a press starts nothing.
    expect(await o.openIn("code", "moss", { kind: "window" })).toEqual({ opened: true, started: false });
    expect(starts).toBe(1);
  });

  test("only an own program is a place: constructor, toString and __proto__ are refused with words, never a throw", async () => {
    const world: ProgramOpenerWorld = { connected: () => true, show: async () => undefined, start: async () => true };
    const opener = new EngineProgramOpener(world);
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(await opener.openIn("code", name as never, { kind: "window" } as never)).toEqual({ opened: false, refused: "That isn't a program with a window." });
    }
  });

  test("a window that refuses the place, or a start that throws, is a refusal with words, never a throw", async () => {
    const refusing: ProgramOpenerWorld = { connected: () => true, show: async () => { throw new Error("MOSS has no bot named zed."); }, start: async () => true };
    expect(await new EngineProgramOpener(refusing).openIn("code", "moss", { kind: "bot", bot: "zed" })).toEqual({ opened: false, refused: "MOSS has no bot named zed." });
    const broken: ProgramOpenerWorld = { connected: () => false, show: async () => undefined, start: async () => { throw new Error("no"); } };
    expect(await new EngineProgramOpener(broken).openIn("code", "moss", { kind: "window" })).toMatchObject({ opened: false });
    // The host is no program here: the schema has no such value; a made-up one is refused by the place table.
    expect(await new EngineProgramOpener(refusing).openIn("code", "host" as never, { kind: "window" })).toMatchObject({ opened: false });
  });
});
