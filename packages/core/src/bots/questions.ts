// A bot session's `AskUserQuestion` (spec §5.5: the question is the bot's; the user, or a plugin that shows it, answers
// it with `session.answer`). Owner: lane D.
//
// The question goes through the daemon's existing machinery, as a code or chat session's does: the runtime's
// `canUseTool` sees `AskUserQuestion`, `askUserQuestionBridge` records `question_asked` in the session's log (so the
// session's view counts it in `needsYou`, and every client sees it), parks on the `QuestionBroker`, and gives the
// answers back to the model as the tool's `updatedInput.answers`; `question_resolved` follows. `session.answer`
// resolves the broker. Any other tool call goes on to the session's own `canUseTool`.
//
// A BOT'S OWN conversation (kind "bot") is different: its question does not wait. The call returns at once with fixed words (`ASKED_REPLY`),
// `question_asked` goes in the log, and the card stays open — across turns, a quit, a restart or a crash — until the person answers or
// skips it (`settleOpen`), which is recorded and then reaches the bot as the person's own message (`answerText`). Nothing is parked in
// memory, so no 10-minute rule and no long park apply to it; a bot has at most `OPEN_CARDS_MAX` open cards. The blocking bridge below is
// what a side thread's question (a routine's: nobody is there to answer later) and every coding agent's question still use.
//
// The 10-minute rule (§5.5, protocol `UNATTENDED_CARD_TIMEOUT_MS`): a question from a turn the user's own message did
// not start (a routine's, a plugin's, another session's, a relayed one) is denied when nobody answers it in 10 minutes,
// so the model gets a typed deny and the turn goes on; one from the user's own turn waits for them. The origin is read
// when the question is asked, as the dispatch child's `dispatchCardTimeoutMs` reads its own.
import type { CanUseTool, PermissionResult } from "@waifucave/clover-agent-sdk";
import { UNATTENDED_CARD_TIMEOUT_MS, type NewSessionEvent, type TurnOrigin } from "@waifucave/moss-protocol";
import { QuestionBroker } from "../agent/questions";
import { ASK_USER_QUESTION_TOOL, askUserQuestionBridge, askedQuestions } from "../runtime-sdk/question-bridge";
import type { DurableSessionHost, OpenQuestion as HeldQuestion } from "../sessions/durable-host";
import { clip, cutQuestion } from "./open-questions";

/** What `answer` makes of an answer: given to the model, or refused (`not_found`: no such question is waiting, the
 *  losing answerer of a race included; `invalid`: it answers, or notes, a question the card didn't ask). */
export type AnswerOutcome = { ok: true } | { ok: false; code: "not_found" | "invalid"; message: string };

/** Maps each key of an answer or its notes to the exact text of the question it names: the question's own text, or, for a text
 *  `session.openQuestions` cut, that exact cut form (computed by the same function, `cutQuestion`). A key naming no question of the
 *  call, naming two (their cut forms are the same), or two keys naming one question are refused with a plain message. */
export function questionKeys(own: readonly string[], keys: readonly string[]): { ok: true; of: ReadonlyMap<string, string> } | { ok: false; message: string } {
  const of = new Map<string, string>();
  const named = new Map<string, string>();
  for (const key of keys) {
    // The exact text of a question, or the cut form of one; a key that is both (one question's exact text is another's cut form: a
    // question of exactly 2,000 units ending in "…" beside a longer one cut to it) names two questions and is refused, never guessed.
    const found = [...new Set(own.filter((q) => q === key || cutQuestion(q) === key))];
    if (found.length === 0) return { ok: false, message: `doesn't ask ${JSON.stringify(key.slice(0, 200))}` };
    if (found.length > 1) return { ok: false, message: `has more than one question that is cut to ${JSON.stringify(key.slice(0, 200))}; the key names none of them` };
    const exact = found[0]!;
    const twice = named.get(exact);
    if (twice !== undefined && twice !== key) return { ok: false, message: `is answered by two keys that name the same question (${JSON.stringify(key.slice(0, 80))})` };
    named.set(exact, key);
    of.set(key, exact);
  }
  return { ok: true, of };
}

/** What a bot's `AskUserQuestion` returns at once: the question is on the person's screen and the turn is not waiting for it. */
export const ASKED_REPLY = "Asked. The person may answer whenever they like, or skip it; the answer will arrive as a message from them. Carry on with what doesn't depend on it, or end your turn.";

/** How many open question cards one bot conversation may hold; a fifth call is refused with `tooManyOpenReply`. */
export const OPEN_CARDS_MAX = 4;
export const tooManyOpenReply = (open: number): string => `Not asked: you already have ${open} questions open that the person has not answered or skipped yet. Wait for one of them, and do not ask the same thing twice.`;

/** The bot's words as one JSON-quoted line: control characters and line breaks become spaces, then cut. */
const quote = (text: string, max: number): string => JSON.stringify(clip(text.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]+/g, " "), max));

/** The person's answer to (or skip of) a bot's open question, as the message the bot gets. Everything the BOT wrote (the question, the option labels) is
 *  JSON-quoted on one line and cut; the fixed words are ours; what the person chose is named by the stored label (quoted), and their own typed words and
 *  notes are marked as theirs. So nothing the bot wrote can read as the person's words. */
export function answerText(card: Pick<HeldQuestion, "questions">, answers: Readonly<Record<string, string>>, notes: Readonly<Record<string, string>> | undefined, skipped: boolean): string {
  const asked = card.questions.slice(0, 4).flatMap((raw) => {
    const q = raw as { question?: unknown; options?: unknown };
    if (typeof q.question !== "string" || q.question === "") return [];
    const options = (Array.isArray(q.options) ? q.options : []).slice(0, 4).flatMap((o) => (typeof (o as { label?: unknown })?.label === "string" ? [(o as { label: string }).label] : []));
    return [{ text: q.question, options }];
  });
  /** What was given for a question: the stored labels it names (quoted), or the person's own words (marked). */
  const givenOf = (q: { options: string[] }, given: string): string => {
    const parts = given.split(", ");
    const chosen = q.options.includes(given) ? [given] : parts.length > 1 && parts.every((p) => q.options.includes(p)) ? parts : undefined;
    return chosen !== undefined ? `chose ${chosen.map((c) => quote(c, 80)).join(", ")}` : `their own words: ${clip(given, 2000)}`;
  };
  const lines = asked.map((q) => {
    const opts = q.options.length === 0 ? "" : ` (options: ${q.options.map((o) => quote(o, 80)).join(" / ")})`;
    if (skipped) return `${quote(q.text, 300)}${opts}`;
    const given = answers[q.text];
    const note = notes?.[q.text];
    return `${quote(q.text, 300)}${opts}: ${given === undefined ? "(no answer)" : givenOf(q, given)}${note === undefined || note === "" ? "" : ` (their note: ${clip(note, 1000)})`}`;
  });
  if (skipped) return lines.length === 1 ? `I skipped your question ${lines[0]}. Carry on without an answer.` : `I skipped your questions. Carry on without an answer:\n${lines.map((l) => `- ${l}`).join("\n")}`;
  return lines.length === 1 ? `My answer to your question ${lines[0]}` : `My answers to your questions:\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

/** What `settleOpen` makes of an answer or a skip: recorded (`text` is the message to send the bot, `undo` asks the card again if sending it fails),
 *  or refused (`not_found`: no such open question: answered or skipped already, the losing answerer of a race included; `invalid`: it answers
 *  a question the card didn't ask). */
export type SettleOutcome = { ok: true; text: string; undo(): void } | { ok: false; code: "not_found" | "invalid"; message: string };

export interface BotQuestions {
  /** The open card `callId` of a bot's own conversation, as the log holds it; undefined for anything else (a question still parked on the broker included). */
  openCard(sessionId: string, callId: string): HeldQuestion | undefined;
  /** The person's answer or skip of an open card: recorded (`question_resolved`, by "user", `skipped` set for a skip) before anything is sent. */
  settleOpen(sessionId: string, callId: string, given: { answers: Record<string, string>; notes?: Record<string, string>; skipped: boolean }): SettleOutcome;
  /** True for an open card this process settled lately (its newest few hundred): a second answer to it is told so, in plain words. */
  wasSettled(sessionId: string, callId: string): boolean;
  /** After a start: an answer or skip that was recorded but never reached the bot (the engine stopped between the two steps) is sent now, from the log,
   *  under the same `question-<callId>` client id (a host that already holds it sends nothing: never twice). Returns how many it sent. */
  replayUnsent(sessionId: string): Promise<number>;
  readonly broker: QuestionBroker;
  /** The session's `canUseTool` with its `AskUserQuestion` asked of the user; any other call goes to `inner`. */
  canUseTool(sessionId: string, inner: CanUseTool): CanUseTool;
  /** `session.answer`: answers the question `callId` of `sessionId`, if it is still waiting, with answers and notes
   *  keyed by its own questions' texts. The first answer wins; a later one is `not_found`. */
  answer(sessionId: string, callId: string, answers: Record<string, string>, by: string, notes?: Record<string, string>): AnswerOutcome;
}

/** How long a question from a turn of `origin` waits: the user's own turn's, for them; any other's, 10 minutes. */
export function questionTimeoutMs(origin: TurnOrigin | undefined, unattendedMs: number = UNATTENDED_CARD_TIMEOUT_MS): number | undefined {
  return origin === "user" ? undefined : unattendedMs;
}

/** How many of a conversation's newest records `replayUnsent` reads. */
const REPLAY_TAIL = 400;

export function botQuestions(o: {
  host: Pick<DurableSessionHost, "get" | "recordCore" | "turnOrigin" | "openQuestions"> & Partial<Pick<DurableSessionHost, "history" | "sentAs" | "sendUser" | "length">>;
  warn?: (message: string) => void;
  /** The 10-minute rule's wait (tests shorten it). */
  unattendedMs?: number;
}): BotQuestions {
  const broker = new QuestionBroker();
  /** The questions each waiting card asks, by `sessionId:callId`: the keys an answer may use. */
  const asked = new Map<string, readonly string[]>();
  const key = (sessionId: string, callId: string) => `${sessionId}:${callId}`;
  const settledLately = new Set<string>();
  const openCardOf = (sessionId: string, callId: string): HeldQuestion | undefined => {
    if (o.host.get(sessionId)?.kind !== "bot" || broker.isPending(sessionId, callId)) return undefined;
    return o.host.openQuestions(sessionId).find((q) => q.callId === callId);
  };
  /** A bot's question: validated as the blocking one is, refused past the cap, put in the log as a card, and answered at once with `ASKED_REPLY`. */
  const askWithoutWaiting = (sessionId: string, callId: string, input: unknown): PermissionResult => {
    const asked = askedQuestions(input);
    if (!asked.ok) return { behavior: "deny", message: asked.message };
    const open = o.host.openQuestions(sessionId);
    if (open.some((q) => q.callId === callId)) return { behavior: "deny", message: ASKED_REPLY };
    if (open.length >= OPEN_CARDS_MAX) return { behavior: "deny", message: tooManyOpenReply(open.length) };
    o.host.recordCore(sessionId, { type: "question_asked", callId, questions: asked.questions });
    return { behavior: "deny", message: ASKED_REPLY };
  };
  return {
    broker,
    canUseTool(sessionId, inner) {
      const bridge = askUserQuestionBridge({
        sessionId, threadId: sessionId, questions: broker,
        timeoutMs: () => questionTimeoutMs(o.host.turnOrigin(sessionId), o.unattendedMs),
        // The question and its answer go in the session's own log, as the driver's other events do.
        emit: (event: NewSessionEvent) => {
          if (event.type === "question_asked") asked.set(key(sessionId, event.callId), [...new Set(event.questions.map((q) => q.question))]);
          else if (event.type === "question_resolved") asked.delete(key(sessionId, event.callId));
          if (o.host.get(sessionId) === undefined) return;
          o.host.recordCore(sessionId, event as unknown as { type: string; [key: string]: unknown });
        },
        ...(o.warn === undefined ? {} : { log: { info: () => {}, error: (message: string) => o.warn!(`${sessionId}: ${message}`) } }),
      });
      return (toolName, input, opts) => {
        if (toolName !== ASK_USER_QUESTION_TOOL) return inner(toolName, input, opts);
        // A bot's own conversation asks without waiting; a side thread's question (and a bot's agent's) is the blocking one.
        if (o.host.get(sessionId)?.kind === "bot" && opts.agentID === undefined) return Promise.resolve(askWithoutWaiting(sessionId, opts.toolUseID, input));
        return bridge(opts.toolUseID, input, { signal: opts.signal, ...(opts.agentID === undefined ? {} : { agentID: opts.agentID }) });
      };
    },
    async replayUnsent(sessionId) {
      const { history, length, sentAs, sendUser } = o.host;
      if (o.host.get(sessionId)?.kind !== "bot" || history === undefined || length === undefined || sentAs === undefined || sendUser === undefined) return 0;
      // The newest records only: a question this old that was never delivered would have been replayed at an earlier start.
      const log = history.call(o.host, sessionId, { afterSeq: Math.max(-1, length.call(o.host, sessionId) - REPLAY_TAIL) });
      const cards = new Map<string, readonly unknown[]>();
      const last = new Map<string, { answers: Record<string, string>; notes?: Record<string, string>; skipped: boolean } | undefined>();
      for (const r of log) {
        if (r.type !== "driver") continue;
        const e = r.event as { type: string; callId?: string; questions?: readonly unknown[]; by?: string; answers?: Record<string, string>; notes?: Record<string, string>; skipped?: boolean };
        if (typeof e.callId !== "string") continue;
        if (e.type === "question_asked") { cards.set(e.callId, e.questions ?? []); last.set(e.callId, undefined); }
        else if (e.type === "question_resolved") last.set(e.callId, e.by === "user" ? { answers: e.answers ?? {}, ...(e.notes === undefined ? {} : { notes: e.notes }), skipped: e.skipped === true } : undefined);
      }
      let sent = 0;
      for (const [callId, given] of last) {
        const card = cards.get(callId);
        if (given === undefined || card === undefined) continue;
        const clientMessageId = `question-${callId}`;
        if (sentAs.call(o.host, sessionId, clientMessageId) !== undefined) continue;
        try {
          await sendUser.call(o.host, sessionId, { text: answerText({ questions: [...card] }, given.answers, given.notes, given.skipped), device: "core", sentAt: Date.now(), clientMessageId });
          sent++;
        } catch (err) {
          o.warn?.(`${sessionId}: the person's answer to ${callId} was recorded but could not be sent to the bot again: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return sent;
    },
    openCard: (sessionId, callId) => openCardOf(sessionId, callId),
    wasSettled: (sessionId, callId) => settledLately.has(key(sessionId, callId)),
    settleOpen(sessionId, callId, given) {
      const card = openCardOf(sessionId, callId);
      if (card === undefined) return { ok: false, code: "not_found", message: `the question ${callId} was already answered or skipped, or is not open in ${sessionId}` };
      const own = [...new Set(card.questions.flatMap((q) => (typeof (q as { question?: unknown }).question === "string" ? [(q as { question: string }).question] : [])))];
      if (!given.skipped && Object.keys(given.answers).length === 0) return { ok: false, code: "invalid", message: `question ${callId} needs an answer, or to be skipped` };
      const keys = questionKeys(own, [...Object.keys(given.answers), ...Object.keys(given.notes ?? {})]);
      if (!keys.ok) return { ok: false, code: "invalid", message: `question ${callId} ${keys.message}` };
      const exact = (m: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(m).map(([k, v]) => [keys.of.get(k)!, v]));
      const answers = given.skipped ? {} : exact(given.answers);
      const notes = given.skipped || given.notes === undefined ? undefined : exact(given.notes);
      // Recorded first; from here the question is no longer open, so a second answer finds nothing (first wins).
      settledLately.add(key(sessionId, callId));
      if (settledLately.size > 500) settledLately.delete(settledLately.values().next().value as string);
      o.host.recordCore(sessionId, {
        type: "question_resolved", callId, answers, by: "user",
        ...(notes !== undefined && Object.keys(notes).length > 0 ? { notes } : {}),
        ...(given.skipped ? { skipped: true } : {}),
      });
      const asked = card.questions;
      return {
        ok: true,
        text: answerText(card, answers, notes, given.skipped),
        // The message could not be sent: the card is asked again, as it was, so nothing the person chose is lost or counted as sent.
        undo: () => { o.host.recordCore(sessionId, { type: "question_asked", callId, questions: asked }); },
      };
    },
    answer(sessionId, callId, answers, by, notes) {
      const notWaiting = { ok: false as const, code: "not_found" as const, message: `no question ${callId} is waiting in ${sessionId}` };
      const own = asked.get(key(sessionId, callId));
      if (own === undefined || !broker.isPending(sessionId, callId)) return notWaiting;
      // A phone answers by the text `session.openQuestions` gave it, which is cut when long: that cut form names the question too.
      const keys = questionKeys(own, [...Object.keys(answers), ...Object.keys(notes ?? {})]);
      if (!keys.ok) return { ok: false, code: "invalid", message: `question ${callId} ${keys.message}` };
      const exact = (given: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(given).map(([k, v]) => [keys.of.get(k)!, v]));
      // The broker's own first-answer-wins: an answer that lost a race since the check above is refused too.
      if (broker.respond(sessionId, callId, exact(answers), by, notes === undefined ? undefined : exact(notes)).alreadyResolved) return notWaiting;
      return { ok: true };
    },
  };
}
