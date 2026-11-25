// A pending card whose place goes away (card-replace.ts), over the real sealed store and the real FallbackNet: the only thing
// stood in for is the window's maker (index.ts `showFallbackCard`), which like the real one does nothing without an entry for
// the card and nothing for a card already open.
import { describe, expect, test } from "bun:test";
import { netMove, pressWindowIsOpen, placeFromEngine, windowShowsCard, type CardPlace } from "../src/main/card-place";
import { CardReplacer, MAX_REPLACEMENTS } from "../src/main/card-replace";
import { FallbackNet } from "../src/main/fallback-net";
import { SealedFrames, type SealedCard } from "../src/main/sealed";
import { fallbackOnVisibility } from "../src/main/shortcuts";

const card = (id: string): SealedCard => ({ id, kind: "tool", computer: "Studio", origin: "user", issuedAt: 0, expiresAt: null, hash: "a".repeat(64), fields: {}, options: [{ id: "a", kind: "approve", label: "A" }, { id: "d", kind: "deny", label: "D" }] });
const ISLAND = new Set([10, 11, 12]);
type Win = { closed: boolean };
const MAIN = 1;

function world(placed: { kind: "island" } | { kind: "strip"; program: "code"; window: string } = { kind: "island" }) {
  const sealed = new SealedFrames();
  const opened: Win[] = [];
  // A fake clock: timers fire only when it is advanced.
  let clock = 0;
  const timers = new Map<object, { at: number; fn: () => void }>();
  const net = new FallbackNet<Win>({
    delayMs: 2_000,
    schedule: (fn, ms) => { const h = { unref() { /* fake */ } }; timers.set(h, { at: clock + ms, fn }); return h as never; },
    unschedule: (h) => { timers.delete(h as never); },
    show: (id) => { const e = net.get(id); if (e === undefined || (e.win !== undefined && !e.win.closed)) return; e.win = { closed: false }; opened.push(e.win); },
    closeWindow: (w) => { w.closed = true; },
    isAlive: (w) => !w.closed,
  });
  const cardPlaces = new Map<string, CardPlace>();
  const placeCalls = new Map<string, number>();
  const log: string[] = [];
  const buttonsShown = (id: string) => sealed.buttonsVisible(id, (w) => windowShowsCard(placed, w !== undefined && ISLAND.has(w)));
  const r = new CardReplacer({
    cardsIn: (w, closed, doc) => sealed.windowGone(w, closed, doc),
    isPending: (id) => sealed.isPending(id),
    arrived: () => true,
    placedOnce: (id) => cardPlaces.has(id),
    // index.ts: `placeCardNow`: a place that did not change does nothing (an open card of the app's own stays open).
    place: (id) => {
      placeCalls.set(id, (placeCalls.get(id) ?? 0) + 1);
      const now = placeFromEngine(placed, { front: false, drawnInWindow: false });
      const before = cardPlaces.get(id);
      const act = netMove(before, now, net.isOpen(id));
      cardPlaces.set(id, now);
      if (act === "show-strip") net.showNow(id, true);
      else if (act === "stand-down") { net.disarm(id); net.arm(id); }
    },
    restack: () => undefined,
    engineplace: () => placed,
    front: () => false,
    drawnInWindow: () => false,
    buttonsShown,
    fallbackHere: () => true,
    fallbackRunning: (id) => net.isLive(id),
    fallbackWindowOpen: (id) => net.isOpen(id),
    armFallback: (id) => net.armIfNone(id),
    showFallbackNow: (id) => net.showNow(id),
    log: (l) => log.push(l),
  });
  const tokens: string[] = [];
  let reportRef: (token: string, visible: boolean) => void = () => undefined;
  const frames = (id: string, win: number, visible = true, doc = win) => {
    if (sealed.get(id) === undefined) { sealed.fromCore(card(id)); cardPlaces.set(id, "island"); net.arm(id); }
    const f = { parent: { processId: 100, routingId: doc } };
    for (const e of ["button:a", "button:d"]) { const t = sealed.mint(id, e, f, win)!.token; tokens.push(t); sealed.markVisible(t, visible); if (visible && buttonsShown(id)) net.disarm(id); else if (!visible) reportRef(t, false); }  // a new page says at once what it reads
  };
  /** The page's own visibility word, with the app's handler (`sealedVisible`). */
  const report = (token: string, visible: boolean) => {
    sealed.markVisible(token, visible);
    const id = sealed.cardOf(token);
    if (id === undefined) return;
    const step = fallbackOnVisibility({ visible, bothVisible: buttonsShown(id), fallbackOpen: net.isOpen(id), answering: false });
    if (step === "disarm") net.disarm(id);
    else if (step === "arm") net.armIfNone(id);
  };
  reportRef = report;
  const advance = (ms: number) => {
    clock += ms;
    for (const [h, t] of [...timers]) if (t.at <= clock && timers.has(h)) { timers.delete(h); t.fn(); }
  };
  const timersOf = () => [...timers.values()].map((t) => t.at);
  return { sealed, r, net, opened, advance, timersOf, now: () => clock, placeCalls, log, frames, report, tokens, buttonsShown };
}
const openWindows = (w: ReturnType<typeof world>) => w.opened.filter((x) => !x.closed).length;

describe("a place going away", () => {
  for (const [name, win] of [["the bundled island", 10], ["a copy of the island", 11], ["the pill", 12]] as const) {
    test(`${name} closing: the card's frames go, it is placed again, and the net's timer runs`, () => {
      const w = world();
      w.frames("c1", win);
      expect(w.net.has("c1")).toBe(false);
      w.r.lost(win, true);
      expect(w.r.countOf("c1")).toBe(1);
      expect(w.net.has("c1")).toBe(true);
      expect(w.net.isOpen("c1")).toBe(false);
    });
  }

  test("another surface still shows the buttons: placed again, no timer", () => {
    const w = world();
    w.frames("c1", 10);
    w.frames("c1", 11);
    w.r.lost(10, true);
    expect(w.r.countOf("c1")).toBe(1);
    expect(w.net.has("c1")).toBe(false);
  });

  test("a running deadline is never moved by a re-placement (the timer object stays the same)", () => {
    const w = world();
    w.frames("c1", 10, false);
    const before = w.net.get("c1")!.timer;
    for (let i = 0; i < MAX_REPLACEMENTS; i++) w.r.lost(10, false, "p:100:10");
    expect(w.net.get("c1")!.timer).toBe(before);
  });

  test(`the ${MAX_REPLACEMENTS + 1}th loss ends with exactly one net window open, and it stays open through 20 more reloads and closes`, () => {
    const w = world();
    w.frames("c1", 10, false);
    for (let i = 0; i < MAX_REPLACEMENTS + 1; i++) { w.frames("c1", 10, false); w.r.lost(10, false, "p:100:10"); }
    expect(w.net.isOpen("c1")).toBe(true);
    expect(openWindows(w)).toBe(1);
    const win = w.net.get("c1")!.win!;
    for (let i = 0; i < 20; i++) { w.frames("c1", 10, false); if (i % 2 === 0) w.r.lost(10, false, "p:100:10"); else w.r.lost(10, true); expect(openWindows(w)).toBe(1); }
    expect(w.net.get("c1")!.win).toBe(win);
    expect(win.closed).toBe(false);
    expect(w.placeCalls.get("c1") ?? 0).toBeLessThanOrEqual(MAX_REPLACEMENTS);
  });

  test("past the cap, buttons that show again and go again bring the net back", () => {
    const w = world();
    w.frames("c1", 10, false);
    for (let i = 0; i < MAX_REPLACEMENTS + 1; i++) { w.frames("c1", 10, false); w.r.lost(10, false, "p:100:10"); }
    for (const t of w.tokens) w.report(t, true);
    expect(w.net.has("c1")).toBe(false);
    w.r.lost(10, true);
    expect(w.net.isOpen("c1")).toBe(true);
  });

  test("repeated \"not visible\" reports do not move the deadline: the net opens 2 s after the first", () => {
    const w = world();
    w.frames("c1", 10, true);
    const [approve] = w.tokens;
    expect(w.net.has("c1")).toBe(false);
    w.report(approve!, false);
    const deadline = w.net.get("c1")!.timer;
    for (let i = 0; i < 9; i++) { w.advance(190); w.report(approve!, false); expect(w.net.get("c1")!.timer).toBe(deadline); expect(w.net.isOpen("c1")).toBe(false); }
    w.advance(300);
    expect(w.now()).toBeGreaterThanOrEqual(2_000);
    expect(w.net.isOpen("c1")).toBe(true);
    expect(openWindows(w)).toBe(1);
  });

  test("an open net window survives a re-placement whose place did not change", () => {
    const w = world();
    w.frames("c1", 10, false);
    w.net.showNow("c1");
    const win = w.net.get("c1")!.win!;
    w.r.lost(10, false, "p:100:10");
    w.r.lost(10, true);
    expect(win.closed).toBe(false);
    expect(w.net.isOpen("c1")).toBe(true);
    expect(openWindows(w)).toBe(1);
  });

  test("a third-party frame reloading in the main window changes no card's count", () => {
    const w = world({ kind: "strip", program: "code", window: "main" });
    w.frames("a", MAIN, true, 5);
    w.frames("b", MAIN, true, 6);
    for (let i = 0; i < 20; i++) w.r.lost(MAIN, false, "p:100:99");
    expect(w.r.countOf("a")).toBe(0);
    expect(w.r.countOf("b")).toBe(0);
    expect(w.buttonsShown("a")).toBe(true);
    w.r.lost(MAIN, false, "p:100:5");
    expect(w.r.countOf("a")).toBe(1);
    expect(w.r.countOf("b")).toBe(0);
  });

  test("a card still in its conversation's beat (not placed yet) is left to the beat", () => {
    const w = world();
    w.sealed.fromCore(card("c2"));
    w.sealed.mint("c2", "button:a", { parent: { processId: 100, routingId: 10 } }, 10);
    w.r.lost(10, true);
    expect(w.r.countOf("c2")).toBe(0);
  });

  test("two closes in a row: each is placed again once", () => {
    const w = world();
    w.frames("c1", 10);
    w.frames("c1", 11);
    w.r.lost(10, true);
    w.r.lost(11, true);
    expect(w.r.countOf("c1")).toBe(2);
    expect(w.net.has("c1")).toBe(true);
  });

  test("a reload clears the marks of the document that loaded again only: the net then runs", () => {
    const w = world();
    w.frames("c1", 10);
    w.r.lost(10, false, "p:100:10");
    expect(w.buttonsShown("c1")).toBe(false);
    expect(w.net.has("c1")).toBe(true);
  });

  test("generated sequences: from the moment its buttons stop showing the card has a deadline within 2 s of it, and the net really draws it then; never two places", () => {
    let seed = 987654;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const store = (w: ReturnType<typeof world>) => (w.sealed as unknown as { channels: Map<string, { cardId: string; windowId?: number; element: string }> }).channels;
    for (let run = 0; run < 60; run++) {
      const w = world();
      w.frames("c", 10, false);
      let hiddenSince: number | undefined = w.now();
      const trace: string[] = [];
      for (let step = 0; step < 80; step++) {
        const win = [10, 11, 12][rnd(3)]!;
        const op = rnd(7);
        trace.push(`${op}@${win}`);
        switch (op) {
          case 0: w.frames("c", win, false); break; // a surface opens (again)
          case 1: w.r.lost(win, true); break;
          case 2: w.r.lost(win, false, `p:100:${win}`); break; // its own document reloads
          case 3: w.r.lost(win, false, `p:100:${50 + rnd(5)}`); break; // some other document's reload
          case 4: case 5: if (w.tokens.length > 0) w.report(w.tokens[rnd(w.tokens.length)]!, rnd(2) === 0); break; // live or gone frames report
          default: w.advance(rnd(700)); // time passes: timers fire on their own
        }
        const shown = w.buttonsShown("c");
        // Independent of the ops and of the code under test: both buttons visible in an island window, read off the raw channels.
        const seen = new Set<string>();
        for (const [t, c] of store(w)) if (c.cardId === "c" && c.element.startsWith("button:") && w.sealed.isTokenVisible(t) && c.windowId !== undefined && ISLAND.has(c.windowId)) seen.add(c.element);
        expect(shown).toBe(seen.size === 2);
        if (shown) hiddenSince = undefined;
        else {
          hiddenSince ??= w.now();
          // Shown nowhere: its timer's deadline is no later than 2 s after it stopped showing, or the card's own window is open.
          const e = w.net.get("c");
          if (e === undefined) console.log(trace.join(" "));
          expect(e !== undefined).toBe(true);
          if (!w.net.isOpen("c")) {
            expect(w.net.isLive("c")).toBe(true);
            const deadline = w.timersOf().filter((at) => at > 0).sort((x, y) => x - y)[0];
            expect(deadline === undefined || deadline <= hiddenSince + 2_000).toBe(true);
          }
        }
        if (w.now() - (hiddenSince ?? w.now()) > 2_000 && !shown) expect(w.net.isOpen("c")).toBe(true);
        expect(shown && w.net.isOpen("c")).toBe(false);
        expect(openWindows(w)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("a press from a window that has closed", () => {
  test("is refused; one from an open window, or a frame minted for no window, is not", () => {
    const live = new Set([1, 10]);
    expect(pressWindowIsOpen(11, (id) => live.has(id))).toBe(false);
    expect(pressWindowIsOpen(10, (id) => live.has(id))).toBe(true);
    expect(pressWindowIsOpen(undefined, () => false)).toBe(true);
  });
});
