// A message crossing, over the blocks' own activity effect (the conic running light, the waiting dashes). The owner's
// pick, 2026-11-21 ("i like whatever the 'The sample scene, live' is using"): style A of the three he was shown, the glow
// wave and the ring swell. A soft stretch with the ring's glow runs the line; the sender's ring swells as it leaves (an
// idle sender's outline the same), and the receiver's swells as it lands, in the sender's colour settling into its own
// (an idle receiver's outline gives one soft glow pulse that fades; a waiting one's glows over its dashes). A receiver
// that starts running with the message starts its ring with the crest at its point as it lands.
// Pure: what each part does and when; the view draws it with CSS only.
import type { Port } from "./Block";

/** Where the running light's brightest point sits on its turning layer, degrees from its top, clockwise. */
export const RING_CREST_DEG = 317;

/** The line light: its brightness profile, tail (0) to head (1), its length, speed and glow. A soft stretch, even at both ends. */
export const LINE_LIGHT = {
  profile: [{ at: 0, a: 0 }, { at: 0.3, a: 0.55 }, { at: 0.55, a: 1 }, { at: 0.75, a: 0.55 }, { at: 1, a: 0 }],
  length: 130,
  speed: 300,
  glow: 0.45,
} as const;

/** A block's ring swelling (brighter, a wider glow) and settling: when, how long, and whether it turns from the
 *  sender's colour into the block's own (where the message lands). */
export interface Reaction {
  kind: "swell";
  delay: number;
  dur: number;
  morph: boolean;
}

export interface MessagePlan {
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
  /** The line's length, px; 0 for the person's message (no sender, no line). */
  line: number;
  sender?: { port: Port };
  receiver: { port: Port; waiting: boolean };
}

/** Where a point sits on the running light's turn, degrees clockwise from the top. */
export const portAngle = (port: Port) => ({ t: 0, r: 90, b: 180, l: 270 })[port];

/** The turn a running light starts at so its crest sits at `port` (the receiver whose ring starts with the message). */
export const ringStartAt = (port: Port) => (((portAngle(port) - RING_CREST_DEG) % 360) + 360) % 360;

export function planMessage(m: MessageInput): MessagePlan {
  const sender: Reaction[] = m.sender !== undefined ? [{ kind: "swell", delay: 0, dur: 0.9, morph: false }] : [];
  const depart = m.sender !== undefined ? 0.18 : 0;
  const arrive = depart + (m.sender !== undefined ? m.line / LINE_LIGHT.speed : 0.15);
  const receiver: Reaction[] = [{ kind: "swell", delay: arrive - 0.05, dur: m.receiver.waiting ? 1 : 1.1, morph: true }];
  const run = m.sender !== undefined ? (m.line + LINE_LIGHT.length) / LINE_LIGHT.speed : 0;
  const end = Math.max(depart + run, ...receiver.map((r) => r.delay + r.dur), ...sender.map((r) => r.delay + r.dur));
  return { depart, arrive, run, sender, receiver, end };
}

/** The line light as dashes, tail to head, each at the profile's brightness there; `back` is how far its head end sits
 *  behind the light's head. Together they cover the whole light. */
export function lightPieces(pieces = 24): { length: number; back: number; a: number; mix: number }[] {
  const at = (x: number) => {
    for (let i = 0; i < LINE_LIGHT.profile.length - 1; i++) {
      const p = LINE_LIGHT.profile[i]!;
      const q = LINE_LIGHT.profile[i + 1]!;
      if (x <= q.at) return p.a + ((q.a - p.a) * (x - p.at)) / (q.at - p.at);
    }
    return 0;
  };
  const len = LINE_LIGHT.length / pieces;
  return Array.from({ length: pieces }, (_, i) => {
    const mid = (i + 0.5) / pieces;
    return { length: len, back: LINE_LIGHT.length - (i + 1) * len, a: Math.round(at(mid) * 1000) / 1000, mix: Math.round(Math.max(0, (mid - 0.5) * 2) * 100) / 100 };
  }).filter((p) => p.a > 0.01);
}
