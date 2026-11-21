// MOSS protocol: who may message whom (spec revision 20, §9.5 "Who may reach whom"). Owner: lane CM (the cross-session
// tools). Pinned by lane CS (the canvas's spine).
//
// ONE rule for every session that messages another: a bot's (its conversation, side threads and background agents,
// today's "one rule" in `packages/core/src/bots/tools.ts`, which lane CM makes delegate here with no change to what it
// answers) and every agent session the person drives (an ACP agent's or MOSS's own coding agent's, through the bridge's
// `SendMessage` and `ListSessions`). Each line says who ruled it: the owner, the controller, or the spine (a proposal).
//
// What it never changes: each session's own approvals stay its own (the owner's words of 2026-11-21). A message from
// another session is never the person's: the turn it starts has origin `agent`, so a card it raises expires
// unanswered like any turn the person did not start (§5.5).
import { z } from "zod";
import { utf16 } from "./strings";
import { SessionId, type SessionKind } from "./common";
import { SessionView, type SessionStatus } from "./sessions";

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
}

/** Each line of the rule, in the order it is read, with who ruled it. */
export const REACH_RULE_LINES = [
  { line: "Never itself.", ruled: "controller" },
  { line: "A bot's session (its conversation, a side thread, a background agent) reaches any bot's conversation.", ruled: "controller" },
  { line: "A bot's session reaches every session of its own bot.", ruled: "controller" },
  { line: "A bot's session never reaches the person's own code sessions.", ruled: "controller" },
  { line: "A bot's session never reaches another bot's side threads or agents.", ruled: "controller" },
  { line: "A session the person drives (no bot) reaches the person's other code sessions and its own children.", ruled: "owner" },
  { line: "A session the person drives reaches the children of the person's other code sessions too: they are the person's.", ruled: "spine" },
  { line: "A session the person drives never reaches a bot's conversation (a session a bot started carries that bot, and is a bot's session above).", ruled: "spine" },
  { line: "A session the person drives never reaches a bot's side threads or agents.", ruled: "spine" },
  { line: "An ended session takes nothing.", ruled: "controller" },
] as const;

/** Why `from` may not message `target` (the lines above, ended aside), or undefined when it may. The bot branch answers
 *  exactly what today's `sendMessageRefusal` (bots/tools.ts) answers. */
export function reachRefusal(from: Pick<ReachEnd, "id" | "bot">, target: Pick<ReachEnd, "id" | "kind" | "bot">): string | undefined {
  if (from.bot !== undefined) {
    if (target.id === from.id) return "That is this conversation; SendMessage reaches another one.";
    if (target.kind === "bot") return undefined;
    if (target.bot === from.bot) return undefined;
    if (target.bot === undefined) return `${target.id} is the user's own ${target.kind} session; SendMessage reaches only your bot's sessions and other bots' conversations.`;
    return `${target.id} belongs to the bot ${target.bot}; message that bot's conversation instead (SendMessage with to: "${target.bot}").`;
  }
  if (target.id === from.id) return "That is this session; SendMessage reaches another one.";
  if (target.bot === undefined && (target.kind === "coding" || target.kind === "agent")) return undefined;
  if (target.kind === "bot") return `${target.id} is a bot's conversation; a session you drive reaches only your other code sessions.`;
  return `${target.id} belongs to the bot ${target.bot ?? "?"}; a session you drive reaches only your other code sessions.`;
}

/** Whether `from` may deliver to `target` now: the rule, and the target not ended. */
export function mayReach(from: Pick<ReachEnd, "id" | "bot">, target: ReachEnd): boolean {
  return target.status !== "stopped" && target.status !== "failed" && reachRefusal(from, target) === undefined;
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
