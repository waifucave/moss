// MOSS's press path for the sealed cards it draws (spec §5.5 "Only sealed buttons answer", E7; §3.4 "Two programs show
// parts"; §3.5 ruling A). MOSS's main process holds its OWN press record, trusted pointer-down report, fresh visibility
// reading and stacking rule, as MOSS Code's main process does for its own cards; no press is forwarded from or to another
// program, and the answer is signed with MOSS's own answer key (answer-key.ts) as the `moss` program.
//
// A press on a sealed button counts only when every one of these holds, checked in this order, each refusal said in the
// log by its reason alone (never a field's text):
//   1. The sender is the sealed frame its token was served to (the `moss-sealed://` page, the token in its own URL, on the
//      binding the mint made: MOSS's window's own page frame), and never a render window's (index.ts's IPC handler).
//   2. The fresh visibility reading: the report the press itself asked for (a new IntersectionObserver v2 made at the
//      press) says the button showed whole, uncovered and at 24 by 24 px or more (sealed.ts `takeFresh`).
//   3. The press record: MOSS's main process saw the press come to its window (`before-mouse-event`'s mouse down, or
//      `before-input-event`'s key down with that frame focused) within `PRESS_MS`, and, for a click, the sealed frame's
//      own document reported a trusted pointerdown (`isTrusted`, the preload's report, which a page script can't make)
//      for that same press. One press answers once: taking it spends it.
//   4. The stacking rule: the router places the card in THIS window (`pressMatchesPlacement`, from `card_placed` and
//      `card.placement` alone: MOSS keeps no placement of its own), and the window is visible, focused and not
//      minimised. MOSS draws nothing of its own over a pending card.
//   4b. The overlap check (R12, overlap.ts): no window of one of OUR programs (MOSS, MOSS Code, the background host) lies
//      over the press point, read from the OS's own window list; another app's window never counts. A keyboard press has
//      no point and isn't checked here (2 still is).
//   5. MOSS's answer key is registered with the engine for this device (a press waits a moment for it).
// Then the store signs (`programCardAnswerSigningInput`, program `moss`) and the engine's `card.answer` decides; it also
// refuses every program's answer while computer use acts on this computer, and MOSS says its refusal as it came (MOSS
// asks `computer.acting` nothing of its own: a 3 s round trip there once refused a person's real press under load).
//
// §5.5 also names a hardware check (an event no other process posted: `eventSourceUnixProcessID`, `LLMHF_INJECTED`,
// XTEST). Neither app has it yet; it is not built here either (the report says so).
import { pressMatchesPlacement, type CardPlacement } from "@waifucave/moss-protocol";
import type { SealedFrames, AnswerSigner } from "./sealed";
import { STALL_CREDIT_MAX_MS } from "@waifucave/moss-app-release/stall-watch";
import type { KeyState } from "./answer-key";

/** How long after the press main saw the answer it carries may still be taken (the page asks for its fresh reading
 *  first, up to 400 ms, then answers). */
export const PRESS_MS = 1_500;
/** How long after main's mouse down the frame's own trusted pointerdown report may come. */
export const REPORT_MS = 1_000;

interface Down {
  at: number;
  /** Where in the window's content it landed (CSS pixels from the content's top left), for the overlap check. */
  point?: { x: number; y: number };
  /** The frame whose own document reported a trusted pointerdown for this press, within REPORT_MS of main's mouse down. */
  frame?: string;
  /** A report that came after REPORT_MS: it counts only for a person's write (`takeWrite`), and only when the main process was
   *  itself not running for the delay (`credit`: the stall it was credited at the time the report was handled). */
  late?: { frame: string; at: number; credit: number };
  /** Another press was still waiting for its report when this one came, while the machine was stalling: a report that comes now
   *  can't be told from the other press's, so no write takes this press. */
  crowded?: boolean;
  spent?: boolean;
}

/** What the press record asks of the stall watch (`@waifucave/moss-app-release/stall-watch`): the main process's own unscheduled
 *  time. Absent in the sealed path's tests: every bound is then exactly its number. */
export interface Stalls {
  arm(forMs: number): void;
  credit(from: number, to?: number): number;
}

/** What a person's write is judged by: the press's own bound and the credit's cap, so how long to watch after a press. */
export const WATCH_MS = PRESS_MS + STALL_CREDIT_MAX_MS + 500;

/** The outcome of `takeWrite`: taken, or refused with which check refused and by how many ms. */
export type WriteTake =
  | { ok: true; how: "click" | "key"; /** The stall counted in the press's age (0 when the machine kept up). */ stalledMs: number }
  | { ok: false; check: WriteCheck; /** How far past its bound it was (ms), for a timing check. */ overMs?: number; stalledMs?: number; /** A press from this frame was seen, and only its timing failed. */ late?: true };
export type WriteCheck =
  | "no press seen"
  | "the press was already used"
  | "no pointerdown report from this page"
  | "the press landed in another frame"
  | "two presses close together on a stalled machine"
  | "the page's report came too late"
  | "the write came too late";

/** MOSS's press record: what its main process saw come to its window, and which frame's document took the press. */
export class PressRecord {
  private readonly downs = new Map<number, Down>();
  private readonly keys = new Map<number, Down>();

  constructor(private readonly now: () => number = Date.now, private readonly stalls?: Stalls) {}

  /** The main process's own unscheduled time in [from, now], never more than the cap (0 without a stall watch). */
  private stalled(from: number, to: number = this.now()): number {
    return this.stalls === undefined ? 0 : Math.min(STALL_CREDIT_MAX_MS, this.stalls.credit(from, to));
  }

  /** A mouse down main saw in a window (`before-mouse-event`), and where it landed in the window's content. */
  mouseDown(windowId: number, point?: { x: number; y: number }): void {
    const at = this.now();
    const was = this.downs.get(windowId);
    // The press before this one is still waiting for its report while the machine is stalling: whichever report comes next
    // could be its, so this press can't be told apart (a write refuses it; a machine that kept up never gets here).
    const crowded = was !== undefined && !was.spent && was.frame === undefined && was.late === undefined && this.stalled(was.at, at) > 0
      && at - was.at - this.stalled(was.at, at) <= REPORT_MS;
    this.downs.set(windowId, { at, ...(point !== undefined ? { point } : {}), ...(crowded ? { crowded: true as const } : {}) });
    this.stalls?.arm(WATCH_MS);
  }

  /** Where the window's latest mouse down landed, while it is recent (the overlap check's press point). */
  lastPoint(windowId: number, maxMs = PRESS_MS): { x: number; y: number } | undefined {
    const d = this.downs.get(windowId);
    return d === undefined || this.now() - d.at > maxMs ? undefined : d.point;
  }

  /** A frame's document reported a trusted pointerdown (the preload's `moss:press-seen`, bound to the sender frame): it
   *  names where main's latest mouse down landed, if it is recent and not yet claimed. First report wins. */
  frameSaw(windowId: number, frame: string): void {
    const d = this.downs.get(windowId);
    if (d === undefined || d.frame !== undefined || d.late !== undefined) return;
    const now = this.now();
    if (now - d.at <= REPORT_MS) { d.frame = frame; return; }
    // After REPORT_MS: the sealed path never takes it (`take` reads `frame`); a person's write may, when the machine's own
    // stall (and not the page) was the delay (`takeWrite`). First report wins here too.
    d.late = { frame, at: now, credit: this.stalled(d.at, now) };
  }

  /** A key down main saw in a window, with the frame that had the focus (`before-input-event`; repeats are no press). */
  keyDown(windowId: number, focusedFrame: string | undefined): void {
    if (focusedFrame === undefined) return;
    this.keys.set(windowId, { at: this.now(), frame: focusedFrame });
    this.stalls?.arm(WATCH_MS);
  }

  /** Takes the press for an answer from `frame`: a recent click whose own trusted pointerdown landed in that frame, or a
   *  recent key down while that frame had the focus. Spent once taken. */
  take(windowId: number, frame: string): "click" | "key" | undefined {
    const now = this.now();
    const d = this.downs.get(windowId);
    if (d !== undefined && !d.spent && d.frame === frame && now - d.at <= PRESS_MS) {
      d.spent = true;
      return "click";
    }
    const k = this.keys.get(windowId);
    if (k !== undefined && !k.spent && k.frame === frame && now - k.at <= PRESS_MS) {
      k.spent = true;
      return "key";
    }
    return undefined;
  }

  /** Takes the press for a PERSON'S WRITE from `frame` (a send, a new bot, a setting): the same press and the same frame as
   *  `take` requires, and one write per press, but a press's age and its report's delay are counted without the time the main
   *  process itself was not running (`stalls`): on an overloaded machine the mouse down, the page's report and the write can be
   *  handled seconds apart though they were one press. The credit is the process's own measured wait (never the page's word),
   *  at most STALL_CREDIT_MAX_MS, so with no stall the bounds are exactly PRESS_MS and REPORT_MS. A refusal says which check
   *  refused and by how many ms. The sealed buttons' `take` is not this: its fresh reading has its own limit. */
  takeWrite(windowId: number, frame: string): WriteTake {
    const now = this.now();
    const d = this.downs.get(windowId);
    const k = this.keys.get(windowId);
    const click = d !== undefined && !d.spent ? this.judgeClick(d, frame, now) : undefined;
    if (click?.ok === true) { d!.spent = true; return click; }
    const key = k !== undefined && !k.spent ? this.judgeKey(k, frame, now) : undefined;
    if (key?.ok === true) { k!.spent = true; return key; }
    // Neither took it: say why for the newer press that could have.
    const used = (d !== undefined && d.spent === true) || (k !== undefined && k.spent === true);
    if (click !== undefined && key !== undefined) return d!.at >= k!.at ? click : key;
    return click ?? key ?? { ok: false, check: used ? "the press was already used" : "no press seen" };
  }

  /** Why `take` (the sealed buttons' strict bounds) found no press for `frame`, for the log line only (it spends nothing and
   *  never changes what is refused): which check, and by how many ms. */
  explainTake(windowId: number, frame: string): string {
    const now = this.now();
    const d = this.downs.get(windowId);
    const k = this.keys.get(windowId);
    if (d === undefined && k === undefined) return "main saw no mouse down or key down in this window";
    const why = (x: Down | undefined, kind: string): string | undefined => {
      if (x === undefined) return undefined;
      if (x.spent === true) return `the ${kind} was already used`;
      const age = now - x.at;
      if (kind === "click" && x.frame === undefined) return `no report from the page named a frame (the mouse down was ${age} ms ago${x.late !== undefined ? `; a report came ${x.late.at - x.at} ms after it, limit ${REPORT_MS}` : ""})`;
      if (x.frame !== frame) return `the ${kind} landed in another frame`;
      if (age > PRESS_MS) return `the answer came ${age - PRESS_MS} ms past the bound (${PRESS_MS})`;
      return undefined;
    };
    const click = why(d, "click");
    const key = why(k, "key");
    if (click !== undefined && key !== undefined) return d!.at >= k!.at ? click : key;
    return click ?? key ?? "no press found";
  }

  private judgeClick(d: Down, frame: string, now: number): WriteTake {
    const stalledMs = this.stalled(d.at, now);
    if (d.crowded === true) return { ok: false, check: "two presses close together on a stalled machine", stalledMs };
    const reported = d.frame ?? d.late?.frame;
    if (reported === undefined) return { ok: false, check: "no pointerdown report from this page", stalledMs, ...(now - d.at - stalledMs > PRESS_MS ? { overMs: now - d.at - stalledMs - PRESS_MS } : {}) };
    if (reported !== frame) return { ok: false, check: "the press landed in another frame", stalledMs };
    if (d.frame === undefined && d.late !== undefined) {
      const over = d.late.at - d.at - d.late.credit - REPORT_MS;
      if (over > 0) return { ok: false, check: "the page's report came too late", overMs: over, stalledMs: d.late.credit, late: true };
    }
    const over = now - d.at - stalledMs - PRESS_MS;
    if (over > 0) return { ok: false, check: "the write came too late", overMs: over, stalledMs, late: true };
    return { ok: true, how: "click", stalledMs };
  }

  private judgeKey(k: Down, frame: string, now: number): WriteTake {
    if (k.frame !== frame) return { ok: false, check: "the press landed in another frame" };
    const stalledMs = this.stalled(k.at, now);
    const over = now - k.at - stalledMs - PRESS_MS;
    if (over > 0) return { ok: false, check: "the write came too late", overMs: over, stalledMs, late: true };
    return { ok: true, how: "key", stalledMs };
  }

  forget(windowId: number): void {
    this.downs.delete(windowId);
    this.keys.delete(windowId);
  }
}

/** What to tell the person when a write was refused: a press that was theirs and only late is a busy machine, with their text kept. */
export function writeRefusalWords(r: { check: WriteCheck; late?: true }): string {
  if (r.late === true || r.check === "two presses close together on a stalled machine") return "Your computer was too busy to confirm that press in time. Nothing was lost: press again.";
  return "Words go only right after your own key press or click.";
}

export interface WindowStanding {
  /** MOSS's window id in presence and placements (`main`). */
  window: string;
  visible: boolean;
  focused: boolean;
  minimized: boolean;
}

/** The stacking rule (4): the router's place for the card is this window, and the window is in front of the person. */
export function stackingRule(placement: CardPlacement | undefined, w: WindowStanding): string | undefined {
  if (placement === undefined) return "the router hasn't placed this card";
  if (!pressMatchesPlacement(placement, { kind: "window", program: "moss", window: w.window })) return `the card is placed ${placement.kind === "island" ? "on the island" : placement.kind === "elsewhere" ? "elsewhere" : "in another window"}`;
  if (!w.visible || w.minimized) return "MOSS's window isn't showing";
  if (!w.focused) return "MOSS's window isn't in front";
  return undefined;
}

export interface PressDeps {
  sealed: SealedFrames;
  record: PressRecord;
  placementOf: (cardId: string) => CardPlacement | undefined;
  standing: (windowId: number) => WindowStanding | undefined;
  keyReady: (ms: number) => Promise<KeyState>;
  signer: AnswerSigner;
  device: () => string | undefined;
  answer: (a: { id: string; hash: string; option: string; proof: unknown; children?: readonly string[] }) => Promise<{ accepted: boolean; reason?: string }>;
  log: (line: string) => void;
  /** The overlap check (4b): which of our programs' windows lies over this press point in that window, named (never a
   *  title), or undefined. Absent: no window list here (the in-page reading stands alone). */
  cover?: (windowId: number, point: { x: number; y: number } | undefined) => string | undefined;
}

/** A press's outcome: refused, with what to tell the person (`reason`), and `covered` when a window lies over the button (as
 *  MOSS Code's result says it). */
export type PressResult = { accepted: true } | { accepted: false; reason: string; covered?: true };

/** A refusal in the plain words MOSS shows beside the card. */
export function refusalWords(r: { reason: string; covered?: true }): string {
  const said = r.reason.trim();
  const sentence = said.length === 0 ? "The press didn't count: press again." : `${said[0]!.toUpperCase()}${said.slice(1)}`;
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

/** One press's answer, from the sealed frame's own channel (checks 2 to 6; check 1 is the IPC handler's). */
export async function answerPress(d: PressDeps, a: { token: string; option: string | undefined; senderKey: string; frame: string; windowId: number; children?: readonly string[] }): Promise<PressResult> {
  const refuse = (why: string, say = why, covered = false): PressResult => {
    d.log(`sealed: answer refused (${why})`);
    return { accepted: false, reason: say, ...(covered ? { covered: true as const } : {}) };
  };
  const cardId = d.sealed.cardOf(a.token);
  if (cardId === undefined) return refuse("no such sealed button");
  // 2. The fresh reading, spent first so a refused answer spends it.
  const fresh = d.sealed.takeFresh(a.token);
  if (fresh !== "ok") return refuse(fresh === "covered" ? "the button was covered or not shown at the press" : "no visibility reading came with the press", fresh === "covered" ? "the button wasn't fully showing when it was pressed" : "the press wasn't checked just now");
  // 3. The press record.
  const how = d.record.take(a.windowId, a.frame);
  if (how === undefined) return refuse(`MOSS saw no press of its own land in this button (${d.record.explainTake(a.windowId, a.frame)})`, "the press didn't come to this button");
  // 4. The stacking rule.
  const w = d.standing(a.windowId);
  const stacked = w === undefined ? "not MOSS's window" : stackingRule(d.placementOf(cardId), w);
  if (stacked !== undefined) return refuse(stacked);
  // 4b. The overlap check, at the click's own point.
  const cover = d.cover?.(a.windowId, how === "click" ? d.record.lastPoint(a.windowId) : undefined);
  if (cover !== undefined) return refuse(`a window lies over the button: ${cover}`, `${cover.startsWith("one of MOSS's own") ? "one of MOSS's own windows" : "another MOSS window"} lies over the button: move it away and press again`, true);
  // 5. The key.
  const key = await d.keyReady(2_000);
  if (key.kind !== "registered") return refuse(`MOSS's answer key isn't registered (${key.kind === "refused" || key.kind === "waiting" ? key.why : key.kind})`, "this computer's answer key for MOSS isn't registered yet");
  const device = d.device();
  if (device === undefined) return refuse("no device");
  const option = a.option ?? d.sealed.optionOf(a.token);
  if (option === undefined) return refuse("no option named");
  const out = d.sealed.buildAnswer(a.token, option, a.children, a.senderKey, d.signer, device);
  if ("error" in out) return refuse(out.error);
  const r = await d.answer({ id: out.card.id, hash: out.card.hash, option, proof: out.proof, ...(out.kids !== undefined ? { children: out.kids } : {}) })
    .catch((err: unknown) => ({ accepted: false, reason: err instanceof Error ? err.message.slice(0, 200) : "refused" }));
  if (r.accepted !== true) {
    d.sealed.confirmedAnswer(out.card.id, false);
    return refuse(`the engine refused the answer (${typeof r.reason === "string" ? r.reason.slice(0, 120) : "no reason"})`, typeof r.reason === "string" ? r.reason.slice(0, 200) : "refused");
  }
  d.sealed.confirmedAnswer(out.card.id, true);
  d.log(`sealed: answer accepted for ${out.card.id} (${how})`);
  return { accepted: true };
}

/** The tallest a card's frame grows: high enough for a plugin's whole OK card, so its page never overflows its frame (a
 *  page that overflowed kept resizing and never read as ready); the list that holds the card scrolls instead. */
export const CARD_MAX_HEIGHT = 4_000;
/** How much taller than its frame a card's page must say it is before the frame grows. The card's page fills at least its
 *  frame (it is laid out as a window), so each report is about the frame's own height, a pixel or so over from rounding:
 *  growing on those crept the frame up to its cap, and its buttons moved under the press. */
export const CARD_GROW_SLACK = 6;

/** The height to give a card's frame for its page's report, or undefined to leave it as it is (`now`: what it has). */
export function cardHeight(now: number | undefined, reported: number): number | undefined {
  const want = Math.max(60, Math.min(CARD_MAX_HEIGHT, Math.round(reported)));
  if (now !== undefined && want <= now + CARD_GROW_SLACK) return undefined;
  return want;
}

/** Where a mouse-down was in the window: its screen point less the window's content origin. Electron's own `x`/`y` are in
 *  the coordinates of the frame's widget the press went to (an out-of-process frame's own), which made the overlap check
 *  test the wrong point; without a screen point, they are what there is. */
export function windowPointOf(mouse: { x: number; y: number; globalX?: number; globalY?: number }, content: { x: number; y: number }): { x: number; y: number } {
  return typeof mouse.globalX === "number" && typeof mouse.globalY === "number" ? { x: mouse.globalX - content.x, y: mouse.globalY - content.y } : { x: mouse.x, y: mouse.y };
}
