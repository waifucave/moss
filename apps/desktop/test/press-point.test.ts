// A late answer is still cover-checked at its press's own point (press-point.ts, lane WA): the point is saved with the press when the page says
// "received", so an answer 2.5 s after the press (allowed now, up to 10 s) with a window over the button is refused as covered, and not
// taken for a keyboard press (overlap.ts: no point, no check).
import { describe, expect, test } from "bun:test";
import { PressPoints } from "../src/main/press-point";
import { pressCover, type OsWindow } from "../src/main/overlap";
import { PRESS_BOUND_MS } from "../src/main/press-bound";
import { pressMayBeTaken } from "../src/main/card-place";

const LOAD = "a1b2c3d4e5f60718293a4b5c";
const ref = (n: number) => ({ load: LOAD, n });
const OURS = 4242;
const over: OsWindow = { id: 9, x: 0, y: 0, width: 400, height: 300, layer: 0, alpha: 1, pid: OURS };
const ours = (pid: number) => pid === OURS;

describe("the press's point goes with the press", () => {
  test("an answer 2.5 s after the press, a window over the button: refused as covered (the old 2 s mouse-down rule found no point and skipped the check)", () => {
    const points = new PressPoints();
    const downAt = 10_000;
    const down = { x: 40, y: 60, at: downAt };
    points.save("tok", ref(1), down, downAt + 30); // "received" 30 ms after the mouse-down
    const answerAt = downAt + 2_500;
    // What osCoverOf did before: the window's latest mouse-down only if at most 2 s old.
    const old = answerAt - down.at <= 2_000 ? { x: down.x, y: down.y } : undefined;
    expect(pressCover({ point: old, above: [over], ours })).toBeUndefined();
    // Now: the point saved with the press.
    const point = points.pointOf("tok", ref(1));
    expect(point).toEqual({ x: 40, y: 60 });
    expect(pressCover({ point, above: [over], ours })?.id).toBe(9);
    // And an answer at the press's own bound is still checked at it.
    expect(points.pointOf("tok", ref(1))).toEqual({ x: 40, y: 60 });
    expect(PRESS_BOUND_MS).toBe(10_000);
  });

  test("a press that really had no pointer event keeps the keyboard-press rule; so does a mouse-down too old to be its own", () => {
    const points = new PressPoints();
    points.save("key", ref(1), undefined, 5_000);
    expect(points.pointOf("key", ref(1))).toBeUndefined();
    points.save("old", ref(1), { x: 1, y: 2, at: 1_000 }, 5_000); // 4 s old at "received": an earlier click, not this press
    expect(points.pointOf("old", ref(1))).toBeUndefined();
  });

  test("each press keeps its own point: a newer press, another press's number, another load, an unheard press and an older \"received\" change nothing", () => {
    const points = new PressPoints();
    points.save("tok", ref(1), { x: 1, y: 1, at: 100 }, 120);
    points.save("tok", ref(2), { x: 9, y: 9, at: 200 }, 220);
    expect(points.pointOf("tok", ref(1))).toBeUndefined();
    expect(points.pointOf("tok", ref(2))).toEqual({ x: 9, y: 9 });
    points.save("tok", ref(2), { x: 5, y: 5, at: 300 }, 320); // replayed "received": rewrites nothing
    points.save("tok", ref(1), { x: 5, y: 5, at: 300 }, 320); // older number: rewrites nothing
    expect(points.pointOf("tok", ref(2))).toEqual({ x: 9, y: 9 });
    expect(points.pointOf("tok", { load: "0f1e2d3c4b5a69788796a5b4", n: 2 })).toBeUndefined();
    expect(points.pointOf("tok", undefined)).toBeUndefined();
    expect(points.pointOf("other", ref(2))).toBeUndefined();
  });

  test("it remembers a bounded number of tokens", () => {
    const points = new PressPoints();
    for (let i = 0; i < 1_000; i++) points.save(`t${i}`, ref(1), { x: i, y: i, at: 0 }, 0);
    expect(points.pointOf("t0", ref(1))).toBeUndefined();
    expect(points.pointOf("t999", ref(1))).toEqual({ x: 999, y: 999 });
  });
});

describe("the placement is read when the answer arrives, never at the press", () => {
  test("a card moved to the window (or the island) between a press and its late answer refuses the answer", () => {
    // At the press the card was on the island: an island press was taken. The answer arrives seconds later (allowed up to the press's bound)
    // and is judged against the placement then: the router has since put the card in the window.
    expect(pressMayBeTaken({ from: "island", placed: { kind: "island" }, front: false })).toBe(true);
    expect(pressMayBeTaken({ from: "island", placed: { kind: "strip", program: "code", window: "main" }, front: false })).toBe(false);
    expect(pressMayBeTaken({ from: "window", placed: { kind: "island" }, front: false })).toBe(false);
  });
});
