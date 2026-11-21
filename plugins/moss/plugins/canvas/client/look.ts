// How a session reads on the canvas: how it moves (the protocol's `sessionMotion`, mirrored here so the client bundle
// carries no protocol code; test/look.test.ts holds the two equal for every status), its agent's colour, a model's label
// and the one status line. Pure.
import type { SessionView } from "@waifucave/moss-plugin-sdk";
import { S } from "./strings";

/** How a block moves (spec §9.5: running wins over waiting). */
export type Motion = "running" | "waiting" | "still" | "ended";

/** `sessionMotion` (protocol `session-graph.ts`): running while a turn runs, else waiting while something will wake it,
 *  else still; stopped and failed are ended. */
export function motionOf(view: { status: string; waiting?: { tasks: number; children: number } | undefined }): Motion {
  if (view.status === "stopped" || view.status === "failed") return "ended";
  if (view.status === "starting" || view.status === "prompting" || view.status === "cancelling") return "running";
  const w = view.waiting;
  return w !== undefined && w.tasks + w.children > 0 ? "waiting" : "still";
}

/** The stronger of two motions, for a bot whose sessions move apart: running, then waiting, then still. */
export function strongest(a: Motion, b: Motion): Motion {
  const rank: Record<Motion, number> = { running: 3, waiting: 2, still: 1, ended: 0 };
  return rank[a] >= rank[b] ? a : b;
}

/** MOSS's own coral: a bot's colour (its face's, when its record names none) and the lines that leave a bot. Data, like
 *  each agent's colour, never a theme colour: it reaches the page as the block's `--brand`. */
export const MOSS_CORAL = "#F0694C";
/** MOSS's own coding agent's colour when its record names none: the gold of MOSS Code's Shards mark (the owner,
 *  2026-11-21: "moss coding agent give it the coding icon"; coral is for bots only). */
export const MOSS_CODE_GOLD = "#E5A72E";
/** MOSS's own coding agent's backend id. */
export const MOSS_CODE = "moss-code";

/** A backend's look as `agent.backends` serves it. */
export interface BackendLook {
  id: string;
  name: string;
  color?: string;
  color2?: string;
  icon?: { mediaType: "image/png" | "image/svg+xml"; data: string; at: number };
}

/** An agent's colour(s): its icon's real colour from its backend (`color`, and `color2` for a two-colour mark), at full
 *  hue; MOSS's coral for MOSS's own agent when its record names none. None for a black-and-white brand: the canvas then
 *  draws its mark and everything that moves in the theme's text colour (never a grey of our own). */
export function brandOf(backend: string | undefined, look: BackendLook | undefined): { brand?: string; brand2?: string } {
  if (look?.color !== undefined) return { brand: look.color, ...(look.color2 !== undefined ? { brand2: look.color2 } : {}) };
  return backend === MOSS_CODE ? { brand: MOSS_CODE_GOLD } : {};
}

/** Whether a shipped icon is a one-colour glyph drawn in `currentColor` (an SVG that says so): the canvas then fills its
 *  shape with the agent's colour, or the theme's text colour, as an image mask (never markup in the page). */
export function isGlyph(icon: BackendLook["icon"]): boolean {
  if (icon === undefined || icon.mediaType !== "image/svg+xml") return false;
  try {
    return atob(icon.data).includes("currentColor");
  } catch {
    return false;
  }
}

/** A bot's state as its face shows it (the activity feed's `ActivityState`). */
export type BotState = "idle" | "listening" | "thinking" | "working" | "asking" | "stuck" | "done" | "asleep";

/** A model id as a person reads it: `anthropic/claude-opus-5-5` → `Claude Opus 5.5`. The provider goes, words are
 *  capitalised and a run of single digits joins with dots. A name the catalog gives wins over this (`agent.options`). */
export function modelLabel(model: string | undefined): string | undefined {
  if (model === undefined || model === "") return undefined;
  const bare = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  const words = bare.split(/[-_\s]+/).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    if (/^\d$/.test(w) && prev !== undefined && /\d$/.test(prev)) out[out.length - 1] = `${prev}.${w}`;
    else out.push(UPPER.has(w.toLowerCase()) ? w.toUpperCase() : /^[a-z]/.test(w) ? w[0]!.toUpperCase() + w.slice(1) : w);
  }
  return out.join(" ");
}

/** Words a model's name spells in capitals. */
const UPPER = new Set(["gpt", "glm", "ai"]);

/** `agent · model · effort`, each part only when known. */
export function metaLine(parts: readonly (string | undefined)[]): string {
  return parts.filter((p): p is string => p !== undefined && p !== "").join(" · ");
}

/** The one status line a block shows: its motion, what it waits on, its running subagents, a card waiting. */
export function statusLine(view: Pick<SessionView, "status" | "waiting" | "needsYou" | "failure" | "subagents">): string {
  if (view.needsYou !== undefined && view.needsYou.cards + view.needsYou.questions > 0) return S.needsYou;
  const motion = motionOf(view);
  if (motion === "ended") return view.status === "failed" ? S.failed : S.ended;
  if (motion === "running") {
    const subs = (view.subagents ?? []).filter((s) => s.state === "running").length;
    return subs > 0 ? `${S.running} · ${S.subagents(subs)}` : view.status === "starting" ? S.starting : S.running;
  }
  if (motion === "waiting") {
    const w = view.waiting!;
    const parts = [w.tasks > 0 ? S.jobs(w.tasks) : undefined, w.children > 0 ? S.children(w.children) : undefined];
    return `${S.waiting} · ${parts.filter(Boolean).join(", ")}`;
  }
  return view.failure !== undefined ? S.lastTurnFailed : S.idle;
}
