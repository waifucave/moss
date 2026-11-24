// A deleted bot's saved rules (the deletion lane, item 4): they go with it, so a bot made later with the same id starts
// with none; another bot's stay. (The daemon calls `forgetBot` on the bot side's `bot_deleted`.)
import { describe, expect, test } from "bun:test";
import { MossApprovalBroker, type StoredRule } from "../../approvals/broker";
import { FakeClock } from "../../contracts/fakes/clock";

describe("a deleted bot's saved rules", () => {
  test("forgetBot takes every rule saved for that bot, writes the file, and leaves the others", () => {
    const rules: StoredRule[] = [
      { keyHash: "k1", display: "Bash(ls)", computers: ["Studio"], cardId: "card_aaaaaa1", savedAt: 1, bot: "nova" },
      { keyHash: "k2", display: "tool:Export", computers: ["Studio"], cardId: "card_aaaaaa2", savedAt: 2, bot: "nova" },
      { keyHash: "k1", display: "Bash(ls)", computers: ["Studio"], cardId: "card_aaaaaa3", savedAt: 3, bot: "orbit" },
    ];
    const saved: StoredRule[][] = [];
    const broker = new MossApprovalBroker({ clock: new FakeClock(), levels: () => "ask-for-risky-actions", fence: () => undefined, rules: { load: () => rules.map((r) => ({ ...r })), save: (r: StoredRule[]) => void saved.push(r.map((x) => ({ ...x }))) }, localComputer: "Studio" } as never);
    expect(broker.forgetBot("nova")).toBe(2);
    expect(broker.savedFor("k1")).toEqual([{ bot: "orbit", computers: ["Studio"] }]);
    expect(broker.savedFor("k2")).toEqual([]);
    expect(saved.at(-1)?.map((r) => r.bot)).toEqual(["orbit"]);
    expect(broker.forgetBot("nova")).toBe(0);
  });
});
