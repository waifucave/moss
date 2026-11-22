import { describe, expect, test } from "bun:test";
import { cardTitle, chooseCard, chooseOption, placeWords, type CardRow } from "./cards-lib";

const card = (id: string, session?: string, extra: Partial<CardRow> = {}): CardRow => ({
  id, hash: "h", ...(session !== undefined ? { session } : {}), fields: { title: { type: "text", text: "Start an agent without a sandbox?" } },
  options: [{ id: "always", kind: "approve", remember: "always" }, { id: "yes", kind: "approve" }, { id: "no", kind: "deny" }], ...extra,
});

describe("which card a command means", () => {
  const cards = [card("c1", "s1"), card("c2", "s2"), card("c3", "s2")];
  test("by id; an unknown id is an error and never another card", () => {
    expect(chooseCard(cards, { id: "c2" })).toMatchObject({ card: { id: "c2" } });
    expect(chooseCard(cards, { id: "nope" })).toMatchObject({ error: expect.stringContaining("no pending card nope") });
  });
  test("by session only when that session has exactly one card", () => {
    expect(chooseCard(cards, { session: "s1" })).toMatchObject({ card: { id: "c1" } });
    expect(chooseCard(cards, { session: "s2" })).toMatchObject({ error: expect.stringContaining("c2, c3") });
    expect(chooseCard(cards, { session: "s9" })).toMatchObject({ error: expect.stringContaining("no pending card") });
  });
  test("never without naming a card", () => {
    expect(chooseCard(cards, {})).toMatchObject({ error: expect.stringContaining("name the card") });
    expect(chooseCard([card("only")], {})).toHaveProperty("error");
  });
  test("an answer takes the plain option, never a saved always-rule", () => {
    expect(chooseOption(card("c"), false)?.id).toBe("yes");
    expect(chooseOption(card("c"), true)?.id).toBe("no");
    expect(chooseOption(card("c", undefined, { options: [{ id: "always", kind: "approve", remember: "always" }] }), false)).toBeUndefined();
  });
});

describe("what a card is called and where it is", () => {
  test("title, else what, else kind", () => {
    expect(cardTitle(card("c"))).toBe("Start an agent without a sandbox?");
    expect(cardTitle(card("c", undefined, { fields: { what: { type: "text", text: "Run  a\ncommand" } } }))).toBe("Run a command");
    expect(cardTitle(card("c", undefined, { fields: {}, kind: "tool" }))).toBe("tool");
  });
  test("placement in words", () => {
    expect(placeWords({ kind: "conversation", program: "code", window: "main" })).toContain("conversation");
    expect(placeWords({ kind: "island" })).toContain("has none");
    expect(placeWords(undefined)).toBe("not placed yet");
    expect(placeWords({ kind: "elsewhere" })).toContain("nowhere");
  });
});
