// A bot's living face (spec §6.9) as MOSS draws it. The kit and the canvas moved into the plugin SDK (revision 20, §9.5), so
// MOSS and any plugin draw the same face; what stays here is MOSS's: the mood in words beside every face (MoodWords).
import { FaceCanvas, faceMotion, type Mood } from "@waifucave/moss-plugin-sdk/ui/faces";
import { MOOD_WORDS } from "../../shared/view";
import { statusPhrase } from "../../shared/status-line";
import type { BotFace } from "../../shared/view";

/** Whether faces hold still (the renders; the system's reduced-motion setting is the kit's own default otherwise). */
export { faceMotion };

export function Face(props: { name: string; face?: BotFace; mood: Mood; size: number; surface?: "list" | "page" | "header" }) {
  return <FaceCanvas {...props} />;
}

/** The mood in words, beside every face: one short phrase. While a turn runs it is what the bot is doing, in the status
 *  line's plain words without the detail ("Reading a file"); a tool's wire name is never shown. */
export function MoodWords(props: { mood: Mood; tool?: string }) {
  const words = statusPhrase({ state: props.mood, ...(props.tool !== undefined ? { tool: props.tool } : {}) }) ?? MOOD_WORDS[props.mood];
  return <span className={`mood mood--${props.mood}`} data-mood-words={props.mood}>{words}</span>;
}
