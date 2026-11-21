// Contract: SessionGraph (spec revision 20, §9.5 "The session graph"). Owner: lane CG.
//
// The engine's record of how sessions hang together, which it adds to every `SessionView` it serves (`startedBy`,
// `waiting`, `subagents`) and from which it sends the `session_link` event. The engine tells it facts as they happen (a
// session started, a background task began or ended, a subagent row, a delivery from one session to another); it
// derives the view's fields and the links. Real implementation: beside `sessions/durable-host.ts` (lane CG), fed from the
// host's `deliver`, the backends' task frames (`agents/moss-code/backend.ts`) and the ACP agents' reported subagents.
//
// What the contract promises:
// * `startedBy` is set once, at the start, and never changes; a session started by another counts as that one's child
//   until it ends (`waiting.children`), and a background task counts until it ends (`waiting.tasks`). Counts only.
// * A subagent row keeps its id for the parent's life; an update by the same id replaces it in place; `done` or `failed`
//   sets `endedAt` (the time given, or now); at most `SUBAGENTS_MAX`, dropping the oldest ended rows first, and never a
//   running one while an ended one remains.
// * A link names two different sessions it knows (or the person and one), carries no words (`SessionLinkEvent` is
//   strict), and is heard only by a reader that may read both ends' kinds (`pluginMayHear`'s rule; the user always).
// * Every change to a session's fields is heard once by `watch` (an unchanged one is not heard).
import type { SessionKind, SessionLinkEvent, SessionLinkKind, SessionStarter, SessionSubagent, SessionWaiting } from "@waifucave/moss-protocol";
import type { FeedReader } from "./activity-feed";
import type { Unsubscribe } from "./common";

/** The graph's fields of one session's view. */
export interface SessionGraphFields {
  startedBy?: SessionStarter;
  waiting?: SessionWaiting;
  subagents?: SessionSubagent[];
}

export interface SessionGraph {
  /** A session started: its kind, its bot if any, who started it. A second call for the same id is refused (`conflict`). */
  started(session: string, kind: SessionKind, by: SessionStarter, bot?: string): void;
  /** It stopped or failed: it no longer counts as its starter's child; its own tasks end with it. */
  ended(session: string): void;
  /** One of its background tasks that will wake it began, or ended. */
  taskStarted(session: string, task: string): void;
  taskEnded(session: string, task: string): void;
  /** A subagent its agent reported (added, or replaced by id). */
  subagent(parent: string, row: SessionSubagent): void;
  /** A delivery from `from` (a session, or the person when undefined) to `to`. Refused (`invalid`) for a session it doesn't
   *  know or a session to itself. */
  link(from: string | undefined, to: string, kind: SessionLinkKind): SessionLinkEvent;
  fields(session: string): SessionGraphFields;
  watch(fn: (change: { session: string; fields: SessionGraphFields }) => void): Unsubscribe;
  watchLinks(reader: FeedReader, fn: (link: SessionLinkEvent) => void): Unsubscribe;
}
