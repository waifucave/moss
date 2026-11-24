// A face on the page: the bots' own kit (`living-bots.js`, the file MOSS's window draws its faces with), so every face
// here is the face the app would draw for that name. The build puts a still picture of it in the page (the kit's
// `botSVG`, which runs without a browser), so the face is there before any script and without one; the page's script
// then swaps in the living face, which blinks, looks around and changes mood. A face is decoration for a screen reader:
// its bot's name, and its mood in words, are always written beside it.
import { botSVG, makeBot, wake, type BotOptions, type Mood } from "../../../packages/plugin-sdk/src/ui/faces/living-bots.js";
import { html, raw, type Html } from "./html";

/** How much of its square a face fills: the app's own (`FaceCanvas` mounts at 1.2). */
export const FACE_SCALE = 1.2;

/** MOSS, the default bot, as the app's icon draws her (spec §6.2): the whole tile, coral, round eyes. */
export const MOSS_PINS: BotOptions = { shape: "tile", color: "coral", eyes: "round" };

export interface FaceSlot {
  name: string;
  pins?: BotOptions;
  mood?: Mood;
  /** The class that sizes it (site.css: face--logo, face--row, face--mood, face--block, face--app). */
  size: "logo" | "row" | "mood" | "block" | "app";
  /** The colour behind it, which a sleeping bot fades toward: the page's own, or the list's grey. */
  surface?: "page" | "list";
  /** Follow the pointer with its eyes, and jump when tapped (the large ones). */
  lively?: boolean;
  /** Extra data attributes, for the page's script (`data-row` and the like). */
  data?: Record<string, string>;
}

const PIXELS: Record<FaceSlot["size"], number> = { logo: 28, row: 44, mood: 56, block: 40, app: 56 };
/** How much of its square each face fills: the large face jumps when tapped, so it leaves itself room; the logo and the
 *  app's mark in the download area fill their square, as the app's icon does. */
const SCALE: Record<FaceSlot["size"], number> = { logo: 1.4, row: FACE_SCALE, mood: FACE_SCALE, block: FACE_SCALE, app: 1.5 };

export function face(slot: FaceSlot): Html {
  const pins = slot.pins ?? {};
  const bot = makeBot(slot.name, pins);
  const mood = slot.mood ?? "idle";
  const still = botSVG(bot, { size: PIXELS[slot.size], scale: SCALE[slot.size], life: wake(bot, mood), label: "" });
  const attrs: Record<string, string> = {
    "data-face": slot.name,
    "data-mood": mood,
    "data-surface": slot.surface ?? "page",
    "data-scale": String(SCALE[slot.size]),
    ...(pins.shape !== undefined ? { "data-shape": pins.shape } : {}),
    ...(pins.color !== undefined ? { "data-color": String(pins.color) } : {}),
    ...(pins.eyes !== undefined ? { "data-eyes": pins.eyes } : {}),
    ...(slot.lively === true ? { "data-lively": "" } : {}),
    ...slot.data,
  };
  const attrText = Object.entries(attrs).map(([k, v]) => html` ${raw(k)}="${v}"`);
  return html`<span class="face face--${slot.size}"${attrText} aria-hidden="true">${raw(still)}</span>`;
}

/** The colour a name's bot is drawn in, for the docs' page on faces and the tests. */
export function faceColor(name: string, pins: BotOptions = {}): string {
  return makeBot(name, pins).color;
}
