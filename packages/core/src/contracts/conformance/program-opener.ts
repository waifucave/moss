// The ProgramOpener conformance suite (spec revision 20, §9.5). `runProgramOpenerConformance(make)` registers every case
// against the opener `make` builds over the world it is given; `tests/program-opener.test.ts` runs it against
// FakeProgramOpener, and lane CA against the engine's `app.openIn`.
import { describe, expect, test } from "bun:test";
import type { AppShowWhat, WindowProgram } from "@waifucave/moss-protocol";
import type { ProgramOpener, ProgramOpenerWorld } from "../program-opener";

export type ProgramOpenerFactory = (world: ProgramOpenerWorld) => ProgramOpener;

function world(running: WindowProgram[], startWorks = true) {
  const up = new Set(running);
  const shown: string[] = [];
  const starts: string[] = [];
  const w: ProgramOpenerWorld = {
    connected: (p) => up.has(p),
    show: async (p, what) => void shown.push(`${p}:${JSON.stringify(what)}`),
    start: async (p) => { starts.push(p); if (startWorks) up.add(p); return startWorks; },
  };
  return { w, shown, starts };
}

const bot: AppShowWhat = { kind: "bot", bot: "moss" };

export function runProgramOpenerConformance(make: ProgramOpenerFactory): void {
  describe("ProgramOpener", () => {
    test("Open in MOSS: a running MOSS gets app.show once; one not running is started first", async () => {
      const a = world(["code", "moss"]);
      expect(await make(a.w).openIn("code", "moss", bot)).toEqual({ opened: true, started: false });
      expect([a.shown, a.starts]).toEqual([['moss:{"kind":"bot","bot":"moss"}'], []]);
      const b = world(["code"]);
      expect(await make(b.w).openIn("code", "moss", bot)).toEqual({ opened: true, started: true });
      expect([b.shown.length, b.starts]).toEqual([1, ["moss"]]);
    });

    test("only a place that program opens, never the caller's own program; a start that fails is refused", async () => {
      const a = world(["code", "moss"]);
      const o = make(a.w);
      expect((await o.openIn("code", "moss", { kind: "session", session: "s_a" })).opened).toBe(false);
      expect((await o.openIn("moss", "code", bot)).opened).toBe(false);
      expect((await o.openIn("moss", "code", { kind: "session", session: "s_a" })).opened).toBe(true);
      expect((await o.openIn("code", "code", { kind: "session", session: "s_a" })).opened).toBe(false);
      const b = world(["code"], false);
      expect((await make(b.w).openIn("code", "moss", bot)).opened).toBe(false);
      expect(b.shown).toEqual([]);
    });
  });
}
