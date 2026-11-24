// MOSS protocol: the session graph (spec revision 20, §9.5). Owner: lane CG (the engine's session graph). Shapes pinned by
// lane CS (the canvas's spine); nothing here is served yet.
//
// What every reader of sessions can learn about how sessions hang together, without following each one's log:
// * who started a session (`SessionStarter`, `SessionView.startedBy`), beside the `parent` and `bot` it already carries;
// * that a message crossed from one session to another (`session_link`, a core event of the `sessions` area): who sent
//   it, which session got it, what kind it was and when, NEVER its words;
// * what a session waits on (`SessionWaiting`, `SessionView.waiting`): its background tasks that will wake it and its
//   children not yet ended, and how that sits beside its status (`sessionMotion`: running wins);
// * the subagents an agent reports through its own tool calls (`SessionSubagent`, `SessionView.subagents`): a small list
//   on the parent's view, never sessions of their own (no one can message one).
//
// General, not the canvas's: the sidebar, an island tab, a phone and any plugin that reads sessions can draw the same.
// A plugin hears a link only when it may read BOTH of its sessions (`pluginMayHear`, activity.ts): a plugin that may not
// read a session never learns of its links.
import { z } from "zod";
import { utf16 } from "./strings";
import { BotId, SessionId, SessionKind, Timestamp } from "./common";

// -------------------------------------------------------------------------------------------------
// Who started a session
// -------------------------------------------------------------------------------------------------

/** Who started a session. `user`: the person (in either app, the CLI, or a plugin part on the person's own press);
 *  `bot`: a bot, from its conversation (`session`, its main conversation or a side thread); `session`: another session
 *  (an agent's spawn of a session the person can message); `routine`: a routine's run (a side thread). Always set by the
 *  engine at the start, never by a client, and never changed after. */
export const SessionStarter = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }),
  z.object({ kind: z.literal("bot"), bot: BotId, session: SessionId.optional() }),
  z.object({ kind: z.literal("session"), session: SessionId }),
  z.object({ kind: z.literal("routine"), routine: utf16(128, 1), bot: BotId.optional() }),
]);
export type SessionStarter = z.infer<typeof SessionStarter>;

// -------------------------------------------------------------------------------------------------
// Waiting
// -------------------------------------------------------------------------------------------------

/** What a session waits on, as counts only: its own background tasks that will wake it when they end (a background
 *  command, a monitor: what the host's `wake` hands back as a `task` input), and the sessions it started that have not
 *  ended and aren't idle (`startedBy.session` or `parent` is it, status not `stopped` or `failed`; a child whose turn ended and waits
 *  for its next message is idle, not waited for). Absent, or both zero: nothing. An
 *  outside ACP agent's own jobs are not seen (its quirks say `countsChildProcesses: false`), so they never count. */
export const SessionWaiting = z.object({
  tasks: z.number().int().nonnegative(),
  children: z.number().int().nonnegative(),
});
export type SessionWaiting = z.infer<typeof SessionWaiting>;

/** How a session moves, for whatever draws it (spec §9.5: "running wins over waiting"): `running` while a turn runs
 *  (starting, prompting, cancelling); else `waiting` while something it waits on will wake it; else `still` (ready or
 *  idle), or `ended` (stopped or failed). Never stored: always this function of the view. */
export const SESSION_MOTIONS = ["running", "waiting", "still", "ended"] as const;
export type SessionMotion = (typeof SESSION_MOTIONS)[number];

export function sessionMotion(view: { status: string; waiting?: SessionWaiting | undefined }): SessionMotion {
  if (view.status === "stopped" || view.status === "failed") return "ended";
  if (view.status === "starting" || view.status === "prompting" || view.status === "cancelling") return "running";
  const w = view.waiting;
  return w !== undefined && w.tasks + w.children > 0 ? "waiting" : "still";
}

// -------------------------------------------------------------------------------------------------
// An agent's own subagents
// -------------------------------------------------------------------------------------------------

/** The most subagents a session's view lists: the newest stay, the oldest ended ones go first. */
export const SUBAGENTS_MAX = 64;

/** A subagent an agent reports through its tool calls (Claude Code's Task, an ACP agent's own child, MOSS's coding
 *  agent's when it has one): a row under its parent, never a session (it has no log here, and no one can message it).
 *  `id` is the engine's, stable for the parent's life (the reporting tool call's id where there is one); `name` the
 *  agent's own label for it (its description or type); `model` when the agent says. */
export const SessionSubagent = z.object({
  id: utf16(128, 1),
  name: utf16(200),
  model: utf16(200).optional(),
  state: z.enum(["running", "done", "failed"]),
  startedAt: Timestamp,
  /** Set once it is `done` or `failed`. */
  endedAt: Timestamp.optional(),
});
export type SessionSubagent = z.infer<typeof SessionSubagent>;

// -------------------------------------------------------------------------------------------------
// Links: a message from one session to another
// -------------------------------------------------------------------------------------------------

/** What crossed: an ordinary message (`SendMessage`, a bot's message to its agent, the person's message), a spawn's
 *  first prompt (`spawn`: the starter's words that began the session), or a final report (`report`: a background
 *  agent's task notification to its bot, a child's last words to the session that started it). */
export const SESSION_LINK_KINDS = ["message", "spawn", "report"] as const;
export const SessionLinkKind = z.enum(SESSION_LINK_KINDS);
export type SessionLinkKind = z.infer<typeof SessionLinkKind>;

/** A link's end: the person, or a session with its kind (a bot's conversation is a session of kind `bot`, with its
 *  bot). The kind is the engine's, so a reader's gate never looks anything up. */
export const SessionLinkEnd = z.discriminatedUnion("end", [
  z.object({ end: z.literal("user") }),
  z.object({ end: z.literal("session"), session: SessionId, kind: SessionKind, bot: BotId.optional() }),
]);
export type SessionLinkEnd = z.infer<typeof SessionLinkEnd>;

/** One message from `from` to `to` (always a session), with no words: what lets a reader draw the line between two
 *  sessions and light it, without attaching to either. The event's `ts` is when it was delivered. Strict: no text,
 *  tool input or card can ride along. Transient: it is never stored or replayed (a session's log keeps the message). */
export const SessionLinkEvent = z.strictObject({
  type: z.literal("session_link"),
  ts: Timestamp,
  from: SessionLinkEnd,
  to: z.object({ session: SessionId, kind: SessionKind, bot: BotId.optional() }),
  link: SessionLinkKind,
});
export type SessionLinkEvent = z.infer<typeof SessionLinkEvent>;

/** The kinds of the session ends of a link, for the gate (`pluginMayHear`): the person's end has none. */
export function linkSessionKinds(e: { from?: unknown; to?: unknown }): SessionKind[] | undefined {
  const out: SessionKind[] = [];
  const from = SessionLinkEnd.safeParse(e.from);
  const to = z.object({ kind: SessionKind }).safeParse(e.to);
  if (!from.success || !to.success) return undefined;
  if (from.data.end === "session") out.push(from.data.kind);
  out.push(to.data.kind);
  return out;
}

// -------------------------------------------------------------------------------------------------
// The record of links: which sessions have talked, and what crossed lately
// -------------------------------------------------------------------------------------------------

/** How many links between sessions the engine keeps in order (the newest), beside one row per pair. */
export const SESSION_LINKS_RECENT_MAX = 256;
/** How many pairs of sessions the record keeps (the ones that talked most lately). */
export const SESSION_LINK_PAIRS_MAX = 1_024;

/** Two sessions that have talked, one way (`from` to `to`): the last link's kind and time, and how many crossed. A link
 *  from the person is not a pair: it joins no two sessions. Dropped once either session ends. */
export const SessionLinkPair = z.strictObject({
  from: SessionLinkEnd,
  to: z.object({ session: SessionId, kind: SessionKind, bot: BotId.optional() }),
  last: SessionLinkKind,
  lastAt: Timestamp,
  count: z.number().int().positive(),
});
export type SessionLinkPair = z.infer<typeof SessionLinkPair>;

/** `session.links`: the record a reader may hear (both ends' kinds, as the live `session_link`): every pair, and the links
 *  between sessions since `since` (all it keeps, the newest `SESSION_LINKS_RECENT_MAX`, without it), oldest first. So
 *  what a reader drew before it was opened, and what crossed while it was closed, can be drawn again. */
export const SessionLinksParams = z.object({ since: Timestamp.optional() });
export const SessionLinksResult = z.object({
  pairs: z.array(SessionLinkPair).max(SESSION_LINK_PAIRS_MAX),
  links: z.array(SessionLinkEvent).max(SESSION_LINKS_RECENT_MAX),
});
export type SessionLinksResult = z.infer<typeof SessionLinksResult>;
