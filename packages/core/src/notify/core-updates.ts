// The core's own updates for the notifiers (spec §10; `NotifierUpdate.kind`): what happened in a conversation that the
// user hasn't seen, handed to every `notifiers` entry through `NotifyService.core`. Watches the session host live (nothing
// replayed: a daemon boot raises no banner for what happened before it).
//
// A bot's conversation (`sessionKind: "bot"`, the MOSS phones' pushes):
// * a bot's turn the user didn't start ends normally (origin `bot`, `agent`, `plugin` or `peer`)      -> `message`
// * an agent's report reaches the bot's conversation (a `task-notification` input)                      -> `agent-finished`
// * a routine's result is posted into the bot's conversation (a `routine` input; `failed` as it says)   -> `routine-result`
// * a card or a question now waits in a conversation (`needsYou` went up)                                -> `card`, `question`
// * the user answers in it (their message, a card or a question taken off)                              -> `answered`: the count
//   starts again and the notifiers' banners go.
//
// A coding session or a background agent (`sessionKind: "coding"` / `"agent"`, the MOSS Code phones' pushes; the update names
// the session, never a bot, and its count is the session's own). What is pushed, in the spirit of no noise:
// * a card or a question now waits in it                                                                -> `card`, `question`
//   (the session needs the person, whoever started its turn)
// * a turn of it ends after running at least `FINISH_MIN_MS` (a long one the person has likely walked away from), normally
//   or failed (a refusal, an error: it needs the person too), in a session the person started                -> `agent-finished`
// * the user answers in it (their message, a card or question taken off) -> `answered`, as above.
// Nothing for the rest: no progress, no tool call, no status change, no short turn, no turn the person interrupted or
// stopped, no finish of an agent a bot or a routine started (its report reaches the bot's conversation, which pushes it to the
// MOSS phones above), and nothing for a side thread (a routine's run: its result reaches the bot's conversation).
//
// A turn the user started in a bot is not announced (they are waiting for it, and the app shows it), nor are the turns a
// routine's result or an agent's report start (their own kinds said it). No text of any message, card or question is read.
import type { Unsubscribe } from "../contracts/common";
import type { SessionKind, SessionView } from "@waifucave/moss-protocol";
import type { SessionHost, SessionRecord } from "../contracts/session-host";
import type { NotifierUpdate } from "@waifucave/moss-plugin-sdk";

export interface CoreNoticeSink {
  core(update: { kind: Exclude<NotifierUpdate["kind"], "notification">; bot?: string; session?: string; sessionKind?: SessionKind; failed?: boolean }): void;
  /** The user caught up: `key` is the bot's id for a bot's conversation, the session's id for a coding session or an agent. */
  answered(key: string): void;
}

/** The origins whose turn's end is a bot's message to the user. */
const MESSAGE_ORIGINS: ReadonlySet<string> = new Set(["bot", "agent", "plugin", "peer"]);

/** A coding session's or an agent's turn is announced as finished only when it ran at least this long: a shorter one is
 *  the person's own wait, in front of the app. */
export const FINISH_MIN_MS = 60_000;
/** The ends of a turn that leave the session needing the person: it finished, or it failed or was refused. An interrupt, a
 *  cancel or a stop is the person's (or the engine's) own doing. */
const FINISH_REASONS: ReadonlySet<string> = new Set(["end_turn", "failed", "refusal"]);

type Followable = "bot" | "coding" | "agent";

/** What a session is followed as, or undefined for one that is left alone (a side thread, a bot's view with no bot, one that
 *  has ended). */
function followedAs(view: SessionView): Followable | undefined {
  if (view.kind === "bot") return view.bot === undefined ? undefined : "bot";
  if (view.kind === "coding" || view.kind === "agent") return view.status === "stopped" || view.status === "failed" ? undefined : view.kind;
  return undefined;
}

/** Whether the person started this session: a coding session with no starter recorded is theirs (spec revision 20, §9.5), an
 *  agent's starter is read from its record only. */
function startedByPerson(view: SessionView): boolean {
  if (view.startedBy !== undefined) return view.startedBy.kind === "user";
  return view.kind === "coding" && view.parent === undefined && view.bot === undefined;
}

interface Followed {
  /** What `answered` counts by: the bot, or the session. */
  key: string;
  as: Followable;
  bot?: string;
  off: Unsubscribe;
  origin?: string;
  /** When the running turn started, on the shared clock. */
  turnStartedAt?: number;
  /** Whether the end of a turn here is announced (a coding session or an agent the person started). */
  finishes: boolean;
  cards: number;
  questions: number;
}

export class CoreNotices {
  readonly #followed = new Map<string, Followed>();
  readonly #offWatch: Unsubscribe;

  constructor(private readonly o: { host: Pick<SessionHost, "watch" | "list" | "subscribe">; sink: CoreNoticeSink; log?: (line: string) => void }) {
    this.#offWatch = o.host.watch((view) => this.#view(view));
    for (const kind of ["bot", "coding", "agent"] as const) for (const view of o.host.list({ kind })) this.#view(view);
  }

  close(): void {
    this.#offWatch();
    for (const f of this.#followed.values()) f.off();
    this.#followed.clear();
  }

  /** The update's own words: a bot's names its bot, a session's names only the session and its kind. */
  #named(f: Followed, id: string): { bot?: string; session: string; sessionKind: SessionKind } {
    return f.as === "bot" ? { bot: f.bot as string, session: id, sessionKind: "bot" } : { session: id, sessionKind: f.as };
  }

  #view(view: SessionView): void {
    const as = followedAs(view);
    let f = this.#followed.get(view.id);
    if (as === undefined) {
      // A coding session or an agent that has ended is let go of; a bot's conversation is followed for good.
      if (f !== undefined && f.as !== "bot") {
        f.off();
        this.#followed.delete(view.id);
      }
      return;
    }
    if (f === undefined) {
      try {
        const off = this.o.host.subscribe(view.id, (record) => this.#record(view.id, record));
        f = { key: as === "bot" ? (view.bot as string) : view.id, as, ...(as === "bot" ? { bot: view.bot as string } : {}), off, finishes: as !== "bot" && startedByPerson(view), cards: view.needsYou?.cards ?? 0, questions: view.needsYou?.questions ?? 0 };
      } catch (err) {
        this.o.log?.(`[notify] not following ${view.id}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      this.#followed.set(view.id, f);
      return;
    }
    if (as !== "bot") f.finishes = startedByPerson(view);
    const cards = view.needsYou?.cards ?? 0;
    const questions = view.needsYou?.questions ?? 0;
    if (cards > f.cards) this.o.sink.core({ kind: "card", ...this.#named(f, view.id) });
    if (questions > f.questions) this.o.sink.core({ kind: "question", ...this.#named(f, view.id) });
    // Something taken off (answered, withdrawn, timed out): the user has caught up with it.
    if (cards < f.cards || questions < f.questions) this.o.sink.answered(f.key);
    f.cards = cards;
    f.questions = questions;
  }

  #record(id: string, record: SessionRecord): void {
    const f = this.#followed.get(id);
    if (f === undefined) return;
    switch (record.type) {
      case "input": {
        const input = record.input;
        if (input.from === "user") this.o.sink.answered(f.key);
        // A bot's conversation hears an agent's report and a routine's result; a coding session or an agent is told neither.
        else if (f.as !== "bot") return;
        else if (input.from === "task-notification") this.o.sink.core({ kind: "agent-finished", ...this.#named(f, id) });
        else if (input.from === "routine") this.o.sink.core({ kind: "routine-result", ...this.#named(f, id), ...(input.failed === undefined ? {} : { failed: input.failed }) });
        return;
      }
      case "turn_started":
        f.origin = record.origin;
        f.turnStartedAt = record.ts;
        return;
      case "turn_ended": {
        const ran = f.turnStartedAt === undefined ? 0 : record.ts - f.turnStartedAt;
        if (f.as === "bot") {
          if (record.end.reason === "end_turn" && f.origin !== undefined && MESSAGE_ORIGINS.has(f.origin)) this.o.sink.core({ kind: "message", ...this.#named(f, id) });
        } else if (f.finishes && FINISH_REASONS.has(record.end.reason) && ran >= FINISH_MIN_MS) {
          this.o.sink.core({ kind: "agent-finished", ...this.#named(f, id) });
        }
        f.origin = undefined;
        f.turnStartedAt = undefined;
        return;
      }
      default:
        return;
    }
  }
}
