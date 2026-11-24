// A sealed card draws a joiner (U+200D, U+200C) as it was written only between two visible characters (the rule a device's name is held to,
// `joinerBetweenVisible` in the protocol); anywhere else it is a visible escape, like every other format and control character. A row's value is
// isolated for direction. The names are the ones the add card shows (`devices/rpc.ts`, `askToAdd`): real ones must look right, hostile ones must not.
import { describe, expect, test } from "bun:test";
import { fieldPage, ownCardPage, previewHtml, sealedEscape } from "../src/main/sealed-pages";
import type { CardSummary } from "../src/main/card-summary";

const ZWJ = "‍";
const ZWNJ = "‌";
const TOKEN = "se_001abcdef";

/** Names a person really gives a device: each must come through unchanged. */
const REAL_NAMES = [
  `MacBook \u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}`, // a family emoji
  `\u{1F3F3}️${ZWJ}\u{1F308}`, // a flag with a variation selector before the joiner
  `\u{1F469}\u{1F3FD}${ZWJ}\u{1F4BB}`, // a skin-tone modifier before the joiner
  `می${ZWNJ}خواهم`, // Persian "می‌خواهم"
  `مک‌بک من`, // Persian, joiner then a blank later
  "MacBook Pro", // no joiner at all
];
/** Names the name rule refuses (names.test.ts); on a card each joiner in them shows as its escape and the rest stays as it was written. */
const HOSTILE: readonly (readonly [string, string])[] = [
  [`${ZWJ}ab`, "U+200Dab"],
  [`ab${ZWJ}`, "abU+200D"],
  [`${ZWNJ}ab`, "U+200Cab"],
  [`ab${ZWNJ}`, "abU+200C"],
  [`a${ZWJ}${ZWJ}b`, "aU+200DU+200Db"],
  [`a${ZWNJ}${ZWNJ}b`, "aU+200CU+200Cb"],
  [`a${ZWJ}${ZWNJ}b`, "aU+200DU+200Cb"],
  [`a ${ZWJ}b`, "a U+200Db"],
  [`a${ZWJ} b`, "aU+200D b"],
  [`a${ZWJ}‎b`, "aU+200DU+200Eb"],
  [`a‎${ZWJ}b`, "aU+200EU+200Db"],
  [`a${ZWJ}́b`, "aU+200D́b"], // a mark after the joiner has nothing to sit on
  [ZWJ, "U+200D"],
  [ZWNJ, "U+200C"],
  [`a${ZWJ}​b`, "aU+200DU+200Bb"],
  [`a﻿${ZWNJ}b`, "aU+FEFFU+200Cb"],
  [`a\n${ZWJ}b`, "a\nU+200Db"],
  [`aㅤ${ZWJ}b`, "aㅤU+200Db"], // a filler that draws as a blank
];

describe("sealedEscape and the joiners", () => {
  test("a real name comes through as written", () => {
    for (const name of REAL_NAMES) expect(sealedEscape(name)).toBe(name);
  });
  test("a joiner that is not between two visible characters is an escape; the characters around it are as they were", () => {
    for (const [name, shown] of HOSTILE) expect(sealedEscape(name)).toBe(shown);
  });
  test("every other format and control character stays an escape, whatever it sits beside", () => {
    expect(sealedEscape("a​b")).toBe("aU+200Bb");
    expect(sealedEscape("a﻿b")).toBe("aU+FEFFb");
    expect(sealedEscape("a‎b")).toBe("aU+200Eb");
    expect(sealedEscape("a‮b")).toBe("aU+202Eb");
    expect(sealedEscape("a⁦b")).toBe("aU+2066b");
    expect(sealedEscape("a\u0007b")).toBe("aU+0007b");
    // Between two visible characters a joiner is let through; the zero-width space beside it is not.
    expect(sealedEscape(`a${ZWJ}​b`)).toBe("aU+200DU+200Bb");
    expect(sealedEscape(`a​${ZWNJ}b`)).toBe("aU+200BU+200Cb");
  });
  test("a lone surrogate beside a joiner is not a visible character", () => {
    expect(sealedEscape(`a${ZWJ}\uD800`)).toContain("U+200D");
    expect(sealedEscape(`\uDC00${ZWNJ}b`)).toContain("U+200C");
  });
});

describe("a row's value is isolated for direction", () => {
  const rows = (value: string) => ({ type: "rows" as const, rows: [{ label: "name", value }] });
  test("the field page puts each value in its own isolate, the name's joiners kept and a hostile name's escaped", () => {
    for (const name of REAL_NAMES) {
      const html = fieldPage({ cardId: "card_x", token: TOKEN, field: "detail", value: rows(name) });
      expect(html).toContain(`<dt>name</dt><dd><bdi>${name}</bdi></dd>`);
      expect(html).not.toContain("U+200");
    }
    const hostile = fieldPage({ cardId: "card_x", token: TOKEN, field: "detail", value: rows(`a${ZWJ}${ZWJ}b`) });
    expect(hostile).toContain("<dd><bdi>aU+200DU+200Db</bdi></dd>");
  });
  test("a right-to-left name stays inside its isolate: the label is outside it, and a bidi override in it is an escape", () => {
    const html = fieldPage({ cardId: "card_x", token: TOKEN, field: "detail", value: rows("שלום‮") });
    expect(html).toContain("<dt>name</dt><dd><bdi>שלום" + "U+202E</bdi></dd>");
  });
  test("a value with markup is escaped inside the isolate", () => {
    const html = fieldPage({ cardId: "card_x", token: TOKEN, field: "detail", value: rows("</bdi><b>x</b>") });
    expect(html).toContain("<dd><bdi>&lt;/bdi&gt;&lt;b&gt;x&lt;/b&gt;</bdi></dd>");
  });
  test("the card's own page and the preview isolate the value the same way", () => {
    const options = [{ id: "approve", kind: "approve" as const, label: "Approve" }, { id: "deny", kind: "deny" as const, label: "Deny" }];
    for (const name of REAL_NAMES) {
      const page = ownCardPage({ cardId: "card_x", token: "se_1", origin: "user", issuedAt: 0, expiresAt: null, fields: { title: { type: "text", text: "Add a device?" }, detail: rows(name) }, options });
      expect(page).toContain(`<dt>name</dt><dd><bdi>${name}</bdi></dd>`);
      const summary = { preview: { kind: "rows", rows: [{ label: "name", value: name }], hidden: 0 }, shortened: false } as unknown as CardSummary;
      expect(previewHtml(summary)).toContain(`<span class="k">name</span><span class="v"><bdi>${name}</bdi></span>`);
    }
    const bad = previewHtml({ preview: { kind: "rows", rows: [{ label: "name", value: `a${ZWNJ}` }], hidden: 0 }, shortened: false } as unknown as CardSummary);
    expect(bad).toContain('<span class="v"><bdi>aU+200C</bdi></span>');
  });
});
