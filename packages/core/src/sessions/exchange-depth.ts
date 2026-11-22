// How far an exchange between sessions has gone without the person (the loop brake, lane CM): ONE store per session host, fed by
// the host as each turn of ANY session starts (a code session, a bot's agent, a bot's conversation or side thread), read by the
// bridge's `SendMessage` (agents/bridge/messenger.ts) and by the bots' own (bots/tools.ts), so a session's place in an exchange
// is the same whichever tool it sends with. Depth is read only from what the engine recorded on a delivery, never from anything
// a model wrote.
import { originOf, type TurnInput } from "../contracts/session-host";

/** How many messages an exchange between sessions may go without the person: a turn the person's own input started is at depth
 *  0, a turn another session's message started runs at the depth that message carried, and a send made during a turn at depth d
 *  is delivered at depth d + 1. A send that would be delivered beyond this is refused. */
export const EXCHANGE_DEPTH_LIMIT = 8;

/** The sentence a send refused by the brake gets (one wording, whichever tool sent it). */
export const brakeRefusal = (depth: number): string =>
  `This exchange has gone ${depth} messages between sessions without the person; stop here and wait for them to write to you.`;

/** The depth a turn's input puts its session at, or undefined where the input leaves the session's depth as it was.
 *  A missing or malformed one on another session's message counts as the most there is. */
export function depthStartedBy(input: TurnInput): number | undefined {
  switch (input.from) {
    // The person's own message (an unsigned relay is not verified as theirs: it leaves the depth as it was).
    case "user":
      return originOf(input) === "user" ? 0 : undefined;
    case "session":
    case "agent":
    case "bot": {
      const d = (input as { depth?: unknown }).depth;
      // A bot's or an agent's message without one is the bots' own send (bots/tools.ts), which starts an exchange of its own.
      if (d === undefined) return input.from === "session" ? EXCHANGE_DEPTH_LIMIT : 0;
      return typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= EXCHANGE_DEPTH_LIMIT ? d : EXCHANGE_DEPTH_LIMIT;
    }
    // A routine's run is the person's own, as is a session a bot started (it has no depth yet).
    case "routine":
      return 0;
    // A finished background task, a plugin's or the core's note: no new exchange, and none that ends one.
    case "task-notification":
    case "task":
    case "plugin":
    case "note":
    case "notice":
      return undefined;
  }
}

export class ExchangeDepths {
  /** The depth of each session's current exchange (absent: 0), set as a turn starts and when the person answers its card. A
   *  queued delivery carries its own depth in its recorded input, so a restart that runs it starts its turn at the depth it
   *  was sent with. */
  readonly #depths = new Map<string, number>();

  /** A turn of `session` starts on `input`: its depth is the one the input puts it at. */
  turnStarted(session: string, input: TurnInput): void {
    const d = depthStartedBy(input);
    if (d !== undefined) this.#set(session, d);
  }

  /** Another session's message folds into `session`'s RUNNING turn (no new turn starts): the exchange has gone at least as far as the
   *  message says, so the depth only rises (two sessions whose turns are always running would otherwise never count). */
  folded(session: string, input: TurnInput): void {
    const d = depthStartedBy(input);
    if (d !== undefined && d > this.depthOf(session)) this.#set(session, d);
  }

  /** The person answered one of `session`'s cards or questions: it is back at depth 0. */
  personSpoke(session: string): void {
    this.#set(session, 0);
  }

  /** How far the exchange `session`'s current turn is in has gone without the person. */
  depthOf(session: string): number {
    return this.#depths.get(session) ?? 0;
  }

  #set(session: string, d: number): void {
    if (d === 0) this.#depths.delete(session);
    else this.#depths.set(session, d);
  }
}
