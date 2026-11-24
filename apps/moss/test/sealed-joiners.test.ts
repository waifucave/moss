// A sealed card draws a joiner (U+200D, U+200C) as it was written ONLY in a value its builder marked as a human name (a row's `name: true`) and
// only between two visible non-ASCII characters (`joinerInName` in the protocol); in every other value, and anywhere else in a name, it is a
// visible escape, like every other format and control character (spec 5.5). A row's value is isolated for direction. The names are the ones the add card shows (`devices/rpc.ts`, `askToAdd`): real ones must look right, hostile ones must not.
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
  [`a${ZWJ}b`, "aU+200Db"], // between two ASCII letters: draws nothing, so it can only make a name look like another
  [`a${ZWNJ}b`, "aU+200Cb"],
  [`exam${ZWNJ}ple.com`, "examU+200Cple.com"],
  [`user${ZWJ}1`, "userU+200D1"],
  [`a${ZWJ}\u{1F469}`, "aU+200D\u{1F469}"], // one neighbour ASCII
  [`\u{1F469}${ZWJ}b`, "\u{1F469}U+200Db"],
  [`می${ZWNJ}x`, "میU+200Cx"],
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
  [`aㅤ${ZWJ}b`, "aU+3164U+200Db"], // a filler that draws as a blank is an escape too
];

describe("sealedEscape and the joiners", () => {
  test("a real name, in a value marked as a name, comes through as written", () => {
    for (const name of REAL_NAMES) expect(sealedEscape(name, true)).toBe(name);
  });
  test("a joiner that is not between two visible non-ASCII characters is an escape in a name; the characters around it are as they were", () => {
    for (const [name, shown] of HOSTILE) expect(sealedEscape(name, true)).toBe(shown);
  });
  test("in every value that is not a name, every joiner is an escape: a host, a command, a path, a file name, free text, a real name too", () => {
    expect(sealedEscape(`exam${ZWNJ}ple.com`)).toBe("examU+200Cple.com");
    expect(sealedEscape(`https://exam${ZWJ}ple.com/a`)).toBe("https://examU+200Dple.com/a");
    expect(sealedEscape(`rm -rf bu${ZWJ}ild/`)).toBe("rm -rf buU+200Dild/");
    expect(sealedEscape(`~/Documents/re${ZWNJ}port.md`)).toBe("~/Documents/reU+200Cport.md");
    for (const name of REAL_NAMES) expect(sealedEscape(name)).toBe(name.replaceAll(ZWJ, "U+200D").replaceAll(ZWNJ, "U+200C"));
  });
  test("what draws nothing is an escape too: soft hyphen, word joiner, Mongolian vowel separator, interlinear marks, the tag block", () => {
    expect(sealedEscape("a\u00ADb")).toBe("aU+00ADb");
    expect(sealedEscape("a\u2060b")).toBe("aU+2060b");
    expect(sealedEscape("a\u180Eb")).toBe("aU+180Eb");
    expect(sealedEscape("a\uFFF9b\uFFFAc\uFFFBd")).toBe("aU+FFF9bU+FFFAcU+FFFBd");
    expect(sealedEscape("a\u{E0000}b\u{E0041}c\u{E007F}d")).toBe("aU+E0000bU+E0041cU+E007Fd");
    expect(sealedEscape("a\u00ADb", true)).toBe("aU+00ADb");
    // Its neighbours are unchanged: the characters just outside each range show as they are.
    expect(sealedEscape("\u00AC\u00AE\uFFF8\uFFFC\u{DFFFF}\u{E0080}")).toBe("\u00AC\u00AE\uFFF8\uFFFC\u{DFFFF}\u{E0080}");
  });
  test("every other format and control character stays an escape, whatever it sits beside", () => {
    expect(sealedEscape("a​b")).toBe("aU+200Bb");
    expect(sealedEscape("a﻿b")).toBe("aU+FEFFb");
    expect(sealedEscape("a‎b")).toBe("aU+200Eb");
    expect(sealedEscape("a‮b")).toBe("aU+202Eb");
    expect(sealedEscape("a⁦b")).toBe("aU+2066b");
    expect(sealedEscape("a\u0007b")).toBe("aU+0007b");
    // Between two visible characters a joiner is let through; the zero-width space beside it is not.
    expect(sealedEscape(`a${ZWJ}​b`, true)).toBe("aU+200DU+200Bb");
    expect(sealedEscape(`a​${ZWNJ}b`, true)).toBe("aU+200BU+200Cb");
  });
  test("a lone surrogate beside a joiner is not a visible character", () => {
    expect(sealedEscape(`a${ZWJ}\uD800`, true)).toContain("U+200D");
    expect(sealedEscape(`\uDC00${ZWNJ}b`, true)).toContain("U+200C");
  });
});

describe("one escape rule for every sealed value", () => {
  const page = (field: "command" | "paths" | "title", value: unknown) => fieldPage({ cardId: "card_x", token: TOKEN, field, value: value as never });
  test("a command, a path and a list of files draw what is there: an invisible operator or a filler does not read as nothing or as a blank", () => {
    expect(page("command", { type: "code", code: "rm \u3164-rf ~/x" })).toContain("rm U+3164-rf ~/x");
    expect(page("paths", { type: "list", items: ["/Users/me/safe\u2064dir", "/tmp/a\u034Fb"] })).toContain("<li>/Users/me/safeU+2064dir</li><li>/tmp/aU+034Fb</li>");
    expect(page("title", { type: "text", text: "Open \u2800file" })).toContain("Open U+2800file");
  });
  test("the card's own page and the preview draw them too", () => {
    const options = [{ id: "approve", kind: "approve" as const, label: "Approve" }, { id: "deny", kind: "deny" as const, label: "Deny" }];
    const own = ownCardPage({ cardId: "card_x", token: "se_1", origin: "user", issuedAt: 0, expiresAt: null, fields: { title: { type: "text", text: "Run \u2064this" }, command: { type: "code", code: "cat /Users/me/safe\u2064dir" }, paths: { type: "list", items: ["/a\u17B4b"] } }, options });
    expect(own).toContain("Run U+2064this");
    expect(own).toContain("cat /Users/me/safeU+2064dir");
    expect(own).toContain("/aU+17B4b");
    const summary = { preview: { kind: "lines", lines: ["rm \u3164-rf"], hidden: 0, mono: true }, shortened: false } as unknown as CardSummary;
    expect(previewHtml(summary)).toContain("rm U+3164-rf");
  });
});

describe("a row's value is isolated for direction", () => {
  const rows = (value: string, name = true) => ({ type: "rows" as const, rows: [{ label: "name", value, ...(name ? { name: true as const } : {}) }] });
  test("the field page puts each value in its own isolate, a name's joiners kept and a hostile name's (or any other value's) escaped", () => {
    for (const name of REAL_NAMES) {
      const html = fieldPage({ cardId: "card_x", token: TOKEN, field: "detail", value: rows(name) });
      expect(html).toContain(`<dt>name</dt><dd><bdi>${name}</bdi></dd>`);
      expect(html).not.toContain("U+200");
    }
    const hostile = fieldPage({ cardId: "card_x", token: TOKEN, field: "detail", value: rows(`a${ZWJ}${ZWJ}b`) });
    expect(hostile).toContain("<dd><bdi>aU+200DU+200Db</bdi></dd>");
    // The same family emoji in a row the builder did not mark as a name (a command's argument, a host) shows the escapes.
    const unmarked = fieldPage({ cardId: "card_x", token: TOKEN, field: "detail", value: rows(REAL_NAMES[0]!, false) });
    expect(unmarked).toContain("U+200D");
    expect(fieldPage({ cardId: "card_x", token: TOKEN, field: "detail", value: rows(`exam${ZWNJ}ple.com`) })).toContain("<dd><bdi>examU+200Cple.com</bdi></dd>");
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
      // A preview's rows are a tool's input (never marked as names): every joiner in it is an escape.
      const shown = name.replaceAll(ZWJ, "U+200D").replaceAll(ZWNJ, "U+200C");
      expect(previewHtml(summary)).toContain(`<span class="k">name</span><span class="v"><bdi>${shown}</bdi></span>`);
    }
    const plain = ownCardPage({ cardId: "card_x", token: "se_1", origin: "user", issuedAt: 0, expiresAt: null, fields: { title: { type: "text", text: "Add a device?" }, detail: rows(REAL_NAMES[0]!, false) }, options });
    expect(plain).toContain("U+200D");
    const bad = previewHtml({ preview: { kind: "rows", rows: [{ label: "name", value: `a${ZWNJ}` }], hidden: 0 }, shortened: false } as unknown as CardSummary);
    expect(bad).toContain('<span class="v"><bdi>aU+200C</bdi></span>');
  });
});
