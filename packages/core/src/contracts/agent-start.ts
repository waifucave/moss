// Contract: AgentStartOptions (spec revision 20, §9.5 "Starting a session from a part"). Owner: lane CA (the engine's
// `agent.options` and `agent.recent`, beside `agents/manager.ts`; the app's door forwards a part's `agent.start` with its
// model, effort and first message, `apps/desktop/src/main/ui/tree-calls.ts`).
//
// What the contract promises:
// * `options` answers before any session exists: MOSS's coding agent from the model catalog (`source: "catalog"`,
//   `known: true`, its default the person's default model and its effort); an ACP agent from what its quirks say
//   (`quirks`) or a probe found (`probe`); otherwise `known: false`, `source: "unknown"`, no models: "unknown until
//   started" is a valid answer. A backend no plugin gives is `not_found`.
// * `remember` keeps the person's last start (never a bot's, a spawn's or a routine's: the caller passes only the
//   person's): its backend, model, effort and computer, and its folder first among `roots`, a folder started in again
//   moved to the front, at most `RECENT_FOLDERS_MAX`. `recent` answers it; before any start, nothing but `roots: []`.
// * The folders are tree paths: `recent` is for the app's main process and the CLI, which hand a page pick tokens
//   (`UiPickResult.recent`), never a path.
import type { AgentBackendOptions, RecentStart } from "@waifucave/moss-protocol";

export interface PersonStart {
  backend: string;
  computer: string;
  root: string;
  model?: string;
  effort?: string;
}

export interface AgentStartOptions {
  options(backend: string, computer?: string): Promise<AgentBackendOptions>;
  remember(start: PersonStart, at: number): void;
  recent(): RecentStart;
}
