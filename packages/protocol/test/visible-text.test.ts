// Where a joiner (U+200D, U+200C) is real in a text: the one rule the device-name rule (core) and the sealed cards' pages (both apps) read.
import { describe, expect, test } from "bun:test";
import { isBlankChar, isJoinerChar, isVisibleChar, joinerBetweenVisible, joinerInName, sealedEscape, UNSHOWN_CHAR } from "../src/visible-text";

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

describe("in a human name a joiner is real only between two visible non-ASCII characters", () => {
  const inName = (text: string): boolean => {
    const chars = [...text];
    return chars.every((c, i) => !isJoinerChar(c) || joinerInName(chars, i));
  };
  test("an emoji sequence, a flag, a skin tone, Persian and Devanagari", () => {
    for (const t of [`\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}`, `\u{1F3F3}\uFE0F${ZWJ}\u{1F308}`, `\u{1F469}\u{1F3FD}${ZWJ}\u{1F4BB}`, `\u0645\u06CC${ZWNJ}\u062E\u0648\u0627\u0647\u0645`, `\u0915\u094D${ZWJ}\u0937`]) expect(inName(t)).toBe(true);
  });
  test("beside an ASCII character (a letter, a digit, a dot), or where it is not between two visible characters at all, it is not", () => {
    for (const t of [`a${ZWJ}b`, `exam${ZWNJ}ple.com`, `1${ZWJ}2`, `a${ZWJ}\u{1F469}`, `\u{1F469}${ZWJ}b`, `\u0645${ZWNJ}x`, `${ZWJ}\u{1F469}`, `\u{1F469}${ZWJ}`, `\u{1F469}${ZWJ}${ZWJ}\u{1F467}`, `\u{1F469} ${ZWJ}\u{1F467}`]) expect(inName(t)).toBe(false);
  });
});

describe("sealedEscape: one rule for every sealed value", () => {
  const hex = (cp: number) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
  test("every code point the set holds is drawn as its escape (tab, line feed and carriage return stay), and nothing else is touched", () => {
    let held = 0;
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      const ch = String.fromCodePoint(cp);
      const out = sealedEscape(`a${ch}b`);
      if (UNSHOWN_CHAR.test(ch) && cp !== 9 && cp !== 10 && cp !== 13) {
        held++;
        if (out !== `a${hex(cp)}b`) throw new Error(`${hex(cp)} drew as ${JSON.stringify(out)}`);
      } else if (out !== `a${ch}b`) throw new Error(`${hex(cp)} was changed to ${JSON.stringify(out)}`);
    }
    expect(held).toBeGreaterThan(600);
  });
  test("the characters the reviewer named all escape: invisible operators, shorthand format controls, hieroglyph controls, fillers, the grapheme joiner", () => {
    const named = [0x2061, 0x2062, 0x2063, 0x2064, 0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, ...Array.from({ length: 8 }, (_, i) => 0x1d173 + i), ...Array.from({ length: 16 }, (_, i) => 0x13430 + i), 0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0x17b4, 0x17b5, 0x34f, 0xad, 0x2060, 0x180e, 0xfff9, 0xfffa, 0xfffb, 0xe0000, 0xe0041, 0xe007f];
    for (const cp of named) expect(sealedEscape(`x${String.fromCodePoint(cp)}y`)).toBe(`x${hex(cp)}y`);
  });
  test("a path and a command do not read as another one", () => {
    expect(sealedEscape("/Users/me/safe\u2064dir")).toBe("/Users/me/safeU+2064dir");
    expect(sealedEscape("rm \u3164-rf ~/x")).toBe("rm U+3164-rf ~/x");
    expect(sealedEscape("line one\n\tline two\r\n")).toBe("line one\n\tline two\r\n");
  });
  test("a joiner stays as written only in a name, between two non-ASCII characters; the rest of a name escapes as everywhere", () => {
    const family = "MacBook \u{1F468}\u200D\u{1F469}";
    expect(sealedEscape(family, true)).toBe(family);
    expect(sealedEscape(family)).toBe("MacBook \u{1F468}U+200D\u{1F469}");
    expect(sealedEscape("a\u200Db\u2064", true)).toBe("aU+200DbU+2064");
    expect(sealedEscape("Hebrew \u05E9\u05DC\u05D5\u05DD \u2014 \u201Cquoted\u201D \u2026")).toBe("Hebrew \u05E9\u05DC\u05D5\u05DD \u2014 \u201Cquoted\u201D \u2026");
  });
});
