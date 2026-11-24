// Where a joiner (U+200D, U+200C) is real in a text: the one rule the device-name rule (core) and the sealed cards' pages (both apps) read.
import { describe, expect, test } from "bun:test";
import { isBlankChar, isJoinerChar, isVisibleChar, joinerBetweenVisible } from "../src/visible-text";

const ZWJ = "‍";
const ZWNJ = "‌";
/** Whether every joiner in `text` sits between two visible characters. */
const allOk = (text: string): boolean => {
  const chars = [...text];
  return chars.every((c, i) => !isJoinerChar(c) || joinerBetweenVisible(chars, i));
};

describe("a joiner is real only between two visible characters", () => {
  test("real texts: a family, a flag with a variation selector, a skin tone, Persian", () => {
    for (const t of [`\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}`, `\u{1F3F3}️${ZWJ}\u{1F308}`, `\u{1F469}\u{1F3FD}${ZWJ}\u{1F4BB}`, `می${ZWNJ}خواهم`]) expect(allOk(t)).toBe(true);
  });
  test("first, last, doubled, beside a blank, a format character or a mark that has nothing before it", () => {
    for (const t of [`${ZWJ}a`, `a${ZWJ}`, `a${ZWJ}${ZWJ}b`, `a${ZWJ}${ZWNJ}b`, `a ${ZWJ}b`, `a${ZWJ} b`, `a​${ZWJ}b`, `a${ZWJ}‎b`, `a${ZWJ}́b`, `́${ZWJ}b`, `a\n${ZWJ}b`]) expect(allOk(t)).toBe(false);
  });
  test("what shows: not a blank, a mark, a control or a format character", () => {
    expect([isVisibleChar("a"), isVisibleChar("\u{1F600}"), isVisibleChar(" "), isVisibleChar("́"), isVisibleChar("​"), isVisibleChar(ZWJ), isVisibleChar("ㅤ")]).toEqual([true, true, false, false, false, false, false]);
    expect([isBlankChar(" "), isBlankChar("a")]).toEqual([true, false]);
  });
});
