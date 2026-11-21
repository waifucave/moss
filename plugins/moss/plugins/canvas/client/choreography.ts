// A message's trip on the canvas as ONE motion (the owner, 2026-11-21: "the animations should morph when the sent light
// arrives there instead of just that basic pulse in the dot"). Pure: what is drawn, where, and when; the view draws it
// with CSS animations only.
//
// The trip is one path walked by one bright crest at a constant speed, so it has no seam:
//   leave   a short stretch of the sender's own outline, running into its connection point;
//   (dot)   the sender's dot fills as the crest passes through it;
//   line    the line itself, from the sender's point to the receiver's;
//   (dot)   the receiver's dot fills as the crest passes through it;
//   arrive  from the receiver's point the light runs along its outline both ways, its colour morphing from the sender's
//           to the receiver's; the two halves meet on the far side and fade out.
// A receiver that is running takes the light as its own running light: only the counter-clockwise half runs, and its
// circling light starts at the connection point the moment the crest arrives (`handover`), turning on clockwise.
// The person's message has no sender on the canvas: only the arrival.
import type { Point, Rect } from "./layout";
import type { Port } from "./Block";

/** The corner radius of a block's outline (styles.css `--moss-radius-large`, 12px; a bot's 14px). */
export const OUTLINE_RADIUS = 12;
/** How much of the sender's outline lights before its point. */
export const LEAVE_LENGTH = 72;
/** The bright crest's length. */
export const CREST = 64;
/** The crest's speed, px a second: a usual trip (about 70 + 120 + 340 px) takes about 1.7 s, as the wave did. */
export const SPEED = 330;
/** Where the running light's crest sits on its turning layer (styles.css: its full colour from 80% to 92% of the turn). */
export const RING_CREST_DEG = 317;

export type SegmentKind = "leave" | "line" | "arrive-cw" | "arrive-ccw";

export interface Segment {
  kind: SegmentKind;
  /** The path the crest walks, in the world's pixels. */
  d: string;
  length: number;
  /** When the crest's head reaches its start, seconds from the trip's start, and how long until its tail leaves its end. */
  delay: number;
  duration: number;
  /** A colour run along it: from the sender's colour into the receiver's on the arrival. */
  from: Point;
  to: Point;
  morph: boolean;
}

export interface DotFlash {
  at: Point;
  /** "sender" or "receiver". */
  role: "sender" | "receiver";
  delay: number;
  duration: number;
}

export interface Choreography {
  segments: Segment[];
  dots: DotFlash[];
  /** For a running receiver: where its running light starts (the angle of the connection point from the block's centre,
   *  clockwise from the top, as its turning layer counts) and when (the crest's arrival). */
  handover?: { angle: number; delay: number };
  /** When the last of it has left the canvas. */
  total: number;
}

// ---- A rounded rectangle's outline, walked from its top middle, clockwise ----

function perimeter(r: Rect, radius: number): number {
  return 2 * (r.w - 2 * radius) + 2 * (r.h - 2 * radius) + 2 * Math.PI * radius;
}

/** Where a block's point sits along its outline (arc length from the top middle, clockwise). */
export function portDistance(r: Rect, port: Port, radius = OUTLINE_RADIUS): number {
  const arc = (Math.PI * radius) / 2;
  const right = r.w / 2 - radius + arc + (r.h / 2 - radius);
  const bottom = right + (r.h / 2 - radius) + arc + (r.w / 2 - radius);
  const left = bottom + (r.w / 2 - radius) + arc + (r.h / 2 - radius);
  return port === "t" ? 0 : port === "r" ? right : port === "b" ? bottom : left;
}

/** The point at arc length `s` (any real number, taken round the outline). */
export function outlinePoint(r: Rect, s: number, radius = OUTLINE_RADIUS): Point {
  const P = perimeter(r, radius);
  let d = ((s % P) + P) % P;
  const arc = (Math.PI * radius) / 2;
  const hw = r.w / 2 - radius;
  const sw = r.h - 2 * radius;
  const fw = r.w - 2 * radius;
  const corner = (cx: number, cy: number, start: number, t: number): Point => {
    const a = start + (t / arc) * (Math.PI / 2);
    return { x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) };
  };
  const x0 = r.x;
  const y0 = r.y;
  const x1 = r.x + r.w;
  const y1 = r.y + r.h;
  if (d < hw) return { x: x0 + r.w / 2 + d, y: y0 };
  d -= hw;
  if (d < arc) return corner(x1 - radius, y0 + radius, -Math.PI / 2, d);
  d -= arc;
  if (d < sw) return { x: x1, y: y0 + radius + d };
  d -= sw;
  if (d < arc) return corner(x1 - radius, y1 - radius, 0, d);
  d -= arc;
  if (d < fw) return { x: x1 - radius - d, y: y1 };
  d -= fw;
  if (d < arc) return corner(x0 + radius, y1 - radius, Math.PI / 2, d);
  d -= arc;
  if (d < sw) return { x: x0, y: y1 - radius - d };
  d -= sw;
  if (d < arc) return corner(x0 + radius, y0 + radius, Math.PI, d);
  d -= arc;
  return { x: x0 + radius + d, y: y0 };
}

/** A path along the outline from arc length `from` for `length` px, clockwise (`dir` 1) or counter-clockwise (-1). */
export function outlinePath(r: Rect, from: number, length: number, dir: 1 | -1, radius = OUTLINE_RADIUS): string {
  const steps = Math.max(2, Math.ceil(length / 4));
  const n = (v: number) => Math.round(v * 10) / 10;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const p = outlinePoint(r, from + dir * (length * i) / steps, radius);
    pts.push(`${n(p.x)},${n(p.y)}`);
  }
  return `M${pts[0]} L${pts.slice(1).join(" ")}`;
}

/** The angle of a point from the block's centre, clockwise from the top, as the turning layer counts. */
export function portAngle(port: Port): number {
  return port === "t" ? 0 : port === "r" ? 90 : port === "b" ? 180 : 270;
}

export interface TripInput {
  /** The sender's block and point; absent for the person's message. */
  sender?: { rect: Rect; port: Port; radius?: number };
  receiver: { rect: Rect; port: Port; radius?: number; running: boolean };
  /** The line between the two points and its length. */
  line?: { d: string; length: number; from: Point; to: Point };
}

/** The whole trip. Times are at `SPEED` px a second; a segment's crest is visible from when its head reaches the
 *  segment's start until its tail leaves the segment's end. */
export function choreograph(t: TripInput): Choreography {
  const segments: Segment[] = [];
  const dots: DotFlash[] = [];
  const time = (px: number) => px / SPEED;
  let at = 0;
  const seg = (kind: SegmentKind, d: string, length: number, start: number, from: Point, to: Point, morph: boolean) =>
    segments.push({ kind, d, length, delay: time(start), duration: time(length + CREST), from, to, morph });
  if (t.sender !== undefined && t.line !== undefined) {
    const sr = t.sender.radius ?? OUTLINE_RADIUS;
    const sp = portDistance(t.sender.rect, t.sender.port, sr);
    // The outline before the point, clockwise into it.
    seg("leave", outlinePath(t.sender.rect, sp - LEAVE_LENGTH, LEAVE_LENGTH, 1, sr), LEAVE_LENGTH, 0, outlinePoint(t.sender.rect, sp - LEAVE_LENGTH, sr), t.line.from, false);
    at = LEAVE_LENGTH;
    dots.push({ at: t.line.from, role: "sender", delay: time(at), duration: time(CREST) });
    seg("line", t.line.d, t.line.length, at, t.line.from, t.line.to, false);
    at += t.line.length;
  }
  const rr = t.receiver.radius ?? OUTLINE_RADIUS;
  const rp = portDistance(t.receiver.rect, t.receiver.port, rr);
  const half = perimeter(t.receiver.rect, rr) / 2;
  const portAt = outlinePoint(t.receiver.rect, rp, rr);
  const far = outlinePoint(t.receiver.rect, rp + half, rr);
  dots.push({ at: portAt, role: "receiver", delay: time(at), duration: time(CREST) });
  // Into the receiver's outline, both ways, its colour turning into the receiver's; a running receiver's clockwise
  // half is its own running light, which starts here.
  if (!t.receiver.running) seg("arrive-cw", outlinePath(t.receiver.rect, rp, half, 1, rr), half, at, portAt, far, true);
  seg("arrive-ccw", outlinePath(t.receiver.rect, rp, half, -1, rr), half, at, portAt, far, true);
  const total = Math.max(...segments.map((s) => s.delay + s.duration));
  return {
    segments,
    dots,
    ...(t.receiver.running ? { handover: { angle: portAngle(t.receiver.port), delay: time(at) } } : {}),
    total,
  };
}

/** What is lit at `t` seconds: each segment's lit stretch (arc lengths along it), and the dots lit. For the tests: the
 *  light is never in two unconnected places. */
export function litAt(c: Choreography, t: number): { kind: SegmentKind; from: number; to: number }[] {
  const out: { kind: SegmentKind; from: number; to: number }[] = [];
  for (const s of c.segments) {
    const head = (t - s.delay) * SPEED;
    const tail = head - CREST;
    const from = Math.max(0, tail);
    const to = Math.min(s.length, head);
    if (to > from) out.push({ kind: s.kind, from, to });
  }
  return out;
}

/** The rotation that puts the running light's crest at `angle` (the turning layer's start). */
export function ringStart(angle: number): number {
  return (((angle - RING_CREST_DEG) % 360) + 360) % 360;
}
