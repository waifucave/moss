// The one rule for a device's name (`devices/names.ts`): what passes, what is refused, and what an operating system's name is cleaned to.
import { describe, expect, test } from "bun:test";
import { cleanName, nameProblem, safeDeviceName } from "../names";

const ok = (name: string) => expect([name, cleanName(name)]).toEqual([name, true]);
const bad = (name: string) => expect([name, cleanName(name)]).toEqual([name, false]);

describe("cleanName: real names pass", () => {
  test("Latin with accents, an apostrophe (straight and curly), quotation marks, digits and punctuation", () => {
    for (const name of ["Studio", "Zoé's iPhone", "Someone’s MacBook Pro", "Sam's phone", "Sam''s phone", "MacBook \"Pro\"", "“Work” laptop", "Kitchen »iPad«", "Dad's Mac mini (2) - M4", "x".repeat(63)]) ok(name);
  });
  test("CJK, Thai, Arabic, Hebrew, Cyrillic, Devanagari", () => {
    for (const name of [
      "田中さんのパソコン", "한국어 노트북", "โทรศัพท์ของฉัน",
      "حاسوب محمد", "مُحَمَّد", "המחשב של דני",
      "Ноутбук Маши", "मेरा लैपटॉप",
    ]) ok(name);
  });
  test("a Persian name with ZERO WIDTH NON-JOINER between letters", () => {
    ok("می‌خواهم");
    ok("لپ‌تاپ من");
  });
  test("emoji: a ZERO WIDTH JOINER sequence, a variation selector, skin tones, a regional-indicator flag, a rainbow flag, a keycap", () => {
    ok("MacBook \u{1F468}‍\u{1F469}‍\u{1F467}");
    ok("Pixel \u{1F4F1}");
    ok("❤️‍\u{1F525} phone");
    ok("\u{1F3F3}️‍\u{1F308} laptop");
    ok("\u{1F469}\u{1F3FD}‍\u{1F4BB}'s Mac");
    ok("\u{1F44B}\u{1F3FF} hello");
    ok("\u{1F1EB}\u{1F1F7} Paris Mac");
    ok("1️⃣ first");
  });
  test("a few accents on one letter (up to four)", () => {
    ok("é̂̃̄");
  });
});

describe("cleanName: what is refused", () => {
  test("empty, too long, blanks only, no visible character", () => {
    for (const name of ["", "x".repeat(64), " ", "   ", " 　", "ㅤ", "ㅤㅤᅟ", "ﾠ", "⠀", " ̋", "̋"]) bad(name);
  });
  test("control characters, line and paragraph separators", () => {
    for (const name of ["a\nb", "a\tb", "a\u0000b", "a\u0007b", "a\u007Fb", "a\u0085b", "a b", "a b"]) bad(name);
  });
  test("every format character: bidi marks, overrides and isolates, zero-width, soft hyphen, word joiner, BOM, the interlinear marks, U+180E, the tag block", () => {
    for (const name of ["a‎b", "a‏b", "a؜b", "a‪b", "a‮b", "a⁦b", "a⁩b", "a​b", "a­b", "a⁠b", "a﻿b", "a￹b", "a￺b", "a￻b", "a᠎b", "a\u{E0001}b", "a\u{E0020}b", "a\u{E007F}b", "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}"]) bad(name);
  });
  test("the fillers that draw as blanks, in the middle of a name too", () => {
    for (const name of ["aㅤb", "aᅟb", "aᅠb", "aﾠb", "a឴b", "a⠀b"]) bad(name);
  });
  test("lone surrogates", () => {
    for (const name of ["a\uD800b", "\uDC00"]) bad(name);
  });
  test("marks: none with no base, none on a blank, and no more than four on one character", () => {
    for (const name of ["́Pixel", "a ́b", "é̂̃̄̅", "x" + "́".repeat(30)]) bad(name);
  });
  test("a joiner or non-joiner: never first, last, doubled, beside a blank or another format character, or with a mark after it", () => {
    for (const name of [
      "‍ab", "ab‍", "‌ab", "ab‌", "a‍‍b", "a‌‌b", "a‍‌b", "a ‍b", "a‍ b", "a‍‎b", "a‎‍b", "a‍́b",
      "‍", "‌",
    ]) bad(name);
  });
});

describe("nameProblem says why, in plain words", () => {
  test("each refusal reads as a sentence about the name", () => {
    expect(nameProblem("ok")).toBeNull();
    expect(nameProblem("")).toMatch(/^a device's name can't be empty/);
    expect(nameProblem("x".repeat(64))).toMatch(/at most 63 characters/);
    expect(nameProblem("a‮b")).toMatch(/control, invisible or direction-changing/);
    expect(nameProblem("ㅤ")).toMatch(/control, invisible or direction-changing/);
    expect(nameProblem("   ")).toMatch(/needs something that shows/);
    expect(nameProblem("́a")).toMatch(/accent/);
    expect(nameProblem("á̂̃̄̅")).toMatch(/more than 4 accents/);
    expect(nameProblem("a‍")).toMatch(/joiner/);
    expect(nameProblem(42 as unknown as string)).toMatch(/empty/);
  });
});

describe("safeDeviceName: what the operating system gives is cleaned, never refused", () => {
  test("a name that already passes is kept as it is", () => {
    for (const name of ["Studio", "Zoé's iPhone", "MacBook \"Pro\"", "\u{1F468}‍\u{1F469}"]) expect(safeDeviceName(name)).toBe(name === "\u{1F468}‍\u{1F469}" ? "\u{1F468}\u{1F469}" : name);
  });
  test("what is refused is left out, blanks collapse, the result is cut at 63 units and always passes the rule", () => {
    expect(safeDeviceName("Pi​xe‮l")).toBe("Pixel");
    expect(safeDeviceName("  a ㅤ  b  ")).toBe("a b");
    expect(safeDeviceName("tab\there")).toBe("tabhere");
    expect(safeDeviceName("́e" + "́".repeat(9))).toBe("é́́́");
    expect(safeDeviceName("x".repeat(100))).toBe("x".repeat(63));
    expect(safeDeviceName("\u{1F4F1}".repeat(40))).toBe("\u{1F4F1}".repeat(31));
    for (const name of ["ㅤᅟ", "‮", "", " ", "́̂"]) expect(safeDeviceName(name)).toBe("Computer");
    expect(safeDeviceName("ㅤ", "This computer")).toBe("This computer");
    for (const raw of ["a\uD800b", "Pi​xe‮l", "\u{E0041}\u{E0042}x", "xㅤ".repeat(50), "́".repeat(80) + "ab"]) expect(cleanName(safeDeviceName(raw))).toBe(true);
  });
});
