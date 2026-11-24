// What shows, character by character: the one place that decides whether a ZERO WIDTH JOINER or NON-JOINER (U+200D, U+200C) in
// a text is a real part of it (a family emoji, Persian "می‌خواهم") or a hidden character that must be drawn as an escape. Two
// doors use it, so a name one accepts is a name the other draws as it was written: a device's name (`devices/names.ts` in the
// core) and the text of a sealed card (`sealedEscape` in both apps' `sealed-pages.ts`).

/** The characters that never show on their own: controls, every format character (the joiners among them: `joinerInName` takes them
 *  back in a name, where they sit between two visible non-ASCII characters), lone surrogates, the line and paragraph separators, the
 *  fillers that draw as blanks (Hangul U+115F, U+1160, U+3164, U+FFA0, Khmer U+17B4–17B5, the braille blank U+2800) and the combining
 *  grapheme joiner U+034F (a mark that draws nothing and joins nothing a person can see), and the whole tag block U+E0000–E007F (its
 *  unassigned code points too: a character a later Unicode gives a meaning to must not slip in as nothing). */
export const UNSHOWN_CHAR = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u17B4\u17B5\u2800\u034F\u{E0000}-\u{E007F}]/u;
const MARK = /^\p{M}$/u;
const BLANK = /^\p{White_Space}$/u;
const ZWNJ = "‌";
const ZWJ = "‍";

export const isJoinerChar = (ch: string): boolean => ch === ZWJ || ch === ZWNJ;
export const isMarkChar = (ch: string): boolean => MARK.test(ch);
export const isBlankChar = (ch: string): boolean => BLANK.test(ch);
/** A skin-tone modifier (Fitzpatrick types 1–2 to 6). */
export const isToneModifierChar = (ch: string): boolean => {
  const c = ch.codePointAt(0)!;
  return c >= 0x1f3fb && c <= 0x1f3ff;
};
/** A character that shows something: not a blank, a mark, or anything `UNSHOWN_CHAR` holds (the joiners among them). */
export const isVisibleChar = (ch: string): boolean => !UNSHOWN_CHAR.test(ch) && !isMarkChar(ch) && !isBlankChar(ch);

/** Whether the joiner at `chars[i]` (one array entry per code point) sits between two visible characters: a mark or a skin-tone
 *  modifier on the one before it is looked past, and a joiner beside another joiner, a blank, a format character or either end is
 *  not between two visible characters. */
export function joinerBetweenVisible(chars: readonly string[], i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (isMarkChar(chars[j]!) || isToneModifierChar(chars[j]!))) j--;
  if (j < 0 || !isVisibleChar(chars[j]!)) return false;
  const next = chars[i + 1];
  return next !== undefined && isVisibleChar(next);
}

const isAscii = (ch: string): boolean => ch.codePointAt(0)! < 0x80;

/** Whether the joiner at `chars[i]` is real in a human NAME (a device's, a bot's, a person's) as a card draws it: between two visible
 *  characters (`joinerBetweenVisible`) AND neither neighbour is ASCII (an emoji sequence, Persian or Indic letters; a mark or a skin-tone
 *  modifier on the one before it is looked past). A joiner between two Latin letters, a digit or a dot draws nothing, so beside ASCII it can
 *  only make a name look like another ("exam\u200Cple") and stays an escape. */
export function joinerInName(chars: readonly string[], i: number): boolean {
  if (!joinerBetweenVisible(chars, i)) return false;
  let j = i - 1;
  while (j >= 0 && (isMarkChar(chars[j]!) || isToneModifierChar(chars[j]!))) j--;
  return !isAscii(chars[j]!) && !isAscii(chars[i + 1]!);
}

/** The one escape rule of every sealed value (a card's title, sentence, command, path, host, rows, labels): the text with every
 *  character `UNSHOWN_CHAR` holds drawn as its escape, `U+00AD`, `U+2064`, `U+3164`, so what a person approves is what is there and
 *  nothing reads as nothing or as a blank. Tab, line feed and carriage return stay (a command and a file have lines). Nothing else is
 *  touched: a Hebrew letter, a dash, a curly quote, an ellipsis is as it was. A joiner (U+200D, U+200C) stays as written only when `name`
 *  (the value is a human name a builder marked: a device's, a bot's, a person's) and `joinerInName` says it is real there. Both apps'
 *  sealed pages call this one function (`sealedEscape`), so no list of characters is kept twice. */
export function sealedEscape(text: string, name = false): string {
  let out = "";
  const chars = [...text];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (name && isJoinerChar(ch) && joinerInName(chars, i)) {
      out += ch;
    } else if (ch !== "\t" && ch !== "\n" && ch !== "\r" && UNSHOWN_CHAR.test(ch)) {
      out += `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
    } else out += ch;
  }
  return out;
}
