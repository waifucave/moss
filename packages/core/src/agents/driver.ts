// The session driver for an ACP agent (spine `SessionDriver`, contracts/session-host.ts): the session host keeps the
// agent's state, log, queue and task notifications; this runs its turns on the agent.
//
// * It can't fold (`canFold: false`): ACP has no standard mid-turn input, so the host queues a message that arrives
//   during a turn and sends it as the next prompt (S5 §8).
// * The agent starts lazily, in the first turn, so `Agent` returns at once (§9.3 "starts a background agent and
//   returns at once"). A sign-in the agent needs, a crash, or a stall ends the turn `failed` with that reason, and the
//   agent's process is ended with it, since the host gives a failed session no further turns.
// * The agent's events are recorded in the session's log as the driver's own (`ctl.record`): text and thinking
//   coalesced into runs of at most a quarter second, tool calls and their updates as they come. That log is the live
//   transcript a client follows (`session.attach`); `acp.ndjson` is the raw wire.
// * The user's interrupt is ACP's `session/cancel`; `stop` cancels, then ends the agent's process group.
// * Everything recorded and the turn's final text pass `redact` first (review 9): the bridge's token must not reach the
//   session's log through the agent's own words or a tool call's input.
import type { AgentEvent, AgentSession, AgentTurnEnd } from "../contracts/agent-backend";
import { isContractError } from "../contracts/common";
import type { SessionDriver, TurnControl, TurnEnd, TurnInput } from "../contracts/session-host";
import type { ToolApp, ToolDisplay, TurnOrigin } from "@waifucave/moss-protocol";

/** How long an agent started early (`AgentDriver.warm`) waits for the first message of its session. A session the person
 *  opened and never wrote in must not keep an agent process running for good: after this, the process is stopped, and the
 *  first message (whenever it comes) starts it as it always did. */
export const WARM_IDLE_MS = 10 * 60_000;

export interface AgentDriverOptions {
  /** Runs `fn` once after `ms` (the manager's clock) and gives the way to cancel it. Absent: an agent started early
   *  is never stopped for waiting. */
  after?(ms: number, fn: () => void): () => void;
  /** How long `warm`'s agent may wait for the first message. Default `WARM_IDLE_MS`. */
  warmIdleMs?: number;
  /** Starts the agent (or reattaches to it); called by the first turn, or before it by `warm` (`warm: true`: the session
   *  was opened and nobody has typed yet, so a start that would ask the person anything fails instead of asking). */
  start(o?: { warm?: boolean }): Promise<AgentSession>;
  /** The prompt a turn's input becomes. */
  promptOf(input: TurnInput): Promise<{ text: string; images?: { mimeType: string; data: string }[] }>;
  /** The agent started (each time it does): what it reported of itself, for the per-agent memory of its models. */
  started?(session: AgentSession): void;
  /** Called once the agent's process is gone for good: revoke the token, stop watching. */
  ended?(): void;
  /** A turn failed and the agent's process was stopped, but the session stays open: revoke the token, stop watching,
   *  clear what belonged to that process. The next turn's `start()` brings a new one. */
  released?(): void;
  /** How long text may wait before it is recorded. */
  coalesceMs?: number;
  /** Applied to every record and to each turn's text before they leave the driver. */
  redact?: <T>(value: T) => T;
  /** Before each prompt: what changed since the last turn reaches the agent (the pause switch, its computer's level).
   *  It may wait (paused); a `refused` error refuses the turn and keeps the agent. */
  beforeTurn?(session: AgentSession): Promise<AgentSession | void>;
  /** A line the person should read before this turn runs (the agent keeps the plugin tools it started with): recorded
   *  in the session's log as a notice, never sent to the agent. Asked after `beforeTurn`; undefined says nothing. */
  noticeBeforeTurn?(): string | undefined;
  /** A turn starts, from this input and origin (before the agent is started or asked anything): what the conversation
   *  saw, as a bot's turn reports it (the addresses the user gave, the fetch budget's reset). */
  turnStarted?(input: TurnInput, origin: TurnOrigin | undefined): void;
  /** What the conversation shows of a plugin tool's call beside its name, as a bot's turn shows it: the tool's declared
   *  title by the call's title (`tool_call.displayTitle`), and what its successful result showed, taken once
   *  (`tool_result.display`). Display only. */
  toolShows?: AgentToolShows;
}

/** How a session's agent calls find their plugin tool's display (the manager's, from the bridge). */
export interface AgentToolShows {
  /** The plugin tool's declared title for a call titled so (`mcp__moss_<hex>__<tool>`, …), or none. */
  title(callTitle: string): string | undefined;
  /** What the call's result showed, by its title and input, taken once; none for a call with no display. */
  take(callTitle: string, rawInput: unknown): ToolDisplay | undefined;
  /** MCP Apps: the page a plugin tool's call named, bound under the agent's call id; taken once. */
  takeApp?(callTitle: string, rawInput: unknown, callId: string): ToolApp | undefined;
}

/** The most calls whose title and input the driver keeps for their end. */
const CALLS_KEPT = 256;

/** What the driver records in the session's log. */
export type AgentLogEvent =
  | { type: "agent_text"; text: string }
  | { type: "agent_thought"; text: string }
  | { type: "agent_tool_call"; id: string; kind: string; title: string; status: string; rawInput?: unknown; displayTitle?: string }
  | { type: "agent_tool_call_update"; id: string; status: string; refused?: boolean; closedByMoss?: boolean; output?: string; display?: ToolDisplay; app?: ToolApp }
  | { type: "agent_usage"; inputTokens: number; outputTokens: number }
  /** The call `id` started a subagent of the agent's own (§9.5): the session's view lists it as a row (the host's
   *  graph); never sent to clients as an event of its own. */
  | { type: "agent_subagent"; id: string; name: string; model?: string }
  | { type: "agent_started"; agentSessionId: string }
  /** MOSS's own word to the person about this agent, not the agent's (`hook_notice` on the wire). */
  | { type: "agent_notice"; text: string };

/** A turn's usage as the session records it: the agent's counts, and the context it says it uses (`contextTokens`, which
 *  the session's context reads), either alone. */
export function usageOf(end: AgentTurnEnd): { usage?: { inputTokens: number; outputTokens: number; contextTokens?: number } } {
  if (end.usage === undefined && end.contextTokens === undefined) return {};
  return { usage: { inputTokens: end.usage?.inputTokens ?? 0, outputTokens: end.usage?.outputTokens ?? 0, ...(end.contextTokens === undefined ? {} : { contextTokens: end.contextTokens }) } };
}

export class AgentDriver implements SessionDriver {
  readonly canFold = false;
  readonly #opts: AgentDriverOptions;
  #session: AgentSession | undefined;
  #starting: Promise<AgentSession> | undefined;
  #origin: TurnOrigin | undefined;
  #signal: AbortSignal | undefined;
  #stopping = false;
  #stalled = false;
  #ended = false;
  #pendingModel: { model: string; effort?: string } | undefined;
  /** The `agent_started` record of the running process was made (by the first turn that ran on it). */
  #announced = false;
  /** Cancels the stop of an agent started early that nobody has written to. */
  #idleOff: (() => void) | undefined;
  /** The calls seen, by id, for their end's display. */
  readonly #calls = new Map<string, { title: string; rawInput: unknown }>();

  constructor(opts: AgentDriverOptions) {
    this.#opts = opts;
  }

  get session(): AgentSession | undefined {
    return this.#session;
  }

  /** The running turn's origin, for the approval request: only the user's own turn makes a card wait (§5.5). */
  currentOrigin(): TurnOrigin | undefined {
    return this.#origin;
  }

  /** The running turn's signal: a request the turn made is withdrawn with it. */
  currentSignal(): AbortSignal | undefined {
    return this.#signal;
  }

  busy(): boolean {
    return this.#origin !== undefined;
  }

  /** Starts the agent now, before the first message, for a session opened and not typed into yet: the first message then
   *  finds it running. Never asks anything (the start fails where it would need a card) and never throws: a start that
   *  fails here is simply made again, as it always was, by the first turn. */
  async warm(): Promise<void> {
    if (this.#stopping || this.#ended || this.#session || this.#starting) return;
    const ok = await this.#ensure(true).then(() => true, () => false);
    // Nobody has typed: it is let go after `WARM_IDLE_MS` if no turn has begun by then.
    // Never after a stop or the daemon's close (`detach`): the Clock has no unref, so a timer armed then would hold the
    // engine's event loop for the whole wait. `stop`, `detach` and the first turn cancel it.
    if (ok && !this.#stopping && !this.#ended && this.#origin === undefined && !this.#announced && this.#opts.after !== undefined) {
      this.#idleOff?.();
      this.#idleOff = this.#opts.after(this.#opts.warmIdleMs ?? WARM_IDLE_MS, () => {
        this.#idleOff = undefined;
        if (this.#origin === undefined && !this.#announced) void this.#release();
      });
    }
  }

  #cancelIdle(): void {
    this.#idleOff?.();
    this.#idleOff = undefined;
  }

  async #ensure(warm = false): Promise<AgentSession> {
    if (this.#session) return this.#session;
    // A start already running (a turn, or `warm`) is joined, never made twice.
    if (this.#starting) return this.#starting;
    const starting: Promise<AgentSession> = this.#opts.start(warm ? { warm: true } : undefined).then(async (s) => {
      this.#session = s;
      try { this.#opts.started?.(s); } catch { /* a memory that can't be written never stops a session */ }
      if (this.#pendingModel) {
        const m = this.#pendingModel;
        this.#pendingModel = undefined;
        await s.setConfig("model", m.model);
        if (m.effort !== undefined) await s.setConfig("effort", m.effort).catch(() => {});
      }
      return s;
    }).catch((err: unknown) => {
      // A start that failed is not kept: the next try starts again.
      if (this.#starting === starting) this.#starting = undefined;
      throw err;
    });
    this.#starting ??= starting;
    return this.#starting;
  }

  async turn(input: TurnInput, ctl: TurnControl): Promise<TurnEnd> {
    const end = await this.#turn(input, ctl);
    // A failed turn says why in the conversation (the wire's turn end carries no text): the provider's own words, or MOSS's, as a
    // notice the person reads before they send again. The session is open, so what to do next is theirs to see.
    if (end.reason === "failed" && end.text !== undefined && end.text.trim() !== "") this.#record(ctl, { type: "agent_notice", text: end.text.trim().slice(0, 600) });
    return this.#opts.redact && end.text !== undefined ? { ...end, text: this.#opts.redact(end.text) } : end;
  }

  #record(ctl: TurnControl, e: AgentLogEvent): void {
    const shown = this.#shown(e);
    ctl.record(this.#opts.redact ? this.#opts.redact(shown) : shown);
  }

  /** A plugin tool's call with its title, and its successful end with what it showed (`toolShows`). */
  #shown(e: AgentLogEvent): AgentLogEvent {
    const shows = this.#opts.toolShows;
    if (shows === undefined) return e;
    try {
      if (e.type === "agent_tool_call") {
        this.#calls.delete(e.id);
        this.#calls.set(e.id, { title: e.title, rawInput: e.rawInput });
        while (this.#calls.size > CALLS_KEPT) this.#calls.delete(this.#calls.keys().next().value!);
        const title = shows.title(e.title);
        return title === undefined ? e : { ...e, displayTitle: title };
      }
      if (e.type === "agent_tool_call_update" && (e.status === "completed" || e.status === "failed")) {
        const call = this.#calls.get(e.id);
        this.#calls.delete(e.id);
        if (call === undefined || e.status !== "completed" || e.refused === true) return e;
        const display = shows.take(call.title, call.rawInput);
        const app = shows.takeApp?.(call.title, call.rawInput, e.id);
        return display === undefined && app === undefined ? e : { ...e, ...(display === undefined ? {} : { display }), ...(app === undefined ? {} : { app }) };
      }
    } catch {
      // Display only: a lookup that throws shows nothing more.
    }
    return e;
  }

  async #turn(input: TurnInput, ctl: TurnControl): Promise<TurnEnd> {
    if (this.#stopping) return { reason: "stopped" };
    this.#cancelIdle();
    this.#origin = ctl.origin;
    this.#signal = ctl.signal;
    try { this.#opts.turnStarted?.(input, ctl.origin); } catch { /* an observer never stops a turn */ }
    let session: AgentSession;
    try {
      // The agent that cannot be started is tried once more before the turn says so.
      session = await this.#ensure().catch((err: unknown) => (isContractError(err, "refused") ? Promise.reject(err) : this.#ensure()));
      // Said once per process, by the first turn on it (the process may have been started before that turn, by `warm`).
      if (!this.#announced) {
        this.#announced = true;
        this.#record(ctl, { type: "agent_started", agentSessionId: session.agentSessionId });
      }
    } catch (err) {
      this.#origin = undefined;
      this.#signal = undefined;
      return this.#fail(err);
    }
    if (this.#opts.beforeTurn) {
      try {
        // It may hand back the agent restarted under a new bridge token (a token nearing its expiry).
        const replaced = await this.#opts.beforeTurn(session);
        if (replaced) {
          this.#session = replaced;
          session = replaced;
        }
      } catch (err) {
        this.#origin = undefined;
        this.#signal = undefined;
        if (isContractError(err, "refused")) return { reason: "refusal", text: err instanceof Error ? err.message : String(err) };
        return this.#fail(err);
      }
      if (ctl.signal.aborted) {
        this.#origin = undefined;
        this.#signal = undefined;
        return { reason: "interrupted" };
      }
    }
    const notice = this.#opts.noticeBeforeTurn?.();
    if (notice !== undefined) this.#record(ctl, { type: "agent_notice", text: notice });
    const flusher = new TextRuns((e) => this.#record(ctl, e), this.#opts.coalesceMs ?? 250);
    let heard = false;
    const off = session.onEvent((e) => { if (e.type !== "progress") heard = true; flusher.push(e); });
    const onAbort = () => {
      if (!this.#stopping) void session.cancel();
    };
    ctl.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const prompt = await this.#opts.promptOf(input);
      const end = await session.prompt(prompt);
      flusher.flush();
      if (this.#stalled) return await this.#failStalled();
      if (this.#stopping) return { reason: "stopped", text: end.text };
      switch (end.stopReason) {
        case "cancelled":
          return ctl.signal.aborted ? { reason: "interrupted", text: end.text } : { reason: "cancelled", text: end.text, ...usageOf(end) };
        case "refusal":
          return { reason: "refusal", text: end.text, ...usageOf(end) };
        case "error":
          await this.#release();
          return { reason: "failed", failure: "error", text: end.text };
        default:
          // A turn that ends with no word, no event of any kind and no tokens never reached the model (an end the agent
          // took from something else than this message): the person typed and nothing came back. It is said, and the agent
          // starts afresh for the next message, instead of a silent end.
          if (!heard && end.text === "" && end.usage === undefined) {
            await this.#release();
            return { reason: "failed", failure: "error", text: "The agent ended the turn without answering. Send your message again." };
          }
          return { reason: "end_turn", text: end.text, ...usageOf(end) };
      }
    } catch (err) {
      flusher.flush();
      if (this.#stalled) return await this.#failStalled();
      if (this.#stopping) return { reason: "stopped" };
      return this.#fail(err);
    } finally {
      off();
      ctl.signal.removeEventListener("abort", onAbort);
      this.#origin = undefined;
      this.#signal = undefined;
    }
  }

  async #failStalled(): Promise<TurnEnd> {
    await this.#release();
    return { reason: "failed", failure: "stalled", text: "The agent made no progress for 10 minutes, so MOSS stopped it." };
  }

  async #fail(err: unknown): Promise<TurnEnd> {
    await this.#release();
    const text = err instanceof Error ? err.message : String(err);
    if (isContractError(err, "sign_in")) return { reason: "failed", failure: "sign-in", text };
    if (isContractError(err, "closed")) return { reason: "failed", failure: "crashed", text: "The agent's process exited." };
    return { reason: "failed", failure: "error", text };
  }

  async interrupt(): Promise<void> {
    await this.#session?.cancel();
  }

  /** The watchdog found no progress for 10 minutes: the turn ends `failed`, `stalled`. */
  async stall(): Promise<void> {
    if (this.#stopping || this.#ended) return;
    this.#stalled = true;
    await this.#session?.stop();
  }

  async setModel(model: string, effort?: string): Promise<void> {
    if (!this.#session) {
      this.#pendingModel = { model, ...(effort === undefined ? {} : { effort }) };
      return;
    }
    await this.#session.setConfig("model", model);
    if (effort !== undefined) await this.#session.setConfig("effort", effort);
  }

  async stop(): Promise<void> {
    this.#cancelIdle();
    this.#stopping = true;
    await this.#shutdown();
  }

  /** The daemon is closing: the agent's process ends, and the session isn't ended (no `ended`), so a later daemon
   *  can reattach it. */
  async detach(): Promise<void> {
    this.#cancelIdle();
    this.#stopping = true;
    this.#ended = true;
    const s = this.#session ?? (await this.#starting?.catch(() => undefined));
    await s?.stop().catch(() => {});
  }

  /** A failed turn: the agent's process stops and what belonged to it is let go, and the session stays open: the next
   *  turn starts the agent again (by its history if it has said anything, afresh if not). A real end is `#shutdown`'s. */
  async #release(): Promise<void> {
    if (this.#stopping || this.#ended) return;
    const s = this.#session ?? (await this.#starting?.catch(() => undefined));
    this.#session = undefined;
    this.#starting = undefined;
    this.#announced = false;
    this.#stalled = false;
    await s?.stop().catch(() => {});
    this.#opts.released?.();
  }

  async #shutdown(): Promise<void> {
    const s = this.#session ?? (await this.#starting?.catch(() => undefined));
    await s?.stop().catch(() => {});
    if (!this.#ended) {
      this.#ended = true;
      this.#opts.ended?.();
    }
  }
}

/** Coalesces text and thinking chunks into runs, so the log isn't one record per word. */
class TextRuns {
  #kind: "agent_text" | "agent_thought" | undefined;
  #text = "";
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly record: (e: AgentLogEvent) => void,
    readonly ms: number,
  ) {}

  push(e: AgentEvent): void {
    if (e.type === "text" || e.type === "thought") {
      const kind = e.type === "text" ? "agent_text" : "agent_thought";
      if (this.#kind !== kind) this.flush();
      this.#kind = kind;
      this.#text += e.text;
      if (this.#text.length >= 4096) this.flush();
      else this.#timer ??= setTimeout(() => this.flush(), this.ms);
      return;
    }
    this.flush();
    switch (e.type) {
      case "tool_call":
        this.record({ type: "agent_tool_call", id: e.id, kind: e.kind, title: e.title, status: e.status, ...(e.rawInput === undefined ? {} : { rawInput: e.rawInput }) });
        return;
      case "tool_call_update":
        this.record({ type: "agent_tool_call_update", id: e.id, status: e.status, ...(e.refused ? { refused: true } : {}), ...(e.closedByMoss ? { closedByMoss: true } : {}), ...(e.output !== undefined ? { output: e.output } : {}) });
        return;
      case "usage":
        this.record({ type: "agent_usage", inputTokens: e.inputTokens, outputTokens: e.outputTokens });
        return;
      case "subagent":
        this.record({ type: "agent_subagent", id: e.id, name: e.name, ...(e.model === undefined ? {} : { model: e.model }) });
        return;
      default:
        return;
    }
  }

  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#kind && this.#text) this.record({ type: this.#kind, text: this.#text });
    this.#kind = undefined;
    this.#text = "";
  }
}
