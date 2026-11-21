// Contract: SessionMessenger (spec revision 20, §9.5 "Who may reach whom"). Owner: lane CM (the cross-session tools of
// every agent session: an ACP agent's bridge `SendMessage` and `ListSessions`, MOSS's coding agent's in-process bridge).
//
// The door behind `bridge.sendMessage` and `bridge.listSessions` for any session, bot's or not. THE RULE is the
// protocol's `reachRefusal` (reach.ts), one function for bots' sessions and the sessions the person drives, each line
// marked with who ruled it (`REACH_RULE_LINES`); `bots/tools.ts`'s `sendMessageRefusal` delegates to it (lane CM).
//
// What the contract promises:
// * `send` delivers only where `mayReach` says, to a session named by its id or its one matching title
//   (`resolveSessionTo`); a bot's agent with no `to` reaches its bot's conversation (its `parent`); a session the person
//   drives must name one. Each refusal is a sentence the agent can act on; nothing is delivered.
// * At most `SESSION_SEND_LIMIT` sends per sending session in `SESSION_SEND_WINDOW_MS`; a send over it is refused and
//   delivers nothing.
// * A delivery records its sender: between two sessions that are no bot's, `{ from: "session", session }` (the wire's
//   `session_message`); from a bot's agent to its bot's sessions, `{ from: "agent" }` as today; from a bot's session,
//   `{ from: "bot" }` as today. Each delivery is one `session_link` of kind `message`.
// * `reachable` lists exactly the sessions `send` would deliver to (not ended, the rule allows), at most
//   `LIST_SESSIONS_MAX`, so an agent never learns of a session it may not reach.
import type { ReachableSession, SendMessageToolInput, SessionView } from "@waifucave/moss-protocol";
import type { DeliveredInput } from "./session-host";

export interface SessionMessenger {
  send(from: string, input: SendMessageToolInput): Promise<{ delivered: string } | { refused: string }>;
  reachable(from: string): ReachableSession[];
}

/** What the messenger stands on: the sessions as the host holds them, the host's delivery and the graph's link. */
export interface SessionMessengerWorld {
  sessions(): readonly SessionView[];
  deliver(session: string, input: DeliveredInput): void;
  link(from: string, to: string): void;
  now(): number;
}
