// A card's boxes as the windows draw and answer them: the iPhone's rules (`drawnWhole`, `cutFields`) kept once for both
// desktop apps.
import { describe, expect, test } from "bun:test";
import { CHILDREN_CUT_ITEMS, checkTicks, childLine, drawChildren, oneLine } from "../src/card-children";

const kid = (id: string, label: unknown = id, checked = true) => ({ id, label, checked });

describe("a label as one line", () => {
  test("every kind of line break shows as a visible ⏎, so a label can't draw a second box", () => {
    expect(oneLine("Calendar\n☐ Send email as you")).toBe("Calendar ⏎ ☐ Send email as you");
    for (const br of ["\r\n", "\r", "\v", "\f", "\u0085", " ", " "]) expect(oneLine(`a${br}b`)).toBe("a ⏎ b");
    expect(childLine("a‮b\nc")).toBe("aU+202Eb ⏎ c");
  });
  test("a protocol Text is read by its English line; one with none has no words", () => {
    expect(childLine({ en: "Mail" })).toBe("Mail");
    expect(drawChildren([kid("a", { fr: "Courrier" })])).toMatchObject({ drawn: false });
  });
});

describe("what is drawn", () => {
  test("no boxes is nothing to draw; boxes keep the engine's own ticks and their order", () => {
    expect(drawChildren(undefined)).toEqual({ drawn: true, children: [], cut: false });
    expect(drawChildren([kid("a", "A", true), kid("b", "B", false)])).toEqual({ drawn: true, children: [{ id: "a", line: "A", checked: true }, { id: "b", line: "B", checked: false }], cut: false });
  });
  test("more than the cut count is a cut list", () => {
    const n = (k: number) => Array.from({ length: k }, (_, i) => kid(`k${i}`, `Box ${i}`));
    expect(drawChildren(n(CHILDREN_CUT_ITEMS))).toMatchObject({ drawn: true, cut: false });
    expect(drawChildren(n(CHILDREN_CUT_ITEMS + 1))).toMatchObject({ drawn: true, cut: true });
  });
  test("repeated ids, repeated labels (also once one-lined), a box with no label or no id: not drawn", () => {
    expect(drawChildren([kid("a", "A"), kid("a", "B")])).toMatchObject({ drawn: false });
    expect(drawChildren([kid("a", "Same"), kid("b", "Same")])).toMatchObject({ drawn: false });
    expect(drawChildren([kid("a", "x\ny"), kid("b", "x\ry")])).toMatchObject({ drawn: false });
    expect(drawChildren([kid("a", ""), kid("b", "B")])).toMatchObject({ drawn: false });
    expect(drawChildren([kid("a", " \n "), kid("b", "B")])).toMatchObject({ drawn: false });
    expect(drawChildren([kid("", "A")])).toMatchObject({ drawn: false });
    expect(drawChildren("nope")).toMatchObject({ drawn: false });
  });
});

describe("the ticks that are signed", () => {
  const card = [kid("a"), kid("b"), kid("c")];
  test("an approve names only boxes the card carries, each once; a deny carries none", () => {
    expect(checkTicks(card, "approve", ["a", "c"])).toEqual({ ok: true, ticks: ["a", "c"] });
    expect(checkTicks(card, "approve", [])).toEqual({ ok: true, ticks: [] });
    expect(checkTicks(card, "approve", undefined)).toEqual({ ok: true });
    expect(checkTicks(card, "approve", ["z"])).toMatchObject({ ok: false });
    expect(checkTicks(card, "approve", ["a", "a"])).toMatchObject({ ok: false });
    expect(checkTicks(card, "deny", ["a"])).toEqual({ ok: true });
    expect(checkTicks(undefined, "approve", ["a"])).toMatchObject({ ok: false });
  });
  test("a card whose boxes can't be drawn can be denied but never approved", () => {
    const bad = [kid("a", "Same"), kid("b", "Same")];
    expect(checkTicks(bad, "approve", ["a"])).toMatchObject({ ok: false });
    expect(checkTicks(bad, "approve", undefined)).toMatchObject({ ok: false });
    expect(checkTicks(bad, "deny", undefined)).toEqual({ ok: true });
  });
});
