// Contract: ProgramOpener (spec revision 20, §9.5 "Opening a place in the other program"). Owner: lane CA (the engine's
// `app.openIn`, in `ipc/moss.ts` beside the router; MOSS's `app.show` handler honouring `what`, `apps/moss/src/main`).
//
// A window's main process asks, on the person's own press in a part, for a place in the OTHER program of the pair: "Open
// in MOSS" (a bot's conversation), "Open in MOSS Code" (a session's tab). The engine routes it to that program's window
// connection as `app.show`, starting the program first when it isn't running (the launcher the host's menu uses for
// "open MOSS"), and answers once the window took it.
//
// What the contract promises:
// * Only a place that program opens (`OPEN_IN_PLACES`): anything else is refused, never guessed; the caller's own program
//   is refused too (that is `shell.go`'s); the host is never a target (the schema has no such program).
// * A running program gets `app.show` at once (`started: false`); one not running is started, and gets it once its window
//   connects (`started: true`), exactly once; a start that never connects within `OPEN_IN_START_MS` answers refused.
import type { AppOpenInResult, AppShowWhat, WindowProgram } from "@waifucave/moss-protocol";

/** How long a started program has to connect its window before `app.openIn` gives up. */
export const OPEN_IN_START_MS = 20_000;

export interface ProgramOpenerWorld {
  connected(program: WindowProgram): boolean;
  /** Sends `app.show` to that program's window connection. */
  show(program: WindowProgram, what: AppShowWhat): Promise<void>;
  /** Starts the program; resolves true once its window connected, false when it didn't within the time. */
  start(program: WindowProgram, withinMs: number): Promise<boolean>;
}

export interface ProgramOpener {
  openIn(caller: WindowProgram, program: WindowProgram, what: AppShowWhat): Promise<AppOpenInResult>;
}
