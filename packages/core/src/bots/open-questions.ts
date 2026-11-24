// `session.openQuestions` (a paired phone's read): the `AskUserQuestion`s a session has asked and not had answered, as the log holds them
// (the host's `openQuestions`), with their text bounded to what the wire's schema allows. `needsYou.questions` only counts them, and a phone
// scanning the newest events of a busy log would not find one; this is the one place a phone reads them. Owner: lane PH.
import { OPEN_QUESTIONS_MAX, type OpenQuestion } from "@waifucave/moss-protocol";
import type { OpenQuestion as HeldQuestion } from "../sessions/durable-host";

/** `s` cut to at most `max` UTF-16 units, with an ellipsis, never through a surrogate pair. */
export function clip(s: string, max: number): string {
  const whole = s.toWellFormed();
  if (whole.length <= max) return whole;
  let cut = whole.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The held questions in the order asked, as the wire's `OpenQuestion`s; a call whose id `session.answer` can't take, or that holds no
 *  question to draw, is left out, and only the newest `OPEN_QUESTIONS_MAX` are given. */
export function openQuestionsOf(held: readonly HeldQuestion[]): OpenQuestion[] {
  const out: OpenQuestion[] = [];
  for (const h of held) {
    if (h.callId.length > 128) continue;
    const questions: OpenQuestion["questions"] = [];
    for (const raw of h.questions.slice(0, 4)) {
      const q = raw as Record<string, unknown>;
      const question = text(q["question"]);
      if (question === undefined) continue;
      const header = text(q["header"]);
      const placeholder = text(q["placeholder"]);
      const options = (Array.isArray(q["options"]) ? q["options"] : []).slice(0, 4).flatMap((o) => {
        const opt = o as Record<string, unknown>;
        const label = text(opt["label"]);
        if (label === undefined) return [];
        const description = text(opt["description"]);
        const preview = text(opt["preview"]);
        return [{ label: clip(label, 200), ...(description === undefined ? {} : { description: clip(description, 1000) }), ...(preview === undefined ? {} : { preview: clip(preview, 4000) }) }];
      });
      questions.push({
        question: clip(question, 2000),
        ...(header === undefined ? {} : { header: clip(header, 12) }),
        // A menu of one is no choice: the desktop refuses it, so it is a free-text question here.
        options: options.length === 1 ? [] : options,
        multiSelect: q["multiSelect"] === true,
        ...(placeholder === undefined ? {} : { placeholder: clip(placeholder, 80) }),
      });
    }
    if (questions.length > 0) out.push({ callId: h.callId, seq: h.seq, askedAt: h.askedAt, questions });
  }
  return out.slice(-OPEN_QUESTIONS_MAX);
}
