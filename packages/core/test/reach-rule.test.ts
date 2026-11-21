// The one rule, read once (spec revision 20, §9.5): the protocol's `reachRefusal` answers for a bot's session exactly what
// today's `sendMessageRefusal` (bots/tools.ts) answers, so lane CM can make the bots' tool delegate to it unchanged.
import { describe, expect, test } from "bun:test";
import { reachRefusal, type SessionKind } from "@waifucave/moss-protocol";
import { sendMessageRefusal } from "../src/bots/tools";

describe("reachRefusal's bot branch is today's one rule", () => {
  test("every pair of a bot's session and a target", () => {
    const kinds: SessionKind[] = ["bot", "side-thread", "agent", "coding"];
    const targets = kinds.flatMap((kind) => [undefined, "moss", "luna"].map((bot) => ({ id: `t_${kind}_${bot ?? "none"}`, kind, ...(bot !== undefined ? { bot } : {}) })));
    for (const t of [...targets, { id: "s_self", kind: "bot" as const, bot: "moss" }]) {
      expect([t.id, reachRefusal({ id: "s_self", bot: "moss" }, t)]).toEqual([t.id, sendMessageRefusal({ sessionId: "s_self", bot: "moss" }, t)]);
    }
  });
});
