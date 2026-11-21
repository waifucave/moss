// The canvas's model: the blocks and the lines from the sessions as the engine shows them (spec revision 20, §9.5), and
// nothing else. Pure.
//
// * A main block per code session (`coding`, or `agent`: a session another session or a bot started). Its parent (its
//   left point) is who started it: `startedBy` (the engine's), else `parent`/`bot` for a session from before revision 20.
// * A bot block per bot that shows here: one whose conversation or side thread the plugin reads, or one that started a
//   session. It moves as the strongest of its own sessions. It has no composer (MOSS Code has no bot conversation).
// * A small block per subagent row (`SessionView.subagents`), to its session's right. No one can message one.
// * A line from each block's parent to it (`child`, `bot`). Lines between two main sessions (`peer`) come from links
//   (links.ts), not from here.
import type { SessionView } from "@waifucave/moss-plugin-sdk";
import { brandOf, metaLine, modelLabel, MOSS_CORAL, motionOf, statusLine, strongest, type BackendLook, type BotState, type Motion } from "./look";
import { S } from "./strings";

export type BlockType = "main" | "sub" | "bot";

export interface Block {
  /** A session's id; `bot:<bot>`; `sub:<session>:<row>`. */
  id: string;
  type: BlockType;
  /** The session it messages and opens: itself (main), its parent's (sub); none for a bot. */
  session?: string;
  bot?: string;
  /** The block it hangs from: its left point's line. */
  parent?: string;
  title: string;
  /** The line under the title: `model · effort` (a subagent's: its model), empty when neither is known. The agent's name
   *  leads it only when its mark is our letter (a letter alone doesn't name it); otherwise its icon names it (the owner,
   *  2026-11-21: "remove the harness name its useless since we have the icons"). */
  meta: string;
  /** The agent's name: the mark's accessible name and tooltip, and the block's announcement. */
  agent?: string;
  status: string;
  motion: Motion;
  /** The agent's colour (and a gradient's second), at full strength: the mark wears it; what moves wears it softened. */
  brand?: string;
  brand2?: string;
  /** A bot's state as the activity feed gives it (its face's expression and its words). */
  botState?: BotState;
  backend?: string;
  /** When it started, for the layout's order. */
  startedAt: number;
  /** A person may message it (a code session that has not ended). */
  messageable: boolean;
}

export interface Edge {
  /** `child:<to>`, `bot:<to>`, `peer:<a>|<b>`. */
  id: string;
  kind: "child" | "bot" | "peer";
  /** child, bot: the starter; peer: the lower id. */
  a: string;
  b: string;
}

export interface CanvasModel {
  blocks: Block[];
  byId: ReadonlyMap<string, Block>;
  edges: Edge[];
  /** The block a session's events land on: a code session's own, a bot's conversation's or side thread's bot's. */
  blockOfSession(session: string): string | undefined;
}

export const botBlockId = (bot: string) => `bot:${bot}`;
export const subBlockId = (session: string, row: string) => `sub:${session}:${row}`;

const isBotKind = (s: SessionView) => s.kind === "bot" || s.kind === "side-thread";

/** The model of `sessions` (latest views by id), with each backend's look and each bot's name. Archived sessions are
 *  left out, as the sidebar leaves them out. */
export function buildModel(
  sessions: Readonly<Record<string, SessionView>>,
  backends: ReadonlyMap<string, BackendLook>,
  botNames: ReadonlyMap<string, string> = new Map(),
  botStates: ReadonlyMap<string, BotState> = new Map(),
): CanvasModel {
  const all = Object.values(sessions).filter((s) => s.archived !== true);
  const byId = new Map<string, Block>();
  const blocks: Block[] = [];
  const add = (b: Block) => {
    byId.set(b.id, b);
    blocks.push(b);
  };

  // Bots: from their own sessions first (their motion), then any bot that only started a session.
  const bots = new Map<string, { motion: Motion; startedAt: number; title?: string }>();
  const seeBot = (bot: string, motion: Motion, startedAt: number, title?: string) => {
    const was = bots.get(bot);
    bots.set(bot, {
      motion: was === undefined ? motion : strongest(was.motion, motion),
      startedAt: Math.min(was?.startedAt ?? startedAt, startedAt),
      ...((was?.title ?? title) !== undefined ? { title: was?.title ?? title } : {}),
    });
  };
  for (const s of all) {
    if (isBotKind(s) && s.bot !== undefined) seeBot(s.bot, motionOf(s) === "ended" ? "still" : motionOf(s), s.startedAt, s.kind === "bot" ? s.title : undefined);
  }
  const starterBot = (s: SessionView): string | undefined => {
    if (s.startedBy?.kind === "bot") return s.startedBy.bot;
    if (s.startedBy === undefined && s.kind === "agent" && s.bot !== undefined) return s.bot;
    return undefined;
  };
  for (const s of all) {
    if (isBotKind(s)) continue;
    const bot = starterBot(s);
    if (bot !== undefined && !bots.has(bot)) seeBot(bot, "still", s.startedAt);
  }
  for (const [bot, b] of [...bots].sort((x, y) => x[1].startedAt - y[1].startedAt || x[0].localeCompare(y[0]))) {
    // The sessions it started that haven't ended: while they run and it doesn't, it waits on them (and says so).
    const started = all.filter((s) => !isBotKind(s) && starterBot(s) === bot && motionOf(s) !== "ended").length;
    // What it does itself: the activity feed's word, else its own conversations' motion. Busy itself, it runs; else, while
    // sessions it started run, it waits on them.
    const fed = botStates.get(bot);
    const busy = fed === "thinking" || fed === "working" || fed === "listening" || b.motion === "running";
    const motion: Motion = busy ? "running" : started > 0 ? "waiting" : b.motion;
    const botState: BotState = fed ?? (motion === "running" ? "working" : "idle");
    // Its words: what the feed says it does itself (thinking, working, asking...), else, drawn waiting, what it waits on.
    const status = motion === "waiting" && botState === "idle" ? `${S.waiting} · ${started > 0 ? S.sessionsCount(started) : S.idle}` : S.botState[botState];
    add({
      id: botBlockId(bot), type: "bot", bot, title: botNames.get(bot) ?? b.title ?? bot[0]!.toUpperCase() + bot.slice(1), meta: S.bot, status,
      motion, brand: MOSS_CORAL, botState, startedAt: b.startedAt, messageable: false,
    });
  }

  // The block a session's events land on.
  const sessionBlock = new Map<string, string>();
  for (const s of all) {
    if (isBotKind(s)) {
      if (s.bot !== undefined) sessionBlock.set(s.id, botBlockId(s.bot));
    } else sessionBlock.set(s.id, s.id);
  }

  // Main blocks, oldest first.
  const mains = all.filter((s) => !isBotKind(s)).sort((x, y) => x.startedAt - y.startedAt || x.id.localeCompare(y.id));
  const parentOf = (s: SessionView): string | undefined => {
    const st = s.startedBy;
    if (st?.kind === "session") return sessionBlock.get(st.session);
    if (st?.kind === "bot") return botBlockId(st.bot);
    if (st?.kind === "user" || st?.kind === "routine") return undefined;
    // From before revision 20: `parent`, else a bot's agent's bot.
    if (s.parent !== undefined) return sessionBlock.get(s.parent) ?? (s.bot !== undefined ? botBlockId(s.bot) : undefined);
    return s.kind === "agent" && s.bot !== undefined ? botBlockId(s.bot) : undefined;
  };
  for (const s of mains) {
    const look = s.backend !== undefined ? backends.get(s.backend) : undefined;
    const motion = motionOf(s);
    const parent = parentOf(s);
    const agent = look?.name ?? s.backend;
    add({
      id: s.id, type: "main", session: s.id, ...(s.bot !== undefined ? { bot: s.bot } : {}), ...(parent !== undefined && parent !== s.id ? { parent } : {}),
      title: s.title !== undefined && s.title.trim() !== "" ? s.title : S.untitled,
      meta: metaLine([look?.icon === undefined ? agent : undefined, modelLabel(s.model), s.effort]),
      ...(agent !== undefined ? { agent } : {}),
      status: statusLine(s), motion, ...brandOf(s.backend, look), ...(s.backend !== undefined ? { backend: s.backend } : {}),
      startedAt: s.startedAt, messageable: motion !== "ended",
    });
  }
  // Subagent rows, after every main block, so a parent is always known first.
  for (const s of mains) {
    const parent = byId.get(s.id)!;
    for (const row of s.subagents ?? []) {
      add({
        id: subBlockId(s.id, row.id), type: "sub", session: s.id, parent: s.id, title: row.name || S.subagent,
        meta: metaLine([modelLabel(row.model)]),
        ...(parent.agent !== undefined ? { agent: parent.agent } : {}),
        status: row.state === "running" ? S.running : row.state === "failed" ? S.failed : S.done,
        motion: row.state === "running" ? "running" : "ended",
        ...(parent.brand !== undefined ? { brand: parent.brand } : {}), ...(parent.brand2 !== undefined ? { brand2: parent.brand2 } : {}), ...(parent.backend !== undefined ? { backend: parent.backend } : {}),
        startedAt: row.startedAt, messageable: false,
      });
    }
  }

  // A parent that is not on the canvas (archived, unknown) leaves its block a root.
  for (const b of blocks) if (b.parent !== undefined && !byId.has(b.parent)) delete b.parent;
  const edges: Edge[] = blocks.filter((b) => b.parent !== undefined).map((b) => {
    const kind = byId.get(b.parent!)!.type === "bot" ? "bot" : "child";
    return { id: `${kind}:${b.id}`, kind, a: b.parent!, b: b.id };
  });
  return { blocks, byId, edges, blockOfSession: (session) => sessionBlock.get(session) };
}
