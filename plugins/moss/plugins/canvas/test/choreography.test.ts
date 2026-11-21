import { describe, expect, test } from "bun:test";
import { headAfter, headOn, loopPath, outlinePoint, perimeter, portDistance, trip, type TripInput } from "../client/choreography";
import { brightnessAt, glowPiece, LIGHT_LENGTH, LIGHT_PROFILE, LIGHT_SPEED, lightPieces, RING_SECONDS, STANDARD_PERIMETER } from "../client/light";
import { SIZE, type Point, type Rect } from "../client/layout";

const A: Rect = { x: 0, y: 0, ...SIZE.main };
const B: Rect = { x: 400, y: 0, ...SIZE.main };
const line: Point[] = Array.from({ length: 25 }, (_, i) => ({ x: A.w + (i / 24) * (B.x - A.w), y: A.h / 2 }));
const base = (over: Partial<TripInput> = {}): TripInput => ({ sender: { rect: A, port: "r" }, line, receiver: { rect: B, port: "l", handover: false }, ...over });
const at = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y);

describe("the one light", () => {
  test("its speed is the running light's: once round a standard block in RING_SECONDS, on a border and a line alike", () => {
    expect(STANDARD_PERIMETER).toBeCloseTo(perimeter(A), 6);
    expect(LIGHT_SPEED * RING_SECONDS).toBeCloseTo(perimeter(A), 6);
  });

  test("its dashes cover the whole light end to end, tail to head, at the profile's brightness, in small steps", () => {
    const pieces = lightPieces();
    // Contiguous: each dash's head end is the next one's tail end.
    for (let i = 0; i < pieces.length - 1; i++) expect(pieces[i]!.back).toBeCloseTo(pieces[i + 1]!.back + pieces[i + 1]!.length, 6);
    expect(pieces[pieces.length - 1]!.back).toBeCloseTo(0, 6);
    // No hard step: neighbouring dashes differ by little.
    for (let i = 0; i < pieces.length - 1; i++) expect(Math.abs(pieces[i]!.a - pieces[i + 1]!.a)).toBeLessThan(0.2);
    // Faint at the tail, brightest just behind the head, soft at the head.
    expect(pieces[0]!.a).toBeLessThan(0.05);
    expect(Math.max(...pieces.map((p) => p.a))).toBeGreaterThan(0.9);
    expect(pieces[pieces.length - 1]!.a).toBeLessThan(0.5);
    // Its colour turns from the first to the second, never back.
    for (let i = 0; i < pieces.length - 1; i++) expect(pieces[i + 1]!.mix).toBeGreaterThanOrEqual(pieces[i]!.mix);
    expect(brightnessAt(LIGHT_PROFILE[3]!.at)).toBe(1);
    const g = glowPiece();
    expect(g.back + g.length).toBeLessThanOrEqual(LIGHT_LENGTH);
  });
});

describe("the wire", () => {
  test("a point's place on the outline is where the point is drawn", () => {
    expect(at(outlinePoint(A, portDistance(A, "t")), { x: A.w / 2, y: 0 })).toBeLessThan(0.01);
    expect(at(outlinePoint(A, portDistance(A, "r")), { x: A.w, y: A.h / 2 })).toBeLessThan(0.01);
    expect(at(outlinePoint(A, portDistance(A, "b")), { x: A.w / 2, y: A.h })).toBeLessThan(0.01);
    expect(at(outlinePoint(A, portDistance(A, "l")), { x: 0, y: A.h / 2 })).toBeLessThan(0.01);
  });

  test("a loop is the whole outline, closed; its light's head moves at the one speed and wraps", () => {
    const loop = loopPath(A);
    expect(loop.length).toBeCloseTo(perimeter(A), 6);
    expect(loop.d.endsWith("Z")).toBe(true);
    expect(headAfter(A, 0, RING_SECONDS)).toBeCloseTo(0, 6);
    expect(headAfter(A, 10, 1)).toBeCloseTo(10 + LIGHT_SPEED, 6);
  });
});

describe("a message's trip: one light on one path", () => {
  test("from a running sender it starts where the sender's own light is, so that light is seen to take the branch", () => {
    const sp = portDistance(A, "r");
    const t = trip(base({ sender: { rect: A, port: "r", head: sp - 100 } }));
    expect(t.depart).toBeCloseTo(100 / LIGHT_SPEED, 1);
    expect(t.gather).toBe(0);
    // Its path begins on the sender's outline where its light's head is.
    const [x, y] = t.d.slice(1).split(" L")[0]!.split(",").map(Number) as [number, number];
    expect(at({ x, y }, outlinePoint(A, sp - 100))).toBeLessThan(1);
  });

  test("from an idle sender the light gathers as it laps the sender's loop once, then leaves through its point", () => {
    const t = trip(base());
    expect(t.depart).toBeCloseTo(perimeter(A) / LIGHT_SPEED, 1);
    expect(t.gather).toBe(t.depart);
  });

  test("its head passes the sender's point, then the receiver's, at the one speed: no stop and no jump", () => {
    const t = trip(base());
    const lineLength = B.x - A.w;
    expect(t.arrive - t.depart).toBeCloseTo(lineLength / LIGHT_SPEED, 2);
    expect(headOn(t, t.depart / 2)).toBe("sender");
    expect(headOn(t, (t.depart + t.arrive) / 2)).toBe("line");
    expect(headOn(t, t.arrive + 0.05)).toBe("receiver");
    expect(t.dots.map((d) => [d.role, Math.round(d.time * 1000)])).toEqual([["sender", Math.round(t.depart * 1000)], ["receiver", Math.round(t.arrive * 1000)]]);
    // The path is one continuous line: no gap between neighbouring points longer than a step.
    const pts = t.d.slice(1).split(" L").map((s) => s.split(",").map(Number) as [number, number]);
    for (let i = 1; i < pts.length; i++) expect(Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1])).toBeLessThan(18);
  });

  test("to an idle (or waiting, or already running) receiver: one lap of its loop that eases out to nothing", () => {
    const t = trip(base());
    expect(t.handover).toBe(false);
    expect(t.length - t.arrive * LIGHT_SPEED).toBeCloseTo(perimeter(B), 0);
    // Faded out by the time its head comes round to the point again; gone off the path's end after.
    expect(t.fade!.at).toBe(t.arrive);
    expect(t.fade!.at + t.fade!.dur).toBeCloseTo(t.length / LIGHT_SPEED, 6);
    expect(t.travel).toBeCloseTo(t.length + LIGHT_LENGTH, 6);
  });

  test("to a receiver that starts running with it: the light runs wholly onto its loop, and its own light takes its place there", () => {
    const t = trip(base({ receiver: { rect: B, port: "l", handover: true } }));
    expect(t.fade).toBeUndefined();
    expect(t.travel).toBeCloseTo(t.length, 6);
    expect(t.length - t.arrive * LIGHT_SPEED).toBeCloseTo(LIGHT_LENGTH, 0);
    // The receiver's light starts with its head a light's length past the point, at the moment the message's head is there.
    const rp = portDistance(B, "l");
    expect(t.loopStart!.at).toBeCloseTo((rp + LIGHT_LENGTH) % perimeter(B), 6);
    expect(t.loopStart!.delay).toBeCloseTo(t.travel / LIGHT_SPEED, 6);
    const end = t.d.split(" L").pop()!.split(",").map(Number) as [number, number];
    expect(at({ x: end[0], y: end[1] }, outlinePoint(B, t.loopStart!.at))).toBeLessThan(1);
  });

  test("the person's message comes in at the receiver's point, gathering", () => {
    const t = trip({ receiver: { rect: B, port: "l", handover: false } });
    expect(t.arrive).toBe(0);
    expect(t.gather).toBeGreaterThan(0);
    expect(t.dots.map((d) => d.role)).toEqual(["receiver"]);
    expect(t.parts.map((p) => p.kind)).toEqual(["receiver"]);
  });

  test("reduced motion's parts: the sender's loop, the line, the receiver's loop, in turn", () => {
    const t = trip(base());
    expect(t.parts.map((p) => [p.kind, p.time])).toEqual([["sender", 0], ["line", t.depart], ["receiver", t.arrive]]);
  });
});
