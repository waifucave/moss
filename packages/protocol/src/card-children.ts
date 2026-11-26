/** A card's checkboxes (`Card.children`) as a window draws them and answers them: one rule, kept once, for both desktop
 *  apps' sealed pages and their main processes (the iPhone has its own Swift copy of the same rules: `drawnWhole`,
 *  `cutFields`). Pure.
 *
 *  What a window may draw: every box has its own id, a label of its own that reads as one line, and no two boxes read the
 *  same (two the person can't tell apart is a card that can't be answered knowingly). A card that fails any of that is
 *  not drawn here: its Approve is withheld and the card says why in `CHILDREN_NOT_DRAWN_TEXT`; Deny stays (a no grants
 *  nothing). A long list is cut: it is opened and read to its end before Approve counts. */

import { sealedEscape } from "./visible-text";

/** How many boxes a card shows before the rest is behind "Show all": the iPhone's `Card.Cut.items`. */
export const CHILDREN_CUT_ITEMS = 8;

/** The longest a box's name (as drawn, one line) may be: a longer one can't be shown whole in the list, so it could never count as seen. */
export const CHILDREN_LABEL_MAX = 300;

/** The heading over the boxes: what Approve covers. */
export const CHILDREN_HEAD_TEXT = "Approve covers the ticked ones";

/** Said under a cut list until it has been opened and read to its end. */
export const CHILDREN_UNREAD_TEXT = "Open the list and read it to its end first: Approve covers only what was on screen.";

/** What a card says when it carries boxes this window can't draw whole (a repeated label or id, a box with no label): fail
 *  closed, never a guess at what the person ticked. */
export const CHILDREN_NOT_DRAWN_TEXT = "This card has boxes MOSS can't show properly (two read the same, or one has no name), so it can't be allowed. You can still say no.";

/** What the main process says when an Approve from a part's own button (a plugin's page, the island) reaches a card that has boxes:
 *  the boxes are drawn only on the app's own card. */
export const CHILDREN_OWN_CARD_ONLY = "this card has boxes to tick: allow it in MOSS's own window";

/** A box's label as one line: every line break (and line or paragraph separator) shown as a visible ⏎, so a label can never
 *  draw what looks like a second box under the first ("Calendar\n☐ Send email as you"). */
export function oneLine(label: string): string {
  let out = "";
  for (let i = 0; i < label.length; i++) {
    const c = label.charCodeAt(i);
    // CR LF is one break; LF, VT, FF, CR, NEL, LS and PS are each one.
    if (c === 0x0d && label.charCodeAt(i + 1) === 0x0a) i++;
    out += c === 0x0a || c === 0x0b || c === 0x0c || c === 0x0d || c === 0x85 || c === 0x2028 || c === 0x2029 ? " ⏎ " : label[i];
  }
  return out;
}

/** The text of a label that is a protocol `Text`: a string, or the English one. Anything else has no text. */
export function childText(label: unknown): string {
  if (typeof label === "string") return label;
  if (label !== null && typeof label === "object" && typeof (label as { en?: unknown }).en === "string") return (label as { en: string }).en;
  return "";
}

/** What a box says on screen: one line, every unseen character shown as its escape. */
export function childLine(label: unknown): string {
  return sealedEscape(oneLine(childText(label)));
}

export interface DrawnChild { id: string; line: string; checked: boolean }

export type DrawnChildren =
  | { drawn: true; children: DrawnChild[]; cut: boolean }
  | { drawn: false; why: string };

/** The boxes a card carries, ready to draw, or why they can't be (fail closed). No boxes is a card with nothing to draw. */
export function drawChildren(raw: unknown): DrawnChildren {
  if (raw === undefined || raw === null) return { drawn: true, children: [], cut: false };
  if (!Array.isArray(raw)) return { drawn: false, why: "the boxes aren't a list" };
  const out: DrawnChild[] = [];
  const ids = new Set<string>();
  const lines = new Set<string>();
  for (const c of raw as unknown[]) {
    const id = c !== null && typeof c === "object" ? (c as { id?: unknown }).id : undefined;
    if (typeof id !== "string" || id === "") return { drawn: false, why: "a box has no id" };
    if (ids.has(id)) return { drawn: false, why: "two boxes share an id" };
    const line = childLine((c as { label?: unknown }).label);
    if (line.replaceAll("⏎", "").trim() === "") return { drawn: false, why: "a box has no name" };
    // A name too long to be on screen whole in the list's own box could never count as seen: the card is not drawn.
    if (line.length > CHILDREN_LABEL_MAX) return { drawn: false, why: "a box's name is too long to read" };
    // Two names that differ only in the spaces around or between their words read the same.
    const same = line.trim().replace(/\s+/g, " ");
    if (lines.has(same)) return { drawn: false, why: "two boxes read the same" };
    ids.add(id);
    lines.add(same);
    out.push({ id, line, checked: (c as { checked?: unknown }).checked === true });
  }
  return { drawn: true, children: out, cut: out.length > CHILDREN_CUT_ITEMS };
}

/** What the main process checks of an answer's ticks before it signs them: an Approve names only boxes the card carries, each
 *  once, and the card's boxes can be drawn at all; a Deny carries none. Returns the ticks to sign (undefined: none sent) or why not. */
export function checkTicks(cardChildren: unknown, kind: "approve" | "deny", ticks: readonly string[] | undefined): { ok: true; ticks?: readonly string[] } | { ok: false; why: string } {
  const drawn = drawChildren(cardChildren);
  const has = drawn.drawn && drawn.children.length > 0;
  if (!drawn.drawn) return kind === "deny" ? { ok: true } : { ok: false, why: drawn.why };
  if (kind === "deny") return { ok: true };
  if (ticks === undefined) return { ok: true };
  if (!has) return ticks.length === 0 ? { ok: true } : { ok: false, why: "this card has no boxes to tick" };
  const known = new Set(drawn.children.map((c) => c.id));
  const seen = new Set<string>();
  for (const t of ticks) {
    if (!known.has(t)) return { ok: false, why: "a ticked box isn't on this card" };
    if (seen.has(t)) return { ok: false, why: "a box is ticked twice" };
    seen.add(t);
  }
  return { ok: true, ticks };
}
