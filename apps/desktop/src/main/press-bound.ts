// The sealed card's press, numbered (lane WA, press-bound freshness). A sealed page numbers each TRUSTED press it handles (`isTrusted`,
// one counter per page load, only upward), and the number rides the page's three messages about that press: its word "received", the
// fresh visibility report its observer made at the press, and the answer. The app takes an answer only on a report that
//   (i)   carries the same press number (and the same page-load id),
//   (ii)  arrived after that press's "received",
//   (iii) was made by the observer the page created at that press (the page binds each observer to the number it was made for; a report
//         for another number is another press's),
//   (iv)  has not been used: one answer per press number, spent whatever its outcome.
// The answer may then come within PRESS_BOUND_MS of the press: a page or a runner that is slow between its report and its answer (a
// GPU-less runner's off-screen window, a starved renderer) no longer loses the press to a report-to-answer clock, and a report is never
// reusable for another press nor older than its own press. Everything else the press needs (the stacking rule, the cover check, the token,
// the card's hash, the every-box rule) is checked as before, elsewhere.
//
// MOSS Code's copy is apps/desktop/src/main/press-bound.ts; MOSS's own is apps/moss/src/main/press-bound.ts. The two files are identical.

/** How long after the page said "received" the press's answer may still be taken (the report is the press's own, however old). */
export const PRESS_BOUND_MS = 10_000;

/** A press as a page names it: its load's id (random, made when the page's script starts) and the press's number in that load. */
export interface PressRef {
  load: string;
  n: number;
  /** What kind of press the page says it was, from the trusted event: a pointer press (a mouse, pen or touch click) or a keyboard activation.
   *  Only "received" needs it (the app refuses a pointer press whose point it never learned; only a real key press takes the keyboard rule). */
  kind?: "pointer" | "key";
}

/** A page's press reference as a message carries it, or undefined for anything that is not one (the page is never trusted to send a
 *  well-formed value: a bad one is no press). */
export function parsePressRef(v: unknown): PressRef | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const { load, n, kind } = v as { load?: unknown; n?: unknown; kind?: unknown };
  if (typeof load !== "string" || !/^[0-9a-f]{16,32}$/.test(load)) return undefined;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > 1_000_000_000) return undefined;
  if (kind !== undefined && kind !== "pointer" && kind !== "key") return undefined;
  return { load, n, ...(kind !== undefined ? { kind } : {}) };
}

export type FreshVerdict = "ok" | "covered" | "late" | "none";

/** Why an answer had no report to ride on: said in the log as a fixed word, never a value the page sent. */
export type NoneWhy = "no press" | "another press" | "another page load" | "already used" | "over the bound" | "no report";

interface Press {
  load: string;
  n: number;
  /** When main heard "received" for this press. */
  at: number;
  report?: { seen: boolean; late: boolean };
  used: boolean;
}

/** The most tokens remembered (the oldest forgotten first); a token is one sealed page, so this is far more than are ever open. */
const MAX_TOKENS = 256;

export class PressBound {
  /** Each token's CURRENT press: only the newest the page has told (an older number never replaces it). */
  private readonly presses = new Map<string, Press>();
  /** Why the last `take` that said "none" said it (for the log). */
  lastWhy: NoneWhy | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /** The page said "received" for a press. A number not above the token's last, or a load id other than the one the token's first press
   *  named, counts for nothing (a replayed or foreign "received" can't reopen an older press or take over a newer one). */
  note(token: string, p: PressRef): "ok" | "another page load" | "not newer" {
    const cur = this.presses.get(token);
    if (cur !== undefined) {
      if (cur.load !== p.load) return "another page load";
      if (p.n <= cur.n) return "not newer";
      this.presses.delete(token);
    }
    if (this.presses.size >= MAX_TOKENS) this.presses.delete(this.presses.keys().next().value!);
    this.presses.set(token, { load: p.load, n: p.n, at: this.now(), used: false });
    return "ok";
  }

  /** The press's fresh report. It counts only for the token's current press (same load, same number, "received" heard before it), and
   *  only the first one: a second report for the same press changes nothing. */
  report(token: string, p: PressRef, seen: boolean, late: boolean): "ok" | "no press" | "another press" | "another page load" | "second report" | "already used" {
    const cur = this.presses.get(token);
    if (cur === undefined) return "no press";
    if (cur.load !== p.load) return "another page load";
    if (cur.n !== p.n) return "another press";
    if (cur.used) return "already used";
    if (cur.report !== undefined) return "second report";
    cur.report = { seen, late: late && !seen };
    return "ok";
  }

  /** The answer's check. The report must be the press's own, heard after its "received", not yet spent, and the answer within
   *  PRESS_BOUND_MS of that press. Spent whatever it says, except when the answer isn't for the current press at all (another number
   *  or load: that says nothing of the current press, which stays for its own answer). */
  take(token: string, p: PressRef | undefined): FreshVerdict {
    const none = (why: NoneWhy): FreshVerdict => { this.lastWhy = why; return "none"; };
    if (p === undefined) return none("no press");
    const cur = this.presses.get(token);
    if (cur === undefined) return none("no press");
    if (cur.load !== p.load) return none("another page load");
    if (cur.n !== p.n) return none(p.n < cur.n ? "another press" : "no press");
    if (cur.used) return none("already used");
    cur.used = true;
    if (this.now() - cur.at > PRESS_BOUND_MS) return none("over the bound");
    if (cur.report === undefined) return none("no report");
    this.lastWhy = undefined;
    return cur.report.seen ? "ok" : cur.report.late ? "late" : "covered";
  }
}
