// Where a sealed press was made, kept WITH the press (lane WA, press-bound freshness). The OS-wide cover check (overlap.ts, R12) needs
// the press's point in the window. It used to read the window's latest mouse-down when the answer arrived, and only if that was at most
// 2 s old; an answer now allowed up to PRESS_BOUND_MS after its press would then have no point, be treated as a keyboard press, and skip
// the cover check. So the point is saved when the page says "received" for the press (the press's own number), from the window's
// mouse-down then, and the answer's check uses that saved point whatever its age within the press's own bound. A press that really had
// no pointer event (a key press: no recent mouse-down at "received") has no point and keeps the keyboard-press rule.

import type { PressRef } from "./press-bound";

/** How recent the window's mouse-down must be, at "received", to be this press's. */
export const DOWN_FOR_PRESS_MS = 2_000;

interface Saved {
  load: string;
  n: number;
  /** The page's word for the press's kind: only a "key" press may have no point. */
  kind: "pointer" | "key";
  point?: { x: number; y: number };
}

const MAX_TOKENS = 256;

export class PressPoints {
  private readonly saved = new Map<string, Saved>();

  /** The press just heard ("received"): its point is the window's latest mouse-down if that is recent (window coordinates), else none. */
  save(token: string, press: PressRef, down: { x: number; y: number; at: number } | undefined, now: number): void {
    const cur = this.saved.get(token);
    if (cur !== undefined && cur.load === press.load && press.n <= cur.n) return; // a replayed or older "received" rewrites nothing
    if (cur !== undefined) this.saved.delete(token);
    if (this.saved.size >= MAX_TOKENS) this.saved.delete(this.saved.keys().next().value!);
    const point = down !== undefined && now - down.at >= 0 && now - down.at <= DOWN_FOR_PRESS_MS ? { x: down.x, y: down.y } : undefined;
    this.saved.set(token, { load: press.load, n: press.n, kind: press.kind === "key" ? "key" : "pointer", ...(point !== undefined ? { point } : {}) });
  }

  /** The press's own saved point (undefined for a press that had none, and for one never heard: the keyboard-press rule). */
  pointOf(token: string, press: PressRef | undefined): { x: number; y: number } | undefined {
    const cur = this.saved.get(token);
    if (cur === undefined || press === undefined || cur.load !== press.load || cur.n !== press.n) return undefined;
    return cur.point;
  }

  /** Whether the press was a pointer press whose point was never learned (the renderer was starved past DOWN_FOR_PRESS_MS between the input and
   *  its handler, so no recent mouse-down was found): the answer is refused ("press it again"), because with no point the cover check can't
   *  run and a pointer press is never taken for a keyboard one. A press with no saved record at all counts as one too. */
  lacksPoint(token: string, press: PressRef | undefined): boolean {
    const cur = this.saved.get(token);
    if (cur === undefined || press === undefined || cur.load !== press.load || cur.n !== press.n) return true;
    return cur.kind === "pointer" && cur.point === undefined;
  }
}

/** The mouse-down a press's point is read from: the one of the window the press came from, never another window's (a click
 *  elsewhere on the screen must not become this card's point). */
export function pressDownFor(windowId: number | undefined, downs: ReadonlyMap<number, { x: number; y: number; at: number }>): { x: number; y: number; at: number } | undefined {
  return windowId === undefined ? undefined : downs.get(windowId);
}
