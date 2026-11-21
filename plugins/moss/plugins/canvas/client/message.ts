// A message crossing, over the blocks' own activity effect (the conic running light, the waiting dashes): the light on
// the line borrows the running light's look, and at each end the block's own effect reacts (the owner, 2026-11-21:
// "a pulse that morphs with the activity effect on arrival ... and on sending"). Three variants for the owner to choose
// from; the one he picks stays. Pure: what each part does and when; the view draws it with CSS only.
//
// * A, glow wave + ring swell: a soft stretch with the ring's glow runs the line; the sender's ring swells as it leaves,
//   the receiver's swells as it lands, in the sender's colour settling into its own.
// * B, the ring's light on the line: a bright head with a soft tail, the running light's own highlight, leaves as the
//   sender's circling highlight passes its point (an idle sender's outline flashes softly first), and is absorbed at the
//   receiver's point, whose ring flares from that side.
// * C, ripple: a soft ring of light breathes out from the sender, a faint wave runs the line, the ripple lands on the
//   receiver and its glow breathes in and out once.
import type { Port } from "./Block";

export type MessageStyle = "A" | "B" | "C";
export const MESSAGE_STYLES: readonly MessageStyle[] = ["A", "B", "C"];

/** One turn of a block's running light, s (styles.css `cv-spin`). */
export const RING_SECONDS = 2.6;
/** Where the running light's brightest point sits on its turning layer, degrees from its top, clockwise. */
export const RING_CREST_DEG = 317;

/** A line light's brightness profile, tail (0) to head (1), and its length and speed. */
export interface LineLight { profile: readonly { at: number; a: number }[]; length: number; speed: number; glow: number }

export const LINE_LIGHTS: Record<MessageStyle, LineLight> = {
  // A soft stretch, even at both ends.
  A: { profile: [{ at: 0, a: 0 }, { at: 0.3, a: 0.55 }, { at: 0.55, a: 1 }, { at: 0.75, a: 0.55 }, { at: 1, a: 0 }], length: 130, speed: 300, glow: 0.45 },
  // The ring's highlight unrolled: a long soft tail, the full colour just behind a soft head; at the ring's own speed.
  B: { profile: [{ at: 0, a: 0 }, { at: 0.45, a: 0.3 }, { at: 0.78, a: 0.85 }, { at: 0.9, a: 1 }, { at: 1, a: 0 }], length: 170, speed: 252, glow: 0.5 },
  // A faint wave.
  C: { profile: [{ at: 0, a: 0 }, { at: 0.5, a: 0.5 }, { at: 1, a: 0 }], length: 110, speed: 300, glow: 0.3 },
};

/** How a block's effect reacts: its ring swelling, flaring from a side, a ripple out or in, its glow breathing. */
export type ReactKind = "swell" | "flare" | "ripple-out" | "ripple-in" | "breathe";

export interface Reaction {
  kind: ReactKind;
  /** s from the message's start, and how long. */
  delay: number;
  dur: number;
  /** The side it comes from (a flare), and whether it turns from the sender's colour into the block's own. */
  port?: Port;
  morph: boolean;
}

export interface MessagePlan {
  style: MessageStyle;
  /** The light leaves the sender's point, and reaches the receiver's, s from the start. */
  depart: number;
  arrive: number;
  /** The line light's run: from before the line's start until its tail has left the line's end. */
  run: number;
  sender: Reaction[];
  receiver: Reaction[];
  /** When everything is over, s. */
  end: number;
}

export interface MessageInput {
  style: MessageStyle;
  /** The line's length, px; 0 for the person's message (no sender, no line). */
  line: number;
  /** The sender: its point, and how long until its running light's crest reaches that point (absent: it isn't running). */
  sender?: { port: Port; crestIn?: number };
  receiver: { port: Port; waiting: boolean };
}

/** Where a point sits on the running light's turn, degrees clockwise from the top. */
export const portAngle = (port: Port) => ({ t: 0, r: 90, b: 180, l: 270 })[port];

/** How long until the running light's crest reaches `port`, given its turning layer's rotation now (degrees). */
export function crestIn(rotation: number, port: Port): number {
  const crest = (((rotation + RING_CREST_DEG) % 360) + 360) % 360;
  return ((((portAngle(port) - crest) % 360) + 360) % 360) / 360 * RING_SECONDS;
}

/** The turn a running light starts at so its crest sits at `port` (the receiver whose ring starts with the message). */
export const ringStartAt = (port: Port) => (((portAngle(port) - RING_CREST_DEG) % 360) + 360) % 360;

export function planMessage(m: MessageInput): MessagePlan {
  const light = LINE_LIGHTS[m.style];
  const sender: Reaction[] = [];
  let depart = 0;
  if (m.sender !== undefined) {
    if (m.style === "A") {
      sender.push({ kind: "swell", delay: 0, dur: 0.9, morph: false });
      depart = 0.18;
    } else if (m.style === "B") {
      // Released by the circling highlight as it passes the point; an idle sender's outline flashes softly first.
      if (m.sender.crestIn !== undefined) depart = m.sender.crestIn;
      else { sender.push({ kind: "swell", delay: 0, dur: 0.7, morph: false }); depart = 0.3; }
    } else {
      sender.push({ kind: "ripple-out", delay: 0, dur: 0.9, morph: false });
      depart = 0.12;
    }
  }
  const arrive = depart + (m.sender !== undefined ? m.line / light.speed : 0.15);
  const receiver: Reaction[] = m.style === "A"
    ? [{ kind: "swell", delay: arrive - 0.05, dur: m.receiver.waiting ? 1 : 1.1, morph: true }]
    : m.style === "B"
      ? [{ kind: "flare", delay: arrive - 0.04, dur: 1.1, port: m.receiver.port, morph: true }]
      : [{ kind: "ripple-in", delay: arrive - 0.25, dur: 0.6, morph: true }, { kind: "breathe", delay: arrive, dur: 1.3, morph: true }];
  const run = m.sender !== undefined ? (m.line + light.length) / light.speed : 0;
  const end = Math.max(depart + run, ...receiver.map((r) => r.delay + r.dur), ...sender.map((r) => r.delay + r.dur));
  return { style: m.style, depart, arrive, run, sender, receiver, end };
}

/** The line light as dashes, tail to head, each at the profile's brightness there; `back` is how far its head end sits
 *  behind the light's head. Together they cover the whole light. */
export function lightPieces(light: LineLight, pieces = 24): { length: number; back: number; a: number; mix: number }[] {
  const at = (x: number) => {
    for (let i = 0; i < light.profile.length - 1; i++) {
      const p = light.profile[i]!;
      const q = light.profile[i + 1]!;
      if (x <= q.at) return p.a + ((q.a - p.a) * (x - p.at)) / (q.at - p.at);
    }
    return 0;
  };
  const len = light.length / pieces;
  return Array.from({ length: pieces }, (_, i) => {
    const mid = (i + 0.5) / pieces;
    return { length: len, back: light.length - (i + 1) * len, a: Math.round(at(mid) * 1000) / 1000, mix: Math.round(Math.max(0, (mid - 0.5) * 2) * 100) / 100 };
  }).filter((p) => p.a > 0.01);
}
