// MOSS protocol: who may message whom (spec revision 20, §9.5 "Who may reach whom"). Owner: lane CM (the cross-session
// tools). Pinned by lane CS (the canvas's spine).
//
// ONE rule for every session that messages another: a bot's own conversation and side threads (the bots' `SendMessage` in
// `packages/core/src/bots/tools.ts`, which delegates here) and every agent session, a bot's background agent or one the person
// drives (an ACP agent's or MOSS's own coding agent's, through the bridge's `SendMessage` and `ListSessions`). Each line says who
// ruled it: the owner, the controller, or the spine (a proposal).
//
// The owner's rule of 2026-11-22 (his words): "a session created by a bot may message that bot and any other session. that
// session cannot message other bots unless they message it first. a session created by the user may message any other session,
// it still cannot message bots unless these bots message it first". Read as: a "bot" is the bot itself (its conversation and
// its side threads), a "session" is a coding or agent session whoever started it; "messaged it first" is the engine's own
// durable record that the bot's conversation or a side thread of it (its `SendMessage`) delivered a message to THAT session
// (`DurableSessionHost.botsThatWrote`), never anything a model says. What a bot's own conversation or side thread may reach
// is as merged before (any bot's conversation, its own sessions, the sessions the person started).
//
// What it never changes: each session's own approvals stay its own (the owner's words of 2026-11-21). A message from
// another session is never the person's: the turn it starts has origin `agent`, so a card it raises expires
// unanswered like any turn the person did not start (§5.5).
import { z } from "zod";
import { utf16 } from "./strings";
import { SessionId, type SessionKind } from "./common";
import { SessionView, type SessionStatus } from "./sessions";
import type { SessionStarter } from "./session-graph";

/** The tools every agent session gets for other sessions, by these names on every backend (the bridge's own tools,
 *  in-process for MOSS's coding agent): send a message to another session, and list the sessions it may reach. */
export const CROSS_SESSION_TOOLS = { send: "SendMessage", list: "ListSessions" } as const;

/** The longest message `SendMessage` takes (the bots' `SEND_MESSAGE_MAX_CHARS`). */
export const SESSION_MESSAGE_MAX_CHARS = 100_000;
/** How many messages one session may send in `SESSION_SEND_WINDOW_MS`, the same for bots and agent sessions and counted
 *  per sending session (the bots' `SEND_MESSAGE_LIMIT`). It caps a sender's rate, not an exchange: two sessions answering
 *  each other would go on at up to this many a minute each, so the engine's messenger also counts how far an exchange has
 *  gone without the person and refuses a send beyond `EXCHANGE_DEPTH_LIMIT` (agents/bridge/messenger.ts). */
export const SESSION_SEND_LIMIT = 20;
export const SESSION_SEND_WINDOW_MS = 60_000;
/** The most sessions `ListSessions` lists (the bots' `LIST_AGENTS_MAX`). */
export const LIST_SESSIONS_MAX = 200;

/** `SendMessage`'s input: `to` is a session's id, or its title when exactly one session it may reach has it (ignoring
 *  case). A bot's agent may leave `to` out: its bot's conversation (today's tool). An agent session the person drives
 *  must name one. */
export const SendMessageToolInput = z.strictObject({
  message: utf16(SESSION_MESSAGE_MAX_CHARS, 1),
  to: utf16(200, 1).optional(),
});
export type SendMessageToolInput = z.infer<typeof SendMessageToolInput>;

/** `ListSessions`'s input: none. It lists what `SendMessage` from this session would deliver to, and nothing else, so a
 *  session never learns of one it may not reach. */
export const ListSessionsToolInput = z.strictObject({});

/** A session as `ListSessions` gives it to an agent: enough to pick one by id or title, nothing of its words. */
export const ReachableSession = SessionView.pick({ id: true, kind: true, title: true, status: true, backend: true, bot: true, parent: true, startedBy: true });
export type ReachableSession = z.infer<typeof ReachableSession>;

/** A session as the rule reads it. */
export interface ReachEnd {
  id: string;
  kind: SessionKind;
  bot?: string | undefined;
  status?: SessionStatus;
  /** What says whether the person started a session themselves (`startedByPerson`): who started it, and its parent. */
  startedBy?: SessionStarter | undefined;
  parent?: string | undefined;
}

/** Whether the person started this session themselves, as opposed to a session that another one started (a child). A
 *  session from before revision 20 carries no `startedBy`: a coding session the person started had no parent. */
export function startedByPerson(t: Pick<ReachEnd, "startedBy" | "parent">): boolean {
  return t.startedBy !== undefined ? t.startedBy.kind === "user" : t.parent === undefined;
}

/** Each line of the rule, in the order it is read, with who ruled it. */
export const REACH_RULE_LINES = [
  { line: "Never itself.", ruled: "controller" },
  { line: "A bot's own conversation or side thread reaches any bot's conversation, every session of its own bot, and the sessions the person started themselves (not what another session started, nor another bot's side threads or agents).", ruled: "owner" },
  { line: "A session a bot created (a background agent, and what it starts) reaches that bot's conversation and side threads, and any other session: the person's, its siblings, another bot's agents, children of any of them.", ruled: "owner" },
  { line: "A session the person created (a code session, and what it starts) reaches any other session, a session a bot created included.", ruled: "owner" },
  { line: "A session reaches another bot's conversation or side threads only after that bot has messaged it first (the engine's record of a bot's message to that very session).", ruled: "owner" },
  { line: "An ended session takes nothing.", ruled: "controller" },
] as const;

/** Whether a bot has messaged the sending session before (the engine's durable record): the third thing the rule reads. */
export type WroteFirst = (bot: string) => boolean;

/** Why `from` may not message `target` (the lines above, ended aside), or undefined when it may. `wroteFirst` answers
 *  whether a bot's conversation or side thread has messaged `from` before; absent, none has. */
export function reachRefusal(
  from: Pick<ReachEnd, "id" | "kind" | "bot">,
  target: Pick<ReachEnd, "id" | "kind" | "bot" | "startedBy" | "parent">,
  wroteFirst?: WroteFirst,
): string | undefined {
  const botItself = target.kind === "bot" || target.kind === "side-thread";
  if (from.kind === "bot" || from.kind === "side-thread") {
    if (target.id === from.id) return "That is this conversation; SendMessage reaches another one.";
    if (target.kind === "bot") return undefined;
    if (target.bot !== undefined && target.bot === from.bot) return undefined;
    if (target.bot === undefined) {
      const code = target.kind === "coding" || target.kind === "agent";
      if (code && startedByPerson(target)) return undefined;
      if (code) return `${target.id} is a session another of the user's sessions started; SendMessage reaches your bot's sessions, other bots' conversations and the sessions the user started themselves.`;
      return `${target.id} is the user's own ${target.kind} session; SendMessage reaches only your bot's sessions, other bots' conversations and the sessions the user started themselves.`;
    }
    return `${target.id} belongs to the bot ${target.bot}; message that bot's conversation instead (SendMessage with to: "${target.bot}").`;
  }
  // A session (a coding or agent session): the one the person created, or one a bot created (it carries its bot).
  if (target.id === from.id) return "That is this session; SendMessage reaches another one.";
  if (!botItself) return undefined;
  if (target.bot !== undefined && (target.bot === from.bot || wroteFirst?.(target.bot) === true)) return undefined;
  return `${target.id} is ${target.kind === "bot" ? "a bot's conversation" : "a bot's side thread"}; a session reaches a bot only after that bot has messaged it first${from.bot === undefined ? "" : " (your own bot always)"}.`;
}

/** Whether `from` may deliver to `target` now: the rule, and the target not ended. */
export function mayReach(from: Pick<ReachEnd, "id" | "kind" | "bot">, target: ReachEnd, wroteFirst?: WroteFirst): boolean {
  return target.status !== "stopped" && target.status !== "failed" && reachRefusal(from, target, wroteFirst) === undefined;
}

/** Where a `to` lands among the sessions `from` may reach (`reachable`, already filtered by `mayReach`): an exact id, else
 *  the one session whose title is `to` ignoring case. */
export function resolveSessionTo(to: string, reachable: readonly { id: string; title?: string | undefined }[]):
  | { session: string }
  | { error: string } {
  const t = to.trim();
  if (reachable.some((s) => s.id === t)) return { session: t };
  const byTitle = reachable.filter((s) => s.title !== undefined && s.title.toLowerCase() === t.toLowerCase());
  if (byTitle.length === 1) return { session: byTitle[0]!.id };
  if (byTitle.length > 1) return { error: `More than one session is called "${t}" (${byTitle.map((s) => s.id).join(", ")}); name one by its id.` };
  return { error: `No session you may message is ${SessionId.safeParse(t).success ? "" : "called "}"${t}"; ListSessions lists the ones you may.` };
}
