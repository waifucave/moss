// The marks any plugin draws for a bot and for an agent backend (spec revision 20, §9.5), so every plugin draws the same
// ones. Shapes pinned by lane CS; lane CA builds the two components beside this (`BotFace`, moved here from
// `apps/moss/src/window/faces`, over `bot.records`' face pins; `AgentMark`, over `agent.backends`) and exports them from
// `@waifucave/moss-plugin-sdk/ui`. What is here now is their props and the agent's fallback mark, which is pure.
import type { ActivityState, AgentBackendView, BotFace } from "@waifucave/moss-protocol";

/** `BotFace`'s props: the bot by id (its face pins come from `bot.records`, `bots.read`; traits left out come from its
 *  name, as MOSS's own window draws them), its size in CSS pixels, and the mood to show (the activity feed's state;
 *  `idle` when absent). `face`/`name` let a part draw a face it already has, with no read. */
export interface BotFaceProps {
  readonly bot: string;
  readonly name?: string;
  readonly face?: BotFace;
  readonly size?: number;
  readonly state?: ActivityState;
}

/** `AgentMark`'s props: a backend as `agent.backends` gives it, and its size in CSS pixels. */
export interface AgentMarkProps {
  readonly backend: Pick<AgentBackendView, "id" | "name" | "icon" | "color" | "color2">;
  readonly size?: number;
}

/** The colour of a backend that names none: a neutral grey. */
export const AGENT_MARK_NEUTRAL = "#8a8f98";

/** What `AgentMark` draws: the mark its plugin ships (`agentBackends[].icon`, served by `agent.backends`), as an image only (a `data:` URL for an
 *  `<img>`, never markup in the page); else ours, the name's first letter on the brand colour (a gradient to `color2`
 *  when given), in white or near-black, whichever reads on it. */
export type AgentMarkLook =
  | { readonly kind: "icon"; readonly src: string }
  | { readonly kind: "letter"; readonly letter: string; readonly background: string; readonly background2?: string; readonly foreground: string };

export function agentMark(b: AgentMarkProps["backend"]): AgentMarkLook {
  if (b.icon !== undefined) return { kind: "icon", src: `data:${b.icon.mediaType};base64,${b.icon.data}` };
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const first = [...(name || b.id)][0] ?? "?";
  const background = b.color ?? AGENT_MARK_NEUTRAL;
  return { kind: "letter", letter: first.toLocaleUpperCase(), background, ...(b.color2 !== undefined ? { background2: b.color2 } : {}), foreground: readsLight(background) ? "#1b1d21" : "#ffffff" };
}

/** Whether a `#rrggbb` is light enough that dark text reads on it (relative luminance over 0.45). */
function readsLight(hex: string): boolean {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (m === null) return false;
  const lin = (c: string) => {
    const v = Number.parseInt(c, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(m[1]!) + 0.7152 * lin(m[2]!) + 0.0722 * lin(m[3]!) > 0.45;
}
