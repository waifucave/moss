// The ONE light (the owner, 2026-11-21: "i want like a unified effect"): the canvas is one circuit, a block's outline and
// the lines between blocks are the same wire, and this one light lives on it. A running block's light circulating on its
// own loop and a message's light running a line are the same thing: the same profile, thickness, glow and speed. Pure.
//
// The light is a brightness profile from its tail (0) to its head (1): a long faint tail, a body that brightens, the
// full colour just behind the head, and a soft head. It is drawn as `PIECES` short dashes walking the same path together,
// each at the profile's brightness there (fine enough that no step shows), plus one blurred glow over its bright part.
import { SIZE } from "./layout";

/** Brightness (0 to 1) along the light, tail to head. */
export const LIGHT_PROFILE: readonly { at: number; a: number }[] = [
  { at: 0, a: 0 },
  { at: 0.5, a: 0.22 },
  { at: 0.8, a: 0.75 },
  { at: 0.88, a: 1 },
  { at: 1, a: 0 },
];
/** Where the light starts turning from the agent's first colour to its second (a two-colour mark), fully second at the head. */
export const SECOND_COLOUR_FROM = 0.55;
/** How many dashes draw the light. */
export const PIECES = 48;
/** One turn of the running light round a standard block, seconds. */
export const RING_SECONDS = 2.6;

/** A standard block's outline (its corners at 12px), px. */
export const STANDARD_PERIMETER = 2 * (SIZE.main.w - 24) + 2 * (SIZE.main.h - 24) + 2 * Math.PI * 12;
/** The light's one speed along the wire, px a second: border, point and line alike. */
export const LIGHT_SPEED = STANDARD_PERIMETER / RING_SECONDS;
/** The light's length along the wire, px: half a standard block's outline. */
export const LIGHT_LENGTH = Math.round(STANDARD_PERIMETER / 2);
/** The glow: over the light's bright part, from `GLOW_FROM` to `GLOW_TO` of its length. */
export const GLOW_FROM = 0.62;
export const GLOW_TO = 0.97;

/** The profile's brightness at `at` (0 tail to 1 head), linear between its points. */
export function brightnessAt(at: number): number {
  const x = Math.min(1, Math.max(0, at));
  for (let i = 0; i < LIGHT_PROFILE.length - 1; i++) {
    const p = LIGHT_PROFILE[i]!;
    const q = LIGHT_PROFILE[i + 1]!;
    if (x <= q.at) return p.a + ((q.a - p.a) * (x - p.at)) / (q.at - p.at);
  }
  return 0;
}

/** How far toward the second colour the light is at `at`, 0 to 1. */
export const secondAt = (at: number) => Math.min(1, Math.max(0, (at - SECOND_COLOUR_FROM) / (1 - SECOND_COLOUR_FROM)));

export interface LightPiece {
  /** Its length, and how far its head end sits behind the light's head, px. */
  length: number;
  back: number;
  /** Its brightness, and how far toward the second colour it is (0 to 1). */
  a: number;
  mix: number;
}

/** The light as its dashes, tail to head, end to end over the whole light. */
export function lightPieces(): LightPiece[] {
  const len = LIGHT_LENGTH / PIECES;
  return Array.from({ length: PIECES }, (_, i) => {
    const mid = (i + 0.5) / PIECES;
    return { length: len, back: LIGHT_LENGTH - (i + 1) * len, a: Math.round(brightnessAt(mid) * 1000) / 1000, mix: Math.round(secondAt(mid) * 100) / 100 };
  }).filter((p) => p.a > 0.005);
}

/** The glow as one dash. */
export const glowPiece = (): { length: number; back: number } => ({ length: (GLOW_TO - GLOW_FROM) * LIGHT_LENGTH, back: (1 - GLOW_TO) * LIGHT_LENGTH });
