// A bot's question (`AskUserQuestion`, spec §5.5) as the conversation draws it: one message per `callId`, which reads
// pending (an open card) until the engine's log says it was answered (with what was chosen) or skipped. It waits for no
// turn: it stays open across turns, a quit and a restart, and a new message of the person's does not withdraw it. Expired and
// withdrawn are how an older engine ended one (no answer in 10 minutes, another question took its place, an abort). The
// engine's events are the only truth: a question already open when the window opens is in the page the engine serves, one
// answered on a phone or in another window arrives as the same `question_resolved`.
//
// Plain data only: the strings are the model's and are drawn as text (and markdown for none of them).
import type { Message, QuestionView } from "../shared/view";

/** `seq` is the resolving event's place in the log: a question asked AGAIN after it (an engine stop withdrew an older one that comes back as an open card) reads
 *  open, because the resolution is older than that asking. */
type Outcome = { state: "answered" | "skipped" | "expired" | "withdrawn"; answers?: Record<string, string>; notes?: Record<string, string>; seq?: number };

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
        if (id !== undefined) this.keep(id, { ...outcomeOf(e), ...(typeof e.seq === "number" ? { seq: e.seq } : {}) });
      }
    }
  }

  /** The newest resolution of a question, by its place in the log (a page is read newest first and its older page after). */
  private keep(id: string, out: Outcome): void {
    const had = this.outcomes.get(id);
    if (had?.seq !== undefined && out.seq !== undefined && had.seq > out.seq) return;
    remember(this.outcomes, id, out);
  }

  /** The message for a `question_asked`, in the state the log says now. */
  messageOf(e: Record<string, unknown>): Message | undefined {
    const id = QuestionLog.idOf(e);
    const callId = str(e.callId, 200);
    const questions = questionsOf(e);
    if (id === undefined || callId === undefined || questions.length === 0) return undefined;
    const session = String(e.sessionId ?? "s");
    const seq = typeof e.seq === "number" ? e.seq : undefined;
    const found = this.outcomes.get(id);
    // A resolution older than this asking is not this question's: it was asked again (an engine stop's withdrawal is undone at load).
    const out = found !== undefined && !(found.seq !== undefined && seq !== undefined && found.seq < seq) ? found : undefined;
    const state = out?.state ?? "pending";
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
      const out: Outcome = { ...outcomeOf(e), ...(typeof e.seq === "number" ? { seq: e.seq } : {}) };
      this.keep(id, out);
      const m = this.changed(id, out);
      return m === undefined ? [] : [m];
    }
    return [];
  }

  /** Whether `callId` waits in `session` (the person may answer it now), and the texts it asks. */
  waiting(session: string, callId: string): string[] | undefined {
    const m = this.asked.get(`${session}:q${callId}`);
    return m?.question?.state === "pending" ? m.question.questions.map((q) => q.question) : undefined;
  }

  /** The person's answer went in: the question reads answered at once; the engine's own `question_resolved` follows. */
  answered(session: string, callId: string, answers: Record<string, string>, notes?: Record<string, string>, skipped = false): Message | undefined {
    const id = `${session}:q${callId}`;
    const out: Outcome = skipped ? { state: "skipped" } : { state: "answered", answers, ...(notes !== undefined ? { notes } : {}) };
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
  if (e.skipped === true && by === "user") return { state: "skipped" };
  if (by === "timeout") return { state: "expired" };
  if (by === "aborted" || by === "superseded" || by === "emit-failure") return { state: "withdrawn" };
  return { state: "answered", ...(answers !== undefined ? { answers } : {}), ...(notes !== undefined && Object.keys(notes).length > 0 ? { notes } : {}) };
}
