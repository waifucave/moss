// The canvas as one circuit (the owner, 2026-11-21: "i want like a unified effect"): a block's outline and the lines
// between blocks are the same wire, the points are junctions on it, and ONE light lives on it (light.ts). Pure: the
// paths and the times; the view moves the light along them with CSS only.
//
// * Running: the light circulating on the block's own loop (`loop`), at the light's one speed.
// * A message: the same light on ONE path made of the sender's outline up to its point, the line, and the receiver's
//   outline from its point on (`trip`). From a running sender it starts where the sender's own light is at that moment,
//   so the circulating light is seen to take the branch (the loop keeps circulating). From an idle one it gathers half
//   way round its loop and runs to the point. At the receiver it either becomes the receiver's own circulating light
//   (`handover`: the path ends at the point, where the receiver's loop light starts at that moment) or laps the
//   receiver's loop once, its colour turning into the receiver's, easing out to nothing (an idle receiver; a waiting
//   one, over its dashes; one already running, joining its light).
import { LIGHT_LENGTH, LIGHT_SPEED } from "./light";
import type { Point, Rect } from "./layout";
import type { Port } from "./Block";

/** The corner radius of a block's outline (`--moss-radius-large`, 12px; a bot's 14px). */
export const OUTLINE_RADIUS = 12;

export function perimeter(r: Rect, radius = OUTLINE_RADIUS): number {
  return 2 * (r.w - 2 * radius) + 2 * (r.h - 2 * radius) + 2 * Math.PI * radius;
}

/** Where a block's point sits along its outline: arc length from the top middle, clockwise. */
export function portDistance(r: Rect, port: Port, radius = OUTLINE_RADIUS): number {
  const arc = (Math.PI * radius) / 2;
  const right = r.w / 2 - radius + arc + (r.h / 2 - radius);
  const bottom = right + (r.h / 2 - radius) + arc + (r.w / 2 - radius);
  const left = bottom + (r.w / 2 - radius) + arc + (r.h / 2 - radius);
  return port === "t" ? 0 : port === "r" ? right : port === "b" ? bottom : left;
}

/** The point at arc length `s` round the outline (any real number). */
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

/** Points along the outline from arc length `from`, `length` px clockwise, one every ~3px. */
function outlinePoints(r: Rect, from: number, length: number, radius: number): Point[] {
  const steps = Math.max(1, Math.ceil(length / 3));
  return Array.from({ length: steps + 1 }, (_, i) => outlinePoint(r, from + (length * i) / steps, radius));
}

const n = (v: number) => Math.round(v * 10) / 10;
const pathOf = (pts: readonly Point[]) => `M${pts.map((p) => `${n(p.x)},${n(p.y)}`).join(" L")}`;
const lengthOf = (pts: readonly Point[]) => pts.slice(1).reduce((a, p, i) => a + Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y), 0);

/** A block's own loop: its whole outline from the top middle, clockwise, closed. */
export function loopPath(r: Rect, radius = OUTLINE_RADIUS): { d: string; length: number } {
  const pts = outlinePoints(r, 0, perimeter(r, radius), radius);
  return { d: `${pathOf(pts)} Z`, length: perimeter(r, radius) };
}

/** Where the running light's head is after `seconds` on a loop it started on with its head at `start` (arc length). */
export function headAfter(r: Rect, start: number, seconds: number, radius = OUTLINE_RADIUS): number {
  const P = perimeter(r, radius);
  return (((start + seconds * LIGHT_SPEED) % P) + P) % P;
}

export interface TripInput {
  /** The sender: its block, its point, and where its running light's head is now (absent: it isn't running). */
  sender?: { rect: Rect; port: Port; radius?: number; head?: number };
  /** The line from the sender's point to the receiver's: its points in order (absent for the person's message). */
  line?: readonly Point[];
  /** The receiver; `handover` when its own running light starts with this message. */
  receiver: { rect: Rect; port: Port; radius?: number; handover: boolean };
}

export interface Trip {
  /** The one path the light walks, and its length. */
  d: string;
  length: number;
  /** How far the light moves, px: off the path's end (a lap that fades), or until its head reaches it (a handover, where
   *  the whole light is on the receiver's loop and the receiver's own light takes its place, on the same spot). */
  travel: number;
  /** Seconds from the trip's start: the head at the sender's point, at the receiver's point, and the light gone. */
  depart: number;
  arrive: number;
  end: number;
  /** The light gathers (fades in) over its first seconds: an idle sender's lap, or the person's message coming in. */
  gather: number;
  /** A lap that fades: from the arrival, over the lap, to nothing. */
  fade?: { at: number; dur: number };
  handover: boolean;
  /** For a handover: where the receiver's own light's head starts (arc length round its loop) and when. */
  loopStart?: { at: number; delay: number };
  /** The points it passes, and when its head is at each. */
  dots: { role: "sender" | "receiver"; at: Point; time: number }[];
  /** The three parts of the path apart, for reduced motion's highlight of each in turn (no travel). */
  parts: { kind: "sender" | "line" | "receiver"; d: string; time: number }[];
}

/** A message's trip, all at the light's one speed. */
export function trip(t: TripInput): Trip {
  const pts: Point[] = [];
  const parts: Trip["parts"] = [];
  let depart = 0;
  let gather = LIGHT_LENGTH / LIGHT_SPEED;
  let senderDot: Point | undefined;
  if (t.sender !== undefined && t.line !== undefined) {
    const sr = t.sender.radius ?? OUTLINE_RADIUS;
    const P = perimeter(t.sender.rect, sr);
    const sp = portDistance(t.sender.rect, t.sender.port, sr);
    // Running: from where its own light's head is, clockwise to the point (the light takes the branch as it passes).
    // Idle: one lap round its loop, gathering as it goes.
    let run = t.sender.head === undefined ? P : (((sp - t.sender.head) % P) + P) % P;
    if (run < 4) run += P;
    const onSender = outlinePoints(t.sender.rect, sp - run, run, sr);
    pts.push(...onSender);
    parts.push({ kind: "sender", d: pathOf(onSender), time: 0 });
    depart = run / LIGHT_SPEED;
    gather = t.sender.head === undefined ? depart : 0;
    senderDot = onSender[onSender.length - 1]!;
    pts.push(...t.line.slice(1));
    parts.push({ kind: "line", d: pathOf(t.line), time: depart });
  }
  const rr = t.receiver.radius ?? OUTLINE_RADIUS;
  const RP = perimeter(t.receiver.rect, rr);
  const rp = portDistance(t.receiver.rect, t.receiver.port, rr);
  const receiverDot = outlinePoint(t.receiver.rect, rp, rr);
  const before = lengthOf(pts);
  const arrive = before / LIGHT_SPEED;
  // On the receiver: the light's own length (then the receiver's light is it), or a whole lap that fades.
  const onReceiver = outlinePoints(t.receiver.rect, rp, t.receiver.handover ? LIGHT_LENGTH : RP, rr);
  if (pts.length === 0) pts.push(onReceiver[0]!);
  pts.push(...onReceiver.slice(1));
  parts.push({ kind: "receiver", d: pathOf(outlinePoints(t.receiver.rect, rp, RP, rr)), time: arrive });
  const length = lengthOf(pts);
  const travel = t.receiver.handover ? length : length + LIGHT_LENGTH;
  const dots: Trip["dots"] = [];
  if (senderDot !== undefined) dots.push({ role: "sender", at: senderDot, time: depart });
  dots.push({ role: "receiver", at: receiverDot, time: arrive });
  return {
    d: pathOf(pts),
    length,
    travel,
    depart,
    arrive,
    end: travel / LIGHT_SPEED,
    gather,
    ...(t.receiver.handover ? {} : { fade: { at: arrive, dur: (length - before) / LIGHT_SPEED } }),
    handover: t.receiver.handover,
    ...(t.receiver.handover ? { loopStart: { at: (rp + LIGHT_LENGTH) % RP, delay: length / LIGHT_SPEED } } : {}),
    dots,
    parts,
  };
}

/** Which part of the path the light's head is on at `seconds` (or "gone" once it has run off the end). */
export function headOn(tr: Trip, seconds: number): "sender" | "line" | "receiver" | "gone" {
  const at = seconds * LIGHT_SPEED;
  if (at >= tr.length) return "gone";
  if (at < tr.depart * LIGHT_SPEED) return "sender";
  if (at < tr.arrive * LIGHT_SPEED) return "line";
  return "receiver";
}
