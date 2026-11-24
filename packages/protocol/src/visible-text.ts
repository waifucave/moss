// What shows, character by character: the one place that decides whether a ZERO WIDTH JOINER or NON-JOINER (U+200D, U+200C) in
// a text is a real part of it (a family emoji, Persian "می‌خواهم") or a hidden character that must be drawn as an escape. Two
// doors use it, so a name one accepts is a name the other draws as it was written: a device's name (`devices/names.ts` in the
// core) and the text of a sealed card (`sealedEscape` in both apps' `sealed-pages.ts`).

/** The characters that never show on their own: controls, every format character (the joiners among them: `joinerBetweenVisible`
 *  takes them back where they sit between two visible characters), lone surrogates, the line and paragraph separators, and the
 *  fillers that draw as blanks (Hangul U+115F, U+1160, U+3164, U+FFA0, Khmer U+17B4–17B5, the braille blank U+2800). */
export const UNSHOWN_CHAR = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}ᅟᅠㅤﾠ឴឵⠀]/u;
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
