// A bot's question that an engine stop withdrew BEFORE bot questions stopped waiting (§5.5, the change that made them open cards):
// the log holds its `question_asked`, a `question_resolved` by "aborted" with no answers, and the call closed with the core's
// own "Interrupted: MOSS stopped while this call ran" result. When nothing came after it, the conversation never moved on and the
// question is an open card again (the host asks it again at load, once).
//
// What a Stop press writes instead: the runtime answers the cut call itself (`[interrupted]`) before the turn ends, so the core's
// own closing result is not written for it. The core's result is written only for a call the runtime never closed (its child gone:
// a quit, an update's restart, a crash), which is what makes this reading safe. The one residue: a Stop whose runtime did not
// answer inside the interrupt grace gets the same closing, and reads as an engine stop; its question is last and unanswered, so it
// comes back as a card the person can answer or skip, and nothing is spent.
import type { SessionRecord } from "../contracts/session-host";

/** The start of the result the core gives a call it closes after an engine stop (`interruptedCallOutput()` with no remote computer). */
export const ENGINE_STOP_RESULT_PREFIX = "Interrupted: MOSS stopped while this call ran";

/** How far back from the end of a log the reading looks. A question older than this behind its end is not "the last thing". */
export const CUT_QUESTION_TAIL = 60;

export interface CutQuestion { callId: string; questions: unknown[] }

/** The question the tail of a bot's log shows withdrawn by an engine stop and not followed by anything of the conversation, or undefined. */
export function engineCutQuestion(tail: readonly SessionRecord[]): CutQuestion | undefined {
  const resolved = new Set<string>();
  const closedByStop = new Set<string>();
  for (let i = tail.length - 1; i >= 0; i--) {
    const r = tail[i]!;
    if (r.type === "status" || r.type === "turn_ended") continue;
    // The conversation went on (a message, a turn) or something else was said or called after the question: not the last thing.
    if (r.type !== "driver") return undefined;
    const e = r.event;
    const callId = typeof e["callId"] === "string" ? e["callId"] : undefined;
    switch (e.type) {
      case "question_resolved":
        if (callId !== undefined && e["by"] === "aborted" && (e["skipped"] ?? false) === false) resolved.add(callId);
        else return undefined;
        break;
      case "tool_result":
        if (callId !== undefined && typeof e["output"] === "string" && e["output"].startsWith(ENGINE_STOP_RESULT_PREFIX)) closedByStop.add(callId);
        break;
      case "question_asked":
        if (callId === undefined || !resolved.has(callId) || !closedByStop.has(callId)) return undefined;
        return { callId, questions: Array.isArray(e["questions"]) ? structuredClone(e["questions"] as unknown[]) : [] };
      case "assistant_message": case "tool_call":
        // The ask's own `tool_call` belongs before its `question_asked`; one after it is the bot moving on.
        return undefined;
      default:
        break;
    }
  }
  return undefined;
}
