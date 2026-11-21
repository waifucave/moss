// The SessionTitles conformance suite (spec revision 20, §9.5 "Titles"). `runSessionTitlesConformance(make)` registers
// every case against what `make` builds over the titler and light-model lookup it is given; `tests/session-titles.test.ts`
// runs it against FakeSessionTitles, and lane CG against the engine's.
import { describe, expect, test } from "bun:test";
import type { SessionTitles } from "../session-titles";

export type SessionTitlesFactory = (titler: (text: string, model: string) => Promise<string>, lightModelFor: (model: string | undefined) => string) => SessionTitles;

export function runSessionTitlesConformance(make: SessionTitlesFactory): void {
  describe("SessionTitles", () => {
    test("a code session is titled once, after its first turn, on its family's light model; a bot's conversation never", async () => {
      const asked: string[] = [];
      const t = make(async (text, model) => { asked.push(model); return `  Fix: ${text.slice(0, 10)}\nmore`; }, (m) => (m?.startsWith("anthropic/") ? "anthropic/claude-haiku-5" : "openai/gpt-6-mini"));
      const heard: string[] = [];
      t.watch((c) => heard.push(`${c.session}:${c.by}`));
      await t.turnEnded({ session: "s_a", kind: "coding", model: "anthropic/claude-opus-5-5", firstMessage: "the login page loops" });
      await t.turnEnded({ session: "s_a", kind: "coding", model: "anthropic/claude-opus-5-5", firstMessage: "the login page loops" });
      await t.turnEnded({ session: "s_c", kind: "agent", model: "openai/gpt-6", firstMessage: "write tests" });
      await t.turnEnded({ session: "s_moss", kind: "bot", firstMessage: "hello" });
      expect(t.title("s_a")).toEqual({ title: "Fix: the login", by: "engine" });
      expect(asked).toEqual(["anthropic/claude-haiku-5", "openai/gpt-6-mini"]);
      expect(t.title("s_moss")).toBeUndefined();
      expect(heard).toEqual(["s_a:engine", "s_c:engine"]);
    });

    test("the person's and a spawn's titles are never replaced by the engine; the person's rename wins over any", async () => {
      const t = make(async () => "Engine title", () => "light");
      t.set("s_a", "Spawned task", "spawn");
      await t.turnEnded({ session: "s_a", kind: "agent", firstMessage: "x" });
      expect(t.title("s_a")).toEqual({ title: "Spawned task", by: "spawn" });
      t.set("s_a", "Mine", "user");
      t.set("s_a", "Spawn again", "spawn");
      expect(t.title("s_a")).toEqual({ title: "Mine", by: "user" });
      t.set("s_b", "x".repeat(300), "user");
      expect(t.title("s_b")!.title.length).toBe(200);
    });

    test("a failed titler leaves it untitled; the next turn's end tries again", async () => {
      let fail = true;
      const t = make(async () => { if (fail) throw new Error("no model"); return "Second try"; }, () => "light");
      await t.turnEnded({ session: "s_a", kind: "coding", firstMessage: "x" });
      expect(t.title("s_a")).toBeUndefined();
      fail = false;
      await t.turnEnded({ session: "s_a", kind: "coding", firstMessage: "x" });
      expect(t.title("s_a")!.title).toBe("Second try");
    });
  });
}
