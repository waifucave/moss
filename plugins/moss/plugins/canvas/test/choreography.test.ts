import { describe, expect, test } from "bun:test";
import { choreograph, CREST, LEAVE_LENGTH, litAt, outlinePoint, portAngle, portDistance, ringStart, RING_CREST_DEG, SPEED, type Choreography, type TripInput } from "../client/choreography";
import { curve, curveLength, portAt } from "../client/Canvas";
import type { Rect } from "../client/layout";

const A: Rect = { x: 48, y: 48, w: 252, h: 86 };
const B: Rect = { x: 420, y: 160, w: 252, h: 86 };
const close = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y) < 0.6;

function trip(running: boolean): Choreography {
  const from = portAt(A, "r");
  const to = portAt(B, "l");
  const input: TripInput = {
    sender: { rect: A, port: "r" },
    receiver: { rect: B, port: "l", running },
    line: { d: curve(from, "r", to, "l"), length: curveLength(from, "r", to, "l"), from, to },
  };
  return choreograph(input);
}

/** Where each lit stretch starts and ends in the world, to check that the light is one connected piece. */
function litEnds(c: Choreography, t: number) {
  return litAt(c, t).map((l) => ({ ...l, seg: c.segments.find((s) => s.kind === l.kind)! }));
}

describe("a message's trip", () => {
  test("the outline: a point's distance and the point there agree, all four sides", () => {
    for (const port of ["t", "r", "b", "l"] as const) expect([port, close(outlinePoint(A, portDistance(A, port)), portAt(A, port))]).toEqual([port, true]);
  });

  test("its order: the sender's outline, its point, the line, the receiver's point, the receiver's outline both ways", () => {
    const c = trip(false);
    expect(c.segments.map((s) => s.kind)).toEqual(["leave", "line", "arrive-cw", "arrive-ccw"]);
    const [leave, line, cw, ccw] = c.segments;
    expect(leave!.delay).toBe(0);
    expect(line!.delay).toBeCloseTo(LEAVE_LENGTH / SPEED, 6);
    expect(cw!.delay).toBeCloseTo((LEAVE_LENGTH + line!.length) / SPEED, 6);
    expect(ccw!.delay).toBe(cw!.delay);
    // The dots fill as the crest passes through them: the sender's as it leaves the outline, the receiver's as it
    // reaches the end of the line.
    expect(c.dots.map((d) => [d.role, d.delay])).toEqual([["sender", line!.delay], ["receiver", cw!.delay]]);
    expect(close(c.dots[0]!.at, portAt(A, "r"))).toBe(true);
    expect(close(c.dots[1]!.at, portAt(B, "l"))).toBe(true);
    // Only the arrival turns from the sender's colour into the receiver's.
    expect(c.segments.map((s) => s.morph)).toEqual([false, false, true, true]);
    // About as long as the wave was.
    expect(c.total).toBeGreaterThan(1.2);
    expect(c.total).toBeLessThan(2.6);
  });

  test("the light is never in two unconnected places: at every moment its lit stretches meet end to end", () => {
    for (const c of [trip(false), trip(true)]) {
      for (let t = 0; t <= c.total; t += 0.01) {
        const lit = litEnds(c, t);
        const length = lit.reduce((a, l) => a + (l.to - l.from), 0);
        expect(length).toBeLessThanOrEqual(CREST * 2 + 0.5);
        // A stretch lit at its start meets one lit at its end: the sender's outline into the line, the line into each
        // arrival half (the halves meet each other at the receiver's point).
        for (const l of lit) {
          if (l.from > 0.5 || l.kind === "leave") continue;
          const before = l.kind === "line" ? "leave" : "line";
          if (litAt(c, t).some((x) => x.kind === before)) expect(lit.find((x) => x.kind === before)!.to).toBeGreaterThan(lit.find((x) => x.kind === before)!.seg.length - 0.5);
        }
        const kinds = new Set(lit.map((l) => l.kind));
        if (kinds.has("leave") && !kinds.has("line")) expect(lit.find((l) => l.kind === "leave")!.to).toBeLessThanOrEqual(LEAVE_LENGTH + 0.5);
        expect(kinds.has("leave") && (kinds.has("arrive-cw") || kinds.has("arrive-ccw"))).toBe(false);
      }
    }
  });

  test("a receiver that stays idle: both halves run on and meet on the far side, then nothing is lit", () => {
    const c = trip(false);
    expect(c.handover).toBeUndefined();
    const [, , cw, ccw] = c.segments;
    expect(close(outlinePoint(B, portDistance(B, "l") + cw!.length), outlinePoint(B, portDistance(B, "l") - ccw!.length))).toBe(true);
    expect(litAt(c, c.total + 0.01)).toEqual([]);
  });

  test("a running receiver takes the light as its own: its running light starts at the arrival point when the crest arrives", () => {
    const c = trip(true);
    expect(c.segments.map((s) => s.kind)).toEqual(["leave", "line", "arrive-ccw"]);
    expect(c.handover).toEqual({ angle: portAngle("l"), delay: c.segments[2]!.delay });
    // The turning layer starts so that its crest sits at the point: left is 270°.
    expect((ringStart(270) + RING_CREST_DEG) % 360).toBe(270);
    expect((ringStart(90) + RING_CREST_DEG) % 360).toBe(90);
  });

  test("the person's message: no sender, only the arrival at the receiver's left point", () => {
    const c = choreograph({ receiver: { rect: B, port: "l", running: false } });
    expect(c.segments.map((s) => [s.kind, s.delay])).toEqual([["arrive-cw", 0], ["arrive-ccw", 0]]);
    expect(c.dots.map((d) => d.role)).toEqual(["receiver"]);
  });

  test("overlapping messages are independent trips; two on one line in opposite directions pass through each other", () => {
    const from = portAt(A, "r");
    const to = portAt(B, "l");
    const ab = choreograph({ sender: { rect: A, port: "r" }, receiver: { rect: B, port: "l", running: false }, line: { d: curve(from, "r", to, "l"), length: curveLength(from, "r", to, "l"), from, to } });
    const ba = choreograph({ sender: { rect: B, port: "l" }, receiver: { rect: A, port: "r", running: false }, line: { d: curve(to, "l", from, "r"), length: curveLength(to, "l", from, "r"), from: to, to: from } });
    const mid = (ab.segments[1]!.delay + ab.segments[1]!.duration / 2);
    expect(litAt(ab, mid).map((l) => l.kind)).toEqual(["line"]);
    expect(litAt(ba, mid).map((l) => l.kind)).toEqual(["line"]);
    expect(ab.segments[1]!.length).toBeCloseTo(ba.segments[1]!.length, 3);
  });
});
