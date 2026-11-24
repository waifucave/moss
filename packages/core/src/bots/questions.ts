// A bot session's `AskUserQuestion` (spec §5.5: the question is the bot's; the user, or a plugin that shows it, answers
// it with `session.answer`). Owner: lane D.
//
// The question goes through the daemon's existing machinery, as a code or chat session's does: the runtime's
// `canUseTool` sees `AskUserQuestion`, `askUserQuestionBridge` records `question_asked` in the session's log (so the
// session's view counts it in `needsYou`, and every client sees it), parks on the `QuestionBroker`, and gives the
// answers back to the model as the tool's `updatedInput.answers`; `question_resolved` follows. `session.answer`
// resolves the broker. Any other tool call goes on to the session's own `canUseTool`.
//
// The 10-minute rule (§5.5, protocol `UNATTENDED_CARD_TIMEOUT_MS`): a question from a turn the user's own message did
// not start (a routine's, a plugin's, another session's, a relayed one) is denied when nobody answers it in 10 minutes,
// so the model gets a typed deny and the turn goes on; one from the user's own turn waits for them. The origin is read
// when the question is asked, as the dispatch child's `dispatchCardTimeoutMs` reads its own.
import type { CanUseTool } from "@waifucave/clover-agent-sdk";
import { UNATTENDED_CARD_TIMEOUT_MS, type NewSessionEvent, type TurnOrigin } from "@waifucave/moss-protocol";
import { QuestionBroker } from "../agent/questions";
import { ASK_USER_QUESTION_TOOL, askUserQuestionBridge } from "../runtime-sdk/question-bridge";
import type { DurableSessionHost } from "../sessions/durable-host";
import { cutQuestion } from "./open-questions";

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
    // The exact text always wins; otherwise the one question whose cut form this is.
    const found = own.includes(key) ? [key] : [...new Set(own.filter((q) => cutQuestion(q) === key))];
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

export interface BotQuestions {
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

export function botQuestions(o: {
  host: Pick<DurableSessionHost, "get" | "recordCore" | "turnOrigin">;
  warn?: (message: string) => void;
  /** The 10-minute rule's wait (tests shorten it). */
  unattendedMs?: number;
}): BotQuestions {
  const broker = new QuestionBroker();
  /** The questions each waiting card asks, by `sessionId:callId`: the keys an answer may use. */
  const asked = new Map<string, readonly string[]>();
  const key = (sessionId: string, callId: string) => `${sessionId}:${callId}`;
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
        return bridge(opts.toolUseID, input, { signal: opts.signal, ...(opts.agentID === undefined ? {} : { agentID: opts.agentID }) });
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
