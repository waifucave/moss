// A bot's face colour, resolved exactly as MOSS's faces kit resolves it (`makeBot` in living-bots.js): a pinned palette
// name, a pinned `#rrggbb`, or the colour drawn from its name (avoiding the few colours its drawn shape can't wear). The
// canvas paints a bot's outline light and the lines that leave it in this colour (the owner, 2026-11-21: Pip blue, Juno
// green). A bundled plugin's client may import only `@waifucave/moss-plugin-sdk/ui` from the SDK (CLIENT_BARE_IMPORTS),
// which doesn't export the kit's `makeBot`; when it does, this file goes and `makeBot(name, face).color` takes its place. test/faceColour.test.ts holds the two to the same answers.

/** The kit's ten colours (data, as an agent's brand colour is). */
export const FACE_PALETTE: readonly (readonly [string, string])[] = [
  ["gold", "#E5A72E"], ["coral", "#F0694C"], ["sky", "#4A9CEC"], ["mint", "#3DBE8B"], ["violet", "#9A7BF0"],
  ["lagoon", "#1FB2BE"], ["lime", "#A2C73B"], ["orchid", "#C86FD6"], ["ember", "#F4893A"], ["iris", "#5F70E2"],
];
const SHAPES = ["ball", "drop", "dome", "bowl", "pill", "loaf", "tile", "peak", "gem", "cup"];
const AVOID: Readonly<Record<string, readonly string[]>> = { ball: ["gold", "orchid"], drop: ["coral"], dome: ["coral"], pill: ["gold"] };

function hashText(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function firstPick<T>(key: string, list: readonly T[]): T {
  let s = hashText(key) || 1;
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  const f = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return list[Math.floor(f * list.length) % list.length]!;
}

/** The face's colour for a bot's name and its record's pins, as `#RRGGBB`. */
export function faceColour(name: string, face?: { shape?: string; color?: string }): string {
  const key = name.trim().toLowerCase() || "bot";
  const shape = face?.shape !== undefined && SHAPES.includes(face.shape) ? face.shape : firstPick(`flat/${key}/body`, SHAPES);
  let tone = firstPick(`flat/${key}/colour`, FACE_PALETTE);
  if ((AVOID[shape] ?? []).includes(tone[0])) tone = FACE_PALETTE[(FACE_PALETTE.indexOf(tone) + 1) % FACE_PALETTE.length]!;
  const asked = typeof face?.color === "string" ? face.color.trim() : "";
  const named = FACE_PALETTE.find((p) => p[0] === asked.toLowerCase());
  if (named !== undefined) return named[1];
  if (/^#[0-9a-f]{6}$/i.test(asked)) return asked.toUpperCase();
  return tone[1];
}
