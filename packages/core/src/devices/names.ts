// The one rule for a device's name (spec §8): what this device may be called, what the other device may call itself at a pairing, what
// a rename takes and what a name another computer shares is taken as. Every door uses `cleanName`, so a person can never give a
// device a name that every other device then turns away; a name the operating system gives that fails is cleaned (`safeDeviceName`),
// never refused.
//
// A name is drawn by a person's eyes, so what it may hold is what shows: 1 to 63 UTF-16 units; something visible; no control
// character, line or paragraph separator; no format character (`Cf`: the bidi marks, overrides and isolates, zero-width characters,
// soft hyphen, word joiner, the interlinear marks U+FFF9–FFFB, U+180E, the whole tag block U+E0000–E007F), except the joiner and
// non-joiner below; none of the fillers that draw as blanks (Hangul U+115F, U+1160, U+3164, U+FFA0, Khmer U+17B4–17B5, the braille
// blank U+2800); no combining mark with nothing to sit on (first, or after a blank), and no more than four after one character.
//
// Quotation marks are allowed: the add card draws the name on a row of its own, never inside a sentence, so no character in it can
// end or continue the engine's words (`devices/rpc.ts`, `askToAdd`).
//
// ZERO WIDTH JOINER and NON-JOINER (U+200D, U+200C) are real in names (a family emoji, Persian "می‌خواهم"): each is allowed only
// between two visible characters, never first or last, never doubled, never beside another format character or a blank. "Between"
// looks past a variation selector or a skin-tone modifier on the character before it (🏳️‍🌈, 👩🏽‍💻). The subdivision flags
// (🏴 and the tag block) are refused with the tag block; the flags drawn from two regional indicators pass.

import { UNSHOWN_CHAR, isBlankChar, isJoinerChar, isMarkChar, joinerBetweenVisible } from "@waifucave/moss-protocol";

/** Most combining marks after one character (a script's own need is a few; more is a stack that draws over its neighbours). */
export const MARKS_MAX = 4;
/** A name is at most this many UTF-16 units (the protocol's own limit). */
export const NAME_MAX = 63;

// What shows, and where a joiner is allowed, is decided in the protocol (`visible-text.ts`), where the sealed cards' pages read the same
// rule: a name this file accepts is drawn on the add card as it was written.
/** Why `name` can't be a device's name, in words the person reads; null when it can. */
export function nameProblem(name: unknown): string | null {
  if (typeof name !== "string" || name.length < 1) return "a device's name can't be empty";
  if (name.length > NAME_MAX) return `a device's name is at most ${NAME_MAX} characters`;
  if (!name.isWellFormed()) return "a device's name can't hold half of a character";
  const chars = [...name];
  let visible = false;
  let marks = 0;
  let prev: "start" | "blank" | "visible" | "mark" | "joiner" = "start";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!;
    if (isJoinerChar(ch)) {
      if (!joinerBetweenVisible(chars, i)) return "a device's name can't hold a joiner that isn't between two visible characters";
      prev = "joiner";
      marks = 0;
    } else if (UNSHOWN_CHAR.test(ch)) {
      return "a device's name can't hold control, invisible or direction-changing characters";
    } else if (isMarkChar(ch)) {
      if (prev === "start" || prev === "blank") return "a device's name can't start with an accent or hold one with no letter to sit on";
      if (++marks > MARKS_MAX) return `a device's name can't stack more than ${MARKS_MAX} accents on one character`;
      prev = "mark";
    } else if (isBlankChar(ch)) {
      prev = "blank";
      marks = 0;
    } else {
      visible = true;
      prev = "visible";
      marks = 0;
    }
  }
  return visible ? null : "a device's name needs something that shows";
}

/** Whether a name a device gave itself is one to take and show (`nameProblem` is null). */
export function cleanName(name: string): boolean {
  return nameProblem(name) === null;
}

/** A name made safe: what is refused is left out (controls, format characters, fillers, marks with nothing to sit on, marks past the
 *  fourth, the joiners), runs of blanks become one, and it is cut to 63 units at a character's edge; `fallback` when nothing visible
 *  is left. For the name the operating system gives this device, which is cleaned and never refused. */
export function safeDeviceName(raw: string, fallback = "Computer"): string {
  let out = "";
  let marks = 0;
  let onBase = false;
  for (const ch of raw.isWellFormed() ? raw : raw.toWellFormed()) {
    if (UNSHOWN_CHAR.test(ch)) continue;
    if (isMarkChar(ch)) {
      if (onBase && ++marks <= MARKS_MAX) out += ch;
    } else if (isBlankChar(ch)) {
      if (out !== "" && !out.endsWith(" ")) out += " ";
      onBase = false;
      marks = 0;
    } else {
      out += ch;
      onBase = true;
      marks = 0;
    }
  }
  let cut = "";
  for (const ch of out) {
    if (cut.length + ch.length > NAME_MAX) break;
    cut += ch;
  }
  const clean = cut.trim();
  return cleanName(clean) ? clean : fallback;
}
