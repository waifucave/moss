// The engine's session titles (sessions/session-titles.ts) against the SessionTitles conformance suite, and what the
// engine adds: one try in flight per session, a titler that hangs never blocks another session.
import { describe, expect, test } from "bun:test";
import { runSessionTitlesConformance } from "../../contracts/conformance/session-titles";
import { EngineSessionTitles } from "../session-titles";

runSessionTitlesConformance((titler, lightModelFor) => new EngineSessionTitles({ titler, lightModelFor }));

describe("EngineSessionTitles", () => {
  test("a turn that ends while the title is being made doesn't ask again", async () => {
    let asked = 0;
    let release!: (title: string) => void;
    const t = new EngineSessionTitles({ titler: () => { asked++; return new Promise((r) => { release = r; }); }, lightModelFor: () => "light" });
    const first = t.turnEnded({ session: "s_a", kind: "coding", firstMessage: "fix it" });
    await t.turnEnded({ session: "s_a", kind: "coding", firstMessage: "fix it" });
    expect(asked).toBe(1);
    release("Fix it");
    await first;
    expect(t.title("s_a")).toEqual({ title: "Fix it", by: "engine" });
  });

  test("a light-model lookup that throws is a failed try, never the turn's failure", async () => {
    const warned: string[] = [];
    const t = new EngineSessionTitles({ titler: async () => "x", lightModelFor: () => { throw new Error("no catalog"); }, warn: (l) => warned.push(l) });
    await t.turnEnded({ session: "s_a", kind: "coding", firstMessage: "fix it" });
    expect(t.title("s_a")).toBeUndefined();
    expect(warned.length).toBe(1);
    // Every later turn tries again, and says nothing more (titles turned off would say it at each turn).
    await t.turnEnded({ session: "s_a", kind: "coding", firstMessage: "fix it" });
    expect(warned.length).toBe(1);
  });

  test("an empty first message asks nothing", async () => {
    let asked = 0;
    const t = new EngineSessionTitles({ titler: async () => { asked++; return "x"; }, lightModelFor: () => "light" });
    await t.turnEnded({ session: "s_a", kind: "coding", firstMessage: "   " });
    await t.turnEnded({ session: "s_a", kind: "coding" });
    expect(asked).toBe(0);
  });
});
