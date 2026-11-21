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

describe("a title is one line of plain text", () => {
  const made = async (answer: string) => {
    const t = new EngineSessionTitles({ titler: async () => answer, lightModelFor: () => "light" });
    await t.turnEnded({ session: "s_a", kind: "coding", firstMessage: "go" });
    return t.title("s_a")?.title;
  };

  test("an ESC sequence, a right-to-left override, zero-width characters and angle brackets are dropped", async () => {
    expect(await made("\u001b[31mFix\u001b[0m the login")).toBe("Fix the login");
    expect(await made("\u001b]0;pwned\u0007Fix the login")).toBe("Fix the login");
    expect(await made("Fix ‮txt.exe‬ login")).toBe("Fix txt.exe login");
    expect(await made("Fix​ the⁦ login⁩")).toBe("Fix the login");
    expect(await made("<script>alert(1)</script> Fix")).toBe("script alert(1) /script Fix");
    expect(await made("Fix\tthe    login")).toBe("Fix the login");
  });

  test("a 500-character answer is cut at 60; a multi-line answer keeps its first line; nothing left is no title", async () => {
    expect((await made("a".repeat(500)))!.length).toBe(60);
    expect(await made("\n\n  Fix the login loop\nIt loops because…\n")).toBe("Fix the login loop");
    expect(await made("Fix the second line")).toBe("Fix");
    expect(await made("\u001b‮​")).toBeUndefined();
    expect(await made("   \n  ")).toBeUndefined();
  });

  test("the person's and a spawn's titles are cleaned the same way, at the contract's 200", () => {
    const t = new EngineSessionTitles({ titler: async () => "x", lightModelFor: () => "light" });
    t.set("s_a", "Mine‮ reversed", "user");
    expect(t.title("s_a")!.title).toBe("Mine reversed");
    t.set("s_b", "y".repeat(300), "spawn");
    expect(t.title("s_b")!.title.length).toBe(200);
  });
});
