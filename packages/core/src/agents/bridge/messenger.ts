// The engine's `SessionMessenger` (spec revision 20, §9.5; contracts/session-reach.ts): the door behind the bridge's
// `SendMessage` and `ListSessions` for every agent session, a bot's agent or one the person drives (an ACP agent, MOSS's
// own coding agent). Owner: lane CM.
//
// * **One rule.** Who may reach whom is the protocol's `reachRefusal` (reach.ts), read here and nowhere else for a bridge
//   send; the bots' `sendMessageRefusal` (bots/tools.ts) is the same function. `mayReach` adds only "not ended".
// * **Both ends carry their bot as `host.callerOf` reads it:** a session's own `bot`, else its parent's, up the chain, so a
//   session with no `bot` on its view but a bot's session as its parent is a bot's session here too (line 5 of the rule).
//   The listing and the send read the same resolved views, so `ListSessions` is exactly what `SendMessage` delivers to.
// * **Nothing of a session the sender may not reach leaves here.** A `to` by title is looked for only among the sessions the
//   sender may reach, and a name or an id that no reachable session answers to is refused in ONE sentence whether the id
//   is unknown, ended-and-forbidden or someone else's, so a refusal tells nothing about a session the sender may not reach.
//   Message text is never logged.
// * **The limit counts every send,** refused ones too, per sending session (a guess at ids cannot go on forever), and it is
//   taken before anything else is read.
// * A delivery is `{ from: "session" }` between two sessions the person drives (the receiver's `session_message`; its turn's
//   origin is `agent`, never the person's: `originOf`), `{ from: "agent" }` from a bot's agent and `{ from: "bot" }` from a
//   bot's own session, as today.
import {
  LIST_SESSIONS_MAX, ReachableSession, SESSION_MESSAGE_MAX_CHARS, SESSION_SEND_LIMIT, SESSION_SEND_WINDOW_MS, SendMessageToolInput,
  mayReach, reachRefusal, resolveSessionTo, type SessionView,
} from "@waifucave/moss-protocol";
import type { SessionMessenger, SessionMessengerWorld } from "../../contracts/session-reach";
import { originOf, type DeliveredInput, type TurnInput } from "../../contracts/session-host";

/** How many messages an exchange between sessions may go without the person (the loop brake): a turn the person's own input
 *  started is at depth 0, a turn another session's message started runs at the depth that message carried, and a send made
 *  during a turn at depth d is delivered at depth d + 1. A send that would be delivered beyond this is refused. */
export const EXCHANGE_DEPTH_LIMIT = 8;

/** What counts a session's sends: the bots' `SendLimiter` is one. */
export interface SendSlots {
  /** Takes one send for `session`; false when it is over the limit. */
  take(session: string): boolean;
}

/** The sends of each session over the last `SESSION_SEND_WINDOW_MS`. */
export function sendSlots(now: () => number): SendSlots {
  const sent = new Map<string, number[]>();
  return {
    take(session) {
      const t = now();
      const recent = (sent.get(session) ?? []).filter((at) => t - at < SESSION_SEND_WINDOW_MS);
      const ok = recent.length < SESSION_SEND_LIMIT;
      if (ok) recent.push(t);
      if (recent.length === 0) sent.delete(session);
      else sent.set(session, recent);
      return ok;
    },
  };
}

/** The world the engine's messenger stands on: `SessionMessengerWorld`, with a delivery the host answers later and a link
 *  the session graph may take (the graph, lane CG, hears each delivery through the host). */
export interface EngineMessengerWorld extends Omit<SessionMessengerWorld, "deliver" | "link"> {
  deliver(session: string, input: DeliveredInput): void | Promise<unknown>;
  link?(from: string, to: string): void;
}

const MAX_CHAIN = 8;

/** The views as the rule reads them: each carries its bot as `callerOf` gives it (its own, else its parent's). */
function withBots(sessions: readonly SessionView[]): Map<string, SessionView> {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const out = new Map<string, SessionView>();
  for (const s of sessions) {
    let bot = s.bot;
    let at: SessionView | undefined = s;
    for (let i = 0; bot === undefined && i < MAX_CHAIN && at?.parent !== undefined; i++) {
      at = byId.get(at.parent);
      bot = at?.bot;
    }
    out.set(s.id, bot === undefined || bot === s.bot ? s : { ...s, bot });
  }
  return out;
}

const isEnded = (s: SessionView) => s.status === "stopped" || s.status === "failed";

/** The depth a turn's input puts its session at, or undefined where the input leaves the session's depth as it was.
 *  Depth is read only from what the engine itself recorded on a delivery (never from anything a model wrote): a missing or
 *  malformed one on another session's message counts as the most there is. */
function depthStartedBy(input: TurnInput): number | undefined {
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

export class EngineSessionMessenger implements SessionMessenger {
  readonly #world: EngineMessengerWorld;
  readonly #slots: SendSlots;
  /** The depth of each session's current exchange (absent: 0), set as a turn starts and when the person answers its card. It
   *  lives here, beside the turn: a queued delivery carries its own depth in its recorded input, so a restart that runs it
   *  starts its turn at the depth it was sent with. */
  readonly #depths = new Map<string, number>();

  constructor(world: EngineMessengerWorld, slots: SendSlots = sendSlots(() => world.now())) {
    this.#world = world;
    this.#slots = slots;
  }

  /** A turn of `session` starts on `input` (the driver's hook): its depth is the one the input puts it at. */
  turnStarted(session: string, input: TurnInput): void {
    const d = depthStartedBy(input);
    if (d !== undefined) this.#setDepth(session, d);
  }

  /** The person answered one of `session`'s cards or questions: it is back at depth 0. */
  personSpoke(session: string): void {
    this.#setDepth(session, 0);
  }

  /** How far the exchange `session`'s current turn is in has gone without the person. */
  depthOf(session: string): number {
    return this.#depths.get(session) ?? 0;
  }

  #setDepth(session: string, d: number): void {
    if (d === 0) this.#depths.delete(session);
    else this.#depths.set(session, d);
  }

  reachable(from: string): ReachableSession[] {
    const views = withBots(this.#world.sessions());
    const me = views.get(from);
    if (me === undefined) return [];
    const out: ReachableSession[] = [];
    for (const s of views.values()) {
      if (out.length >= LIST_SESSIONS_MAX) break;
      if (mayReach(me, s)) out.push(ReachableSession.parse(s));
    }
    return out;
  }

  async send(from: string, raw: SendMessageToolInput): Promise<{ delivered: string } | { refused: string }> {
    // Every send counts, the refused ones too: first, before anything is read.
    if (!this.#slots.take(from)) return { refused: `Too many messages: at most ${SESSION_SEND_LIMIT} a minute. If you and another session are answering each other, stop.` };
    const text = (raw as { message?: unknown } | null | undefined)?.message;
    if (typeof text === "string" && text.length > SESSION_MESSAGE_MAX_CHARS) return { refused: `The message is ${text.length} characters; SendMessage takes at most ${SESSION_MESSAGE_MAX_CHARS}.` };
    const input = SendMessageToolInput.safeParse(raw);
    if (!input.success) return { refused: "SendMessage takes a message and, to name a session, `to`." };
    const views = withBots(this.#world.sessions());
    const me = views.get(from);
    if (me === undefined) return { refused: "This session isn't known here." };
    const reachable = [...views.values()].filter((s) => mayReach(me, s));
    let to: string;
    if (input.data.to === undefined) {
      // A bot's agent with no `to` messages the bot that started it; a session the person drives names one.
      if (me.bot === undefined || me.parent === undefined) return { refused: "Name the session with `to`; ListSessions lists the ones you may message." };
      to = me.parent;
    } else {
      if (input.data.to.trim() === me.id) return { refused: reachRefusal(me, me)! };
      const hit = resolveSessionTo(input.data.to, reachable);
      if ("error" in hit) return { refused: hit.error };
      to = hit.session;
    }
    const target = views.get(to);
    // The rule decides, on the views read above: the one place a bridge send is judged. A refusal says the same of a
    // session that does not exist as of one the sender may not reach.
    if (target === undefined || reachRefusal(me, target) !== undefined) {
      return { refused: input.data.to === undefined ? "The session that started you can't be messaged now." : `No session you may message is "${input.data.to.trim()}"; ListSessions lists the ones you may.` };
    }
    if (isEnded(target)) return { refused: `${to} has ended; it takes no messages.` };
    // The brake, after the rule has judged the target (so what it says tells nothing of a session the sender may not reach):
    // the depth of the sender's own turn, which the engine kept, and never anything the model wrote.
    const depth = this.depthOf(from);
    if (depth + 1 > EXCHANGE_DEPTH_LIMIT) {
      return { refused: `This exchange has gone ${depth} messages between sessions without the person; stop here and wait for them to write to you.` };
    }
    const at = depth + 1;
    const delivered: DeliveredInput = me.bot === undefined
      ? { from: "session", session: from, text: input.data.message, depth: at }
      : me.kind === "agent"
        ? { from: "agent", agent: from, text: input.data.message, depth: at }
        : { from: "bot", bot: me.bot, session: from, text: input.data.message, depth: at };
    try {
      await this.#world.deliver(to, delivered);
    } catch (err) {
      return { refused: `The message wasn't sent: ${err instanceof Error ? err.message : String(err)}` };
    }
    this.#world.link?.(from, to);
    return { delivered: to };
  }
}
