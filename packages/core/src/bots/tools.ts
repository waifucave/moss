// The bots' messaging tools (spec §6.7, §9.3): `SendMessage`, to another bot or any running session, folding into
// its turn (§6.4), and `ListAgents`, every running session with its status. Owner: lane D. Lane A's runtime registers
// them as core tools for bots' sessions (a bot's own conversation and its side threads), in the same neutral shape as
// lane K's `Agent` and `TaskStop`: a name, a description that stands on its own, a JSON Schema and a `run`. Background
// agents message their bot through the bridge's own `SendMessage` (lane K), which lands as an `agent` message.
//
// * **Who sends** is the calling session (`DurableSessionHost.callerOf`): the message reaches its target as a bot's
//   message (`from: "bot"`), naming the bot and the session it came from, so it folds in like any bot's message
//   and never counts as the user's.
// * **Where it goes:** a bot, by id or name, means its main conversation, wherever that runs (`BotService.deliverTo`
//   relays it to the computer running the bot); a session id means that session, here. An ended one takes nothing.
// * **The one rule** (the owner's rule of 2026-11-22, the protocol's `reachRefusal`, spec revision 20, §9.5; this tool is the door,
//   for agents too, and the bridge's `SendMessage` of every agent session reads the same function): a bot's own conversation or
//   side thread reaches any bot's conversation, its own bot's sessions and the sessions the user started themselves; a session a bot
//   created (a background agent) reaches its bot and any other session, another bot's conversation only after that bot has
//   messaged it first (`host.botsThatWrote`, the engine's durable record); never itself. A message to a session reaches it as that
//   session's (`from: "session"`, `session_message`), never the user's; a bot's agent's message to its own bot's conversation is
//   the agent's (`from: "agent"`).
// * **The exchange brake, for every target** (the same one as the bridge's send: sessions/exchange-depth.ts): a send is
//   delivered at the depth of the sending session's turn + 1 (`host.depths`, which the host sets as each turn of any
//   session starts and a message folding into a running turn raises), carried on the delivery, never taken from what a model
//   wrote; one that would be beyond EXCHANGE_DEPTH_LIMIT is refused in the bridge's words. So two bots answering each
//   other, a ring of bots, a bot and its agent, and a bot and a session the user started all stop at the limit unless the
//   person writes to one of them, which puts that session back to 0 (the 20-a-minute limit stays beside it).
import { reachRefusal, type SessionKind, type SessionView, type WroteFirst } from "@waifucave/moss-protocol";
import { isContractError } from "../contracts/common";
import type { DeliveredInput, Disposition } from "../contracts/session-host";
import type { DurableSessionHost } from "../sessions/durable-host";
import { EXCHANGE_DEPTH_LIMIT, brakeRefusal } from "../sessions/exchange-depth";
import { deliveredAs } from "../agents/bridge/messenger";
import { plainText, type BotService } from "./service";

/** A core tool in the neutral shape the runtime registers (lane K's `CoreToolDef`). */
export interface CoreToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(input: unknown): Promise<{ text: string; isError: boolean }>;
}

/** The longest message `SendMessage` takes. */
export const SEND_MESSAGE_MAX_CHARS = 100_000;
/** The most sessions `ListAgents` lists. */
export const LIST_AGENTS_MAX = 200;
/** How many messages one session may send in `SEND_WINDOW_MS`: enough for any real exchange, and two bots answering
 *  each other forever stop within a minute. */
export const SEND_MESSAGE_LIMIT = 20;
export const SEND_WINDOW_MS = 60_000;

/** Counts each session's sends over the last minute (shared by every session's tools). */
export class SendLimiter {
  readonly #now: () => number;
  readonly #sent = new Map<string, number[]>();
  constructor(now: () => number = Date.now) {
    this.#now = now;
  }
  /** Takes one send for `session`; false when it is over the limit. */
  take(session: string): boolean {
    const now = this.#now();
    const recent = (this.#sent.get(session) ?? []).filter((t) => now - t < SEND_WINDOW_MS);
    if (recent.length >= SEND_MESSAGE_LIMIT) {
      this.#sent.set(session, recent);
      return false;
    }
    recent.push(now);
    this.#sent.set(session, recent);
    return true;
  }
}

/** Lane K's background agents, as `ListAgents` lists them (the controller's ruling: one `ListAgents`, lane D's, with
 *  the agent rows from lane K): on any computer, with their status. */
export interface AgentRows {
  list(): SessionView[];
}

export interface BotToolsDeps {
  host: Pick<DurableSessionHost, "get" | "list" | "deliver" | "callerOf" | "depths" | "botsThatWrote">;
  bots: Pick<BotService, "list" | "has" | "mainSession" | "deliverTo">;
  /** Lane K's agent rows; without them, the agents are the host's own agent sessions. */
  agents?: AgentRows;
  /** The send limit, shared by every session's tools; one of the tools' own otherwise. */
  limiter?: SendLimiter;
}

const isEnded = (v: SessionView) => v.status === "stopped" || v.status === "failed";

function fail(text: string): { text: string; isError: true } {
  return { text, isError: true };
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return isContractError(err) ? `${msg} (${err.code})` : msg;
}

function str(input: unknown, key: string): string | undefined {
  const v = (input as Record<string, unknown> | null | undefined)?.[key];
  return typeof v === "string" ? v : undefined;
}

/** Why `from` may not message `target`, or undefined when it may (the one rule above): the protocol's `reachRefusal`
 *  (reach.ts, spec revision 20, §9.5), which the bridge's `SendMessage` for every agent session reads too. For a bot's
 *  session it answers exactly what this function always has. */
export function sendMessageRefusal(
  from: { sessionId: string; bot: string; kind?: SessionKind }, target: Pick<SessionView, "id" | "kind" | "bot" | "startedBy" | "parent">, wroteFirst?: WroteFirst,
): string | undefined {
  return reachRefusal({ id: from.sessionId, kind: from.kind ?? "bot", bot: from.bot }, target, wroteFirst);
}

/** The bots that have messaged `session` before, as the rule reads it (the host's durable record). */
const wroteTo = (host: Pick<DurableSessionHost, "botsThatWrote">, session: string): WroteFirst => {
  const bots = new Set(host.botsThatWrote(session));
  return (bot) => bots.has(bot);
};

/** Where a `SendMessage` from `sessionId` with this `to` goes: a bot (by its id, or its name when only one bot has it)
 *  reaches its conversation, anything else is a session id. The one resolution, for the tool and for its approval
 *  (`sendMessageTarget`), so the two never disagree. */
export type SendResolution =
  | { kind: "bot"; bot: string; session: string }
  | { kind: "session"; session: string }
  | { kind: "error"; text: string };

export function resolveSendTo(deps: Pick<BotToolsDeps, "bots">, names: ReadonlyMap<string, string>, sessionId: string, to: string): SendResolution {
  const byName = [...names].filter(([, name]) => name.toLowerCase() === to.toLowerCase()).map(([id]) => id);
  if (byName.length > 1 && !deps.bots.has(to)) return { kind: "error", text: `More than one bot is called "${to}" (${byName.join(", ")}); name one by its id.` };
  const bot = deps.bots.has(to) ? to : byName.length === 1 ? byName[0]! : undefined;
  return bot !== undefined ? { kind: "bot", bot, session: deps.bots.mainSession(bot) } : { kind: "session", session: to };
}

/** Where a bot's `SendMessage` with this `to` lands, for the approvals: undefined where the tool won't deliver it (no
 *  such bot or session, an ended one, or one `sendMessageRefusal` refuses), so its own answer stands. `own` is the
 *  bot's own session (its conversation, a side thread, an agent it started: the session's recorded bot is the
 *  caller's). */
export function sendMessageTarget(
  deps: Pick<BotToolsDeps, "host" | "bots">, sessionId: string, to: string,
): { session: string; own: boolean; computer: string; label: string } | undefined {
  const caller = deps.host.callerOf(sessionId);
  if (caller.bot === undefined) return undefined;
  const names = new Map(deps.bots.list().map((b) => [b.id, plainText(b.name)]));
  const r = resolveSendTo(deps, names, sessionId, to.trim());
  if (r.kind === "error" || r.session === sessionId) return undefined;
  const view = deps.host.get(r.session);
  if (r.kind === "bot") {
    // A bot's conversation this host doesn't hold yet (`deliverTo` reaches it all the same): its level is unknown here,
    // so a message to another bot's asks.
    const label = `the conversation of ${names.get(r.bot) ?? r.bot}`;
    return { session: r.session, own: r.bot === caller.bot, computer: view?.computer ?? "", label };
  }
  if (view === undefined || isEnded(view)) return undefined;
  if (sendMessageRefusal({ sessionId, bot: caller.bot, kind: caller.sessionKind }, view, wroteTo(deps.host, sessionId)) !== undefined) return undefined;
  const label = view.bot === undefined ? `the ${view.kind} session` : `${view.kind === "bot" ? "the conversation" : `a ${view.kind} session`} of ${names.get(view.bot) ?? view.bot}`;
  return { session: r.session, own: view.bot === caller.bot, computer: view.computer, label };
}

function what(disposition: Disposition): string {
  switch (disposition) {
    case "folded":
      return "it joins their running turn after its next tool call";
    case "turn":
      return "it starts their next turn now";
    case "queued":
      return "it waits for their next turn";
    case "interrupted":
      return "it interrupted their turn";
    case "note":
      return "it was added as a note";
  }
}

/** One line of `ListAgents`. */
export function describeSession(v: SessionView, botName: (id: string) => string | undefined, self: string): string {
  const parts = [v.id, v.kind];
  if (v.bot !== undefined) parts.push(`bot ${botName(v.bot) ?? v.bot}${botName(v.bot) !== undefined && botName(v.bot) !== v.bot ? ` (${v.bot})` : ""}`);
  parts.push(v.status + (v.failure ? ` (${v.failure})` : ""));
  parts.push(`on ${v.computer}`);
  if (v.backend) parts.push(`backend ${v.backend}`);
  if (v.model) parts.push(`model ${v.model}`);
  if (v.root) parts.push(`in ${v.root}`);
  if (v.routine) parts.push(`routine ${v.routine}`);
  if (v.definition) parts.push(`from the agent definition ${v.definition}`);
  if (v.title && v.kind !== "bot") parts.push(`"${v.title}"`);
  if (v.parent) parts.push(`for ${v.parent}`);
  return `- ${parts.join(" · ")}${v.id === self ? " · (this conversation)" : ""}`;
}

/** `SendMessage` and `ListAgents` for one bot session (`sessionId`: a bot's main conversation or a side thread). */
export function botToolDefs(deps: BotToolsDeps, sessionId: string): CoreToolDef[] {
  const { host, bots } = deps;
  const limiter = deps.limiter ?? new SendLimiter();
  const botNames = () => new Map(bots.list().map((b) => [b.id, plainText(b.name)]));
  return [
    {
      name: "SendMessage",
      description: [
        "Send a message to another bot's conversation, to one of your own bot's sessions (its conversation, its side",
        "threads (routine runs) and its background agents), or to a coding session the user started. Name a bot by its",
        "id or name to reach its conversation, or give a session id from ListAgents. The message joins the target's",
        "running turn after its next tool call, or starts its next turn when it is idle; a background agent gets it as",
        "its next prompt. It reaches them as a message from you, never as the user's, and a coding session still asks",
        "the user for what it does. Use it to hand over work, report back or ask another bot something; their answer,",
        "if any, comes back to you the same way (a coding session the user started cannot message a bot back).",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "A bot's id or name, or a session id from ListAgents." },
          message: { type: "string", description: "What to say. Write it to stand on its own: they see nothing else of this conversation." },
        },
        required: ["to", "message"],
        additionalProperties: false,
      },
      run: async (input) => {
        const to = str(input, "to")?.trim();
        const message = str(input, "message");
        if (!to) return fail("SendMessage needs `to`: a bot's id or name, or a session id.");
        if (message === undefined || message.trim() === "") return fail("SendMessage needs a message.");
        if (message.length > SEND_MESSAGE_MAX_CHARS) return fail(`The message is ${message.length} characters; SendMessage takes at most ${SEND_MESSAGE_MAX_CHARS}.`);
        const caller = host.callerOf(sessionId);
        if (caller.bot === undefined) return fail("SendMessage is a bot's tool; this session has no bot.");
        const names = botNames();
        const resolved = resolveSendTo(deps, names, sessionId, to);
        if (resolved.kind === "error") return fail(resolved.text);
        const bot = resolved.kind === "bot" ? resolved.bot : undefined;
        const target = resolved.session;
        const from = { sessionId, bot: caller.bot, kind: caller.sessionKind };
        const wrote = wroteTo(host, sessionId);
        if (target === sessionId) return fail(sendMessageRefusal(from, { id: target, kind: "bot", bot: caller.bot }, wrote)!);
        // An agent's message reads as its own (`agent_message`); a bot's session's as the bot's.
        if (!limiter.take(sessionId)) return fail(`You sent ${SEND_MESSAGE_LIMIT} messages in the last minute; wait before sending more. If you and another bot are answering each other, stop.`);
        // Every send has its place in the exchange (see above): the sender's turn depth + 1, read from the host's store (never from
        // anything in the message), carried on the delivery, and refused beyond the limit, whoever it goes to.
        const sentAt = host.depths.depthOf(sessionId) + 1;
        const input2: DeliveredInput = caller.sessionKind === "agent"
          ? { from: "agent", agent: sessionId, text: message, depth: sentAt }
          : { from: "bot", bot: caller.bot, session: sessionId, text: message, depth: sentAt };
        const asSession: DeliveredInput = { from: "session", session: sessionId, text: message, depth: sentAt };
        try {
          if (bot !== undefined) {
            const barred = sendMessageRefusal(from, { id: target, kind: "bot", bot }, wrote);
            if (barred !== undefined) return fail(barred);
            if (sentAt > EXCHANGE_DEPTH_LIMIT) return fail(brakeRefusal(sentAt - 1));
            // A bot's agent to ANOTHER bot's conversation is that session's own message, as the engine's messenger makes it.
            const { disposition } = await bots.deliverTo(bot, bot !== caller.bot && caller.sessionKind === "agent" ? asSession : input2);
            return { text: `Sent to ${names.get(bot) ?? bot} (${target}): ${what(disposition)}.`, isError: false };
          }
          const view = host.get(target);
          if (view === undefined) return fail(`No bot or session "${to}". ListAgents shows who is running.`);
          const refused = sendMessageRefusal(from, view, wrote);
          if (refused !== undefined) return fail(refused);
          if (isEnded(view)) return fail(`The session ${target} has ended (${view.status}); it takes no messages.`);
          if (sentAt > EXCHANGE_DEPTH_LIMIT) return fail(brakeRefusal(sentAt - 1));
          const { disposition } = await host.deliver(target, deliveredAs({ id: sessionId, kind: caller.sessionKind, bot: caller.bot }, view, message, sentAt));
          return { text: `Sent to ${target} (${view.kind}${view.bot === undefined ? "" : ` of ${names.get(view.bot) ?? view.bot}`}): ${what(disposition)}.`, isError: false };
        } catch (err) {
          return fail(`The message wasn't sent: ${errorText(err)}`);
        }
      },
    },
    {
      name: "ListAgents",
      description: [
        "List every running session, with its status: each bot's main conversation, side threads (routine runs),",
        "background agents and the user's own coding sessions. Your own background agents and side threads come",
        "first. Use the ids with SendMessage, and an agent's with TaskStop.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["bot", "side-thread", "agent", "coding"], description: "Only sessions of this kind." },
          bot: { type: "string", description: "Only this bot's sessions (its id)." },
        },
        additionalProperties: false,
      },
      run: async (input) => {
        const kind = str(input, "kind");
        const bot = str(input, "bot");
        const caller = host.callerOf(sessionId);
        const own = caller.bot === undefined ? undefined : bots.has(caller.bot) ? bots.mainSession(caller.bot) : undefined;
        const names = botNames();
        const rank = (v: SessionView) => {
          if ((v.parent !== undefined && (v.parent === sessionId || v.parent === own)) && v.kind !== "bot") return 0;
          return { bot: 1, "side-thread": 2, agent: 3, coding: 4 }[v.kind];
        };
        // The agents are lane K's rows when it gives them, in place of the host's own agent sessions.
        const agentRows = deps.agents?.list();
        const sessions = agentRows === undefined ? host.list() : [...host.list().filter((v) => v.kind !== "agent"), ...agentRows];
        const all = sessions
          .filter((v) => !isEnded(v))
          .filter((v) => kind === undefined || v.kind === kind)
          .filter((v) => bot === undefined || v.bot === bot)
          .filter((v) => v.kind !== "bot" || (v.bot !== undefined && bots.has(v.bot)))
          .sort((a, b) => rank(a) - rank(b) || a.startedAt - b.startedAt);
        if (all.length === 0) return { text: "No running sessions match.", isError: false };
        const shown = all.slice(0, LIST_AGENTS_MAX).map((v) => describeSession(v, (id) => names.get(id), sessionId));
        if (all.length > LIST_AGENTS_MAX) shown.push(`… and ${all.length - LIST_AGENTS_MAX} more; narrow it with kind or bot.`);
        return { text: shown.join("\n"), isError: false };
      },
    },
  ];
}
