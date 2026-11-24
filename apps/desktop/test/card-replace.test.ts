// A pending card whose place goes away (card-replace.ts), over the real sealed store and a fake clock for the net's deadline.
import { describe, expect, test } from "bun:test";
import { windowShowsCard, pressWindowIsOpen } from "../src/main/card-place";
import { CardReplacer, MAX_REPLACEMENTS } from "../src/main/card-replace";
import { SealedFrames, type SealedCard } from "../src/main/sealed";

const card = (id: string): SealedCard => ({ id, kind: "tool", computer: "Studio", origin: "user", issuedAt: 0, expiresAt: null, hash: "a".repeat(64), fields: {}, options: [{ id: "a", kind: "approve", label: "A" }, { id: "d", kind: "deny", label: "D" }] });
const ISLAND = new Set([10, 11, 12]);

function world(placed: { kind: "island" } | { kind: "strip"; program: "code"; window: string } = { kind: "island" }) {
  const sealed = new SealedFrames();
  let now = 0;
  const deadlines = new Map<string, number>();
  const fallbackWindow = new Set<string>();
  const places = new Map<string, number>();
  const placedAt = new Set<string>();
  const log: string[] = [];
  const shown: string[] = [];
  const buttonsShown = (id: string) => sealed.buttonsVisible(id, (w) => windowShowsCard(placed, w !== undefined && ISLAND.has(w)));
  const r = new CardReplacer({
    cardsIn: (w, closed, doc) => sealed.windowGone(w, closed, doc),
    isPending: (id) => sealed.isPending(id),
    arrived: () => true,
    placedOnce: (id) => placedAt.has(id),
    place: (id) => { places.set(id, (places.get(id) ?? 0) + 1); },
    restack: () => undefined,
    engineplace: () => placed,
    front: () => false,
    drawnInWindow: () => false,
    buttonsShown,
    fallbackHere: () => true,
    fallbackRunning: (id) => deadlines.has(id),
    fallbackWindowOpen: (id) => fallbackWindow.has(id),
    // The real armFallback restarts the deadline: a re-placement that calls it while one runs moves it.
    armFallback: (id) => { deadlines.set(id, now + 2_000); },
    showFallbackNow: (id) => { shown.push(id); fallbackWindow.add(id); deadlines.delete(id); },
    log: (l) => log.push(l),
  });
  const frames = (id: string, win: number, visible = true) => {
    sealed.fromCore(card(id));
    placedAt.add(id);
    const f = { parent: { processId: 100, routingId: win } };
    for (const e of ["button:a", "button:d"]) sealed.markVisible(sealed.mint(id, e, f, win)!.token, visible);
  };
  return { sealed, r, deadlines, places, log, shown, fallbackWindow, frames, buttonsShown, tick: (ms: number) => { now += ms; }, now: () => now };
}

describe("a place going away", () => {
  for (const [name, win] of [["the bundled island", 10], ["a copy of the island", 11], ["the pill", 12]] as const) {
    test(`${name} closing: the card is placed again once and the net's timer runs`, () => {
      const w = world();
      w.frames("c1", win);
      w.r.lost(win, true);
      expect(w.places.get("c1")).toBe(1);
      expect(w.deadlines.get("c1")).toBe(2_000);
      expect(w.log.filter((l) => l.includes("placed again"))).toHaveLength(1);
    });
  }

  test("another surface still shows the buttons: placed again, but no timer", () => {
    const w = world();
    w.frames("c1", 10);
    w.frames("c1", 11);
    w.r.lost(10, true);
    expect(w.places.get("c1")).toBe(1);
    expect(w.deadlines.has("c1")).toBe(false);
  });

  test("a running deadline is never moved by a re-placement", () => {
    const w = world();
    w.frames("c1", 10, false);
    w.deadlines.set("c1", 2_000);
    w.tick(1_500);
    w.r.lost(10, false);
    w.r.lost(10, false);
    expect(w.deadlines.get("c1")).toBe(2_000);
  });

  test("a document reloading every second can't hold the net back: the deadline stands through every re-placement, and past the cap the net draws the card", () => {
    const w = world();
    w.frames("c1", 10, false);
    w.deadlines.set("c1", 2_000);
    for (let i = 0; i < MAX_REPLACEMENTS; i++) { w.tick(150); w.r.lost(10, false); expect(w.deadlines.get("c1")).toBe(2_000); }
    w.tick(150);
    w.r.lost(10, false);
    expect(w.shown).toEqual(["c1"]);
  });

  test("a reload or close in an unrelated window leaves the other cards alone", () => {
    const w = world();
    w.frames("a", 10);
    w.frames("b", 11);
    w.r.lost(10, false);
    w.r.lost(12, true);
    expect(w.places.get("a")).toBe(1);
    expect(w.places.get("b")).toBeUndefined();
    expect(w.log).toHaveLength(1);
  });

  test("a card still in its conversation's beat (not placed yet) is left to the beat", () => {
    const w = world();
    w.frames("c1", 10);
    w.r.lost(10, false);
    const w2 = world();
    w2.sealed.fromCore(card("c2"));
    w2.sealed.mint("c2", "button:a", { parent: { processId: 1, routingId: 10 } }, 10);
    w2.r.lost(10, false);
    expect(w2.places.get("c2")).toBeUndefined();
  });

  test("two closes in a row: each is placed once, the second names only the second window's card", () => {
    const w = world();
    w.frames("c1", 10);
    w.frames("c1", 11);
    w.r.lost(10, true);
    w.r.lost(11, true);
    expect(w.places.get("c1")).toBe(2);
    expect(w.deadlines.get("c1")).toBe(2_000);
  });

  test(`at most ${MAX_REPLACEMENTS} re-placements: the next goes straight to the net, once, and nothing moves the card after`, () => {
    expect(MAX_REPLACEMENTS).toBeLessThanOrEqual(8);
    const w = world();
    w.frames("c1", 10, false);
    for (let i = 0; i < MAX_REPLACEMENTS + 5; i++) { w.frames("c1", 10, false); w.r.lost(10, false); }
    expect(w.places.get("c1")).toBe(MAX_REPLACEMENTS);
    expect(w.shown).toEqual(["c1"]);
    w.r.forget("c1");
    expect(w.r.countOf("c1")).toBe(0);
  });

  test("the cap never opens the net over buttons that show", () => {
    const w = world();
    w.frames("c1", 10, true);
    for (let i = 0; i < MAX_REPLACEMENTS + 3; i++) w.r.lost(10, false);
    expect(w.shown).toEqual([]);
  });

  test("a reload clears the marks of the document that loaded again (its page never said it left): the net then runs", () => {
    const w = world();
    w.frames("c1", 10);
    expect(w.buttonsShown("c1")).toBe(true);
    w.r.lost(10, false, "p:100:10");
    expect(w.buttonsShown("c1")).toBe(false);
    expect(w.deadlines.get("c1")).toBe(2_000);
  });

  test("never two places at once over a generated sequence of closes, reloads and visibility reports", () => {
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let run = 0; run < 40; run++) {
      const w = world();
      w.sealed.fromCore(card("c"));
      const open = new Set<number>();
      const mintIn = (win: number) => { w.frames("c", win, false); open.add(win); };
      mintIn(10);
      for (let step = 0; step < 40; step++) {
        const win = [10, 11, 12][rnd(3)]!;
        const op = rnd(5);
        if (op === 0) { w.r.lost(win, true); open.delete(win); }
        else if (op === 1) w.r.lost(win, false, `p:100:${win}`);
        else if (op === 2) mintIn(win);
        else if (op === 3) {
          // The page reports both buttons visible; the app drops the net, as `sealedVisible` does.
          for (const t of (w.sealed as unknown as { channels: Map<string, { windowId?: number }> }).channels.keys()) if ((w.sealed as unknown as { channels: Map<string, { windowId?: number }> }).channels.get(t)!.windowId === win) w.sealed.markVisible(t, true);
          if (w.buttonsShown("c")) { w.deadlines.delete("c"); w.fallbackWindow.delete("c"); }
        } else w.tick(300);
        expect(w.fallbackWindow.has("c") && w.buttonsShown("c")).toBe(false);
        expect(w.places.get("c") ?? 0).toBeLessThanOrEqual(MAX_REPLACEMENTS);
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
