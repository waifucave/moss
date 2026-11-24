// A bot's question (`AskUserQuestion`, spec §5.5) as the conversation draws it: one message per `callId`, which reads
// pending while the question waits, and answered (with what was chosen), expired (no answer in time) or withdrawn (the turn
// was stopped or ended, another question took its place) once the engine's log says so. The engine's events are the only
// truth: a question already waiting when the window opens is in the page the engine serves, one answered in MOSS Code,
// on a phone or in the terminal arrives as the same `question_resolved`, and a question whose turn ended without one
// (the engine stopped mid-turn) is withdrawn, never shown as waiting for ever.
//
// Plain data only: the strings are the model's and are drawn as text (and markdown for none of them).
import type { Message, QuestionView } from "../shared/view";

type Outcome = { state: "answered" | "expired" | "withdrawn"; answers?: Record<string, string>; notes?: Record<string, string> };

/** Entries kept in each table: the newest; a conversation's old questions are read from its pages again. */
const KEPT = 500;

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v !== "" ? v.slice(0, max) : undefined);

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > KEPT) map.delete(map.keys().next().value as K);
}

function record(v: unknown): Record<string, string> | undefined {
  if (v === null || typeof v !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k.slice(0, 2_000)] = x.slice(0, 10_000);
  return out;
}

/** The question the engine's `question_asked` carries, as plain data (1 to 4 questions, each 0 to 4 options). */
export function questionsOf(e: Record<string, unknown>): QuestionView[] {
  const list = Array.isArray(e.questions) ? (e.questions as Record<string, unknown>[]) : [];
  return list.slice(0, 4).flatMap((q) => {
    const question = str(q?.question, 2_000);
    if (question === undefined) return [];
    const header = str(q.header, 12);
    const placeholder = str(q.placeholder, 80);
    const options = (Array.isArray(q.options) ? (q.options as Record<string, unknown>[]) : []).slice(0, 4).flatMap((o) => {
      const label = str(o?.label, 200);
      if (label === undefined) return [];
      const description = str(o.description, 1_000);
      const preview = str(o.preview, 4_000);
      return [{ label, ...(description !== undefined ? { description } : {}), ...(preview !== undefined ? { preview } : {}) }];
    });
    return [{ question, ...(header !== undefined ? { header } : {}), options, multiSelect: q.multiSelect === true && options.length > 0, ...(placeholder !== undefined ? { placeholder } : {}) }];
  });
}

export class QuestionLog {
  /** Each question's message, by message id: what a later event updates in place. */
  private asked = new Map<string, Message>();
  private outcomes = new Map<string, Outcome>();
  /** The newest turn end read, by session: a question asked before it, with no resolution, is not waiting any more. */
  private turnEnd = new Map<string, number>();
  /** The session of each question, by message id. */
  private sessionOf = new Map<string, string>();

  static idOf(e: Record<string, unknown>): string | undefined {
    const call = str(e.callId, 200);
    return call === undefined ? undefined : `${String(e.sessionId ?? "s")}:q${call}`;
  }

  /** What the events say of outcomes and turn ends, before any message is made from them (a page lists newest first, and
   *  its older page is read after). */
  learn(events: readonly Record<string, unknown>[]): void {
    for (const e of events) {
      if (e.type === "question_resolved") {
        const id = QuestionLog.idOf(e);
        if (id !== undefined) remember(this.outcomes, id, outcomeOf(e));
      } else if (e.type === "turn_completed" && typeof e.seq === "number" && typeof e.sessionId === "string") {
        this.turnEnd.set(e.sessionId, Math.max(this.turnEnd.get(e.sessionId) ?? -1, e.seq));
      }
    }
  }

  /** The message for a `question_asked`, in the state the log says now. */
  messageOf(e: Record<string, unknown>): Message | undefined {
    const id = QuestionLog.idOf(e);
    const callId = str(e.callId, 200);
    const questions = questionsOf(e);
    if (id === undefined || callId === undefined || questions.length === 0) return undefined;
    const session = String(e.sessionId ?? "s");
    const seq = typeof e.seq === "number" ? e.seq : undefined;
    const out = this.outcomes.get(id);
    const ended = out === undefined && seq !== undefined && (this.turnEnd.get(session) ?? -1) > seq;
    const state = out?.state ?? (ended ? "withdrawn" : "pending");
    const m: Message = {
      id, from: "question", text: "", at: typeof e.ts === "number" ? e.ts : 0,
      question: { callId, questions, state, ...(out?.answers !== undefined ? { answers: out.answers } : {}), ...(out?.notes !== undefined ? { notes: out.notes } : {}) },
    };
    remember(this.asked, id, m);
    remember(this.sessionOf, id, session);
    return m;
  }

  /** A live event: the messages to hand the window (a new question, or one changed in place). */
  live(e: Record<string, unknown>): Message[] {
    if (e.type === "question_asked") {
      this.learn([e]);
      const m = this.messageOf(e);
      return m === undefined ? [] : [m];
    }
    if (e.type === "question_resolved") {
      const id = QuestionLog.idOf(e);
      if (id === undefined) return [];
      const out = outcomeOf(e);
      remember(this.outcomes, id, out);
      const m = this.changed(id, out);
      return m === undefined ? [] : [m];
    }
    if (e.type === "turn_completed" && typeof e.sessionId === "string") {
      this.learn([e]);
      const out: Message[] = [];
      for (const [id, m] of this.asked) {
        if (this.sessionOf.get(id) !== e.sessionId || m.question?.state !== "pending") continue;
        const w = this.changed(id, { state: "withdrawn" });
        if (w !== undefined) out.push(w);
      }
      return out;
    }
    return [];
  }

  /** Whether `callId` waits in `session` (the person may answer it now), and the texts it asks. */
  waiting(session: string, callId: string): string[] | undefined {
    const m = this.asked.get(`${session}:q${callId}`);
    return m?.question?.state === "pending" ? m.question.questions.map((q) => q.question) : undefined;
  }

  /** The person's answer went in: the question reads answered at once; the engine's own `question_resolved` follows. */
  answered(session: string, callId: string, answers: Record<string, string>, notes?: Record<string, string>): Message | undefined {
    const id = `${session}:q${callId}`;
    const out: Outcome = { state: "answered", answers, ...(notes !== undefined ? { notes } : {}) };
    remember(this.outcomes, id, out);
    return this.changed(id, out);
  }

  private changed(id: string, out: Outcome): Message | undefined {
    const was = this.asked.get(id);
    if (was?.question === undefined) return undefined;
    const m: Message = {
      ...was,
      question: { callId: was.question.callId, questions: was.question.questions, state: out.state, ...(out.answers !== undefined ? { answers: out.answers } : {}), ...(out.notes !== undefined ? { notes: out.notes } : {}) },
    };
    remember(this.asked, id, m);
    return m;
  }
}

/** What a `question_resolved` says: an answer, a timeout (the 10-minute rule), or a withdrawal. */
function outcomeOf(e: Record<string, unknown>): Outcome {
  const by = typeof e.by === "string" ? e.by : "";
  const answers = record(e.answers);
  const notes = record(e.notes);
  if (by === "timeout") return { state: "expired" };
  if (by === "aborted" || by === "superseded" || by === "emit-failure") return { state: "withdrawn" };
  return { state: "answered", ...(answers !== undefined ? { answers } : {}), ...(notes !== undefined && Object.keys(notes).length > 0 ? { notes } : {}) };
}
