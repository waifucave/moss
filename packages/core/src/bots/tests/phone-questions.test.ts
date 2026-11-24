// `session.openQuestions`: a paired phone reads the open `AskUserQuestion`s of a session or a bot's conversation in one call, so a busy
// log can't hide one (`needsYou.questions` only counts them). Owner: lane PH.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { SESSIONS_METHODS, type Caller } from "@waifucave/moss-protocol";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import { pairedPhone } from "../../agents/tests/phone";
import { clip, openQuestionsOf } from "../open-questions";
import { boot, removeTemps, tempDir } from "./fixtures";

afterEach(removeTemps);

async function setup() {
  const clock = new FakeClock();
  const userHome = tempDir();
  const home = join(userHome, ".moss");
  mkdirSync(home, { recursive: true });
  const phone = await pairedPhone(clock);
  const b = await boot({ home, userHome, clock, plugins: [], botSource: "records", computer: "Studio" });
  const all = b.side.methods({ localDevice: "studio0000000000000", phoneMay: phone.mayStart });
  const ask = (id: string, caller: Caller = phone.caller()) => all["session.openQuestions"]!({ id }, { caller } as never) as Promise<{ open: { callId: string; seq: number; askedAt: number; questions: any[] }[] }>;
  const d = new FakeSessionDriver({ canFold: false });
  b.host.open({ id: "s_code", kind: "coding", computer: "Studio", backend: "claude-code" }, d);
  // The driver's events are taken while a turn runs.
  await b.host.sendUser("s_code", { text: "ask me", device: "phone0000000000000", sentAt: 1, clientMessageId: "m1" } as never);
  await new Promise((r) => setTimeout(r, 0));
  return { clock, phone, b, ask, d, all };
}

describe("session.openQuestions", () => {
  test("returns the open question as the log holds it, however far back it was asked, and nothing once it is answered", async () => {
    const s = await setup();
    expect((await s.ask("s_code")).open).toEqual([]);
    const asked = [{ question: "Which folder?", header: "Folder", options: [{ label: "a", description: "the first", preview: "+ a" }, { label: "b" }], multiSelect: true, placeholder: "or type one" }];
    s.d.emit({ type: "question_asked", callId: "q1", questions: asked });
    // A busy session: hundreds of events after it, more than a phone's newest-200 scan would hold.
    for (let i = 0; i < 400; i++) s.d.emit({ type: "bg_task_output", taskId: "t1", chunk: `line ${i}` });
    const r = await s.ask("s_code");
    expect(SESSIONS_METHODS.sessionOpenQuestions.result.parse(r)).toEqual(r);
    expect(r.open).toHaveLength(1);
    expect(r.open[0]).toMatchObject({ callId: "q1", questions: asked });
    expect(r.open[0]!.askedAt).toBe(s.clock.now());
    s.d.emit({ type: "question_resolved", callId: "q1", answers: { "Which folder?": "a" }, by: "user" });
    expect((await s.ask("s_code")).open).toEqual([]);
    await s.b.shutdown();
  });

  test("works for a bot's conversation, and refuses a session that isn't there", async () => {
    const s = await setup();
    await s.all["bot.create"]!({ name: "Nova", instructions: "You are Nova." }, { caller: { kind: "user", client: "app" } } as never);
    const conversation = s.b.bots.mainSession("nova");
    expect((await s.ask(conversation)).open).toEqual([]);
    await expect(s.ask("s_none")).rejects.toThrow(/no session/);
    await s.b.shutdown();
  });

  test("is the phone's own read: only the remote role has it", () => {
    expect([...SESSIONS_METHODS.sessionOpenQuestions.roles]).toEqual(["remote"]);
  });
});

describe("the bounds on what an open question says", () => {
  test("a long text is cut with an ellipsis (never through a surrogate pair), a menu of one is a free-text question, and what the wire can't hold is left out", () => {
    const long = "x".repeat(5000);
    const emoji = "😀".repeat(3000);
    const out = openQuestionsOf([
      { callId: "q1", seq: 4, askedAt: 9, questions: [{ question: long, header: "H".repeat(40), options: [{ label: "L".repeat(500), description: "d".repeat(2000), preview: "p".repeat(9000) }], multiSelect: false, placeholder: "ph".repeat(80) }] },
      { callId: "q2".padEnd(200, "z"), seq: 5, askedAt: 10, questions: [{ question: "never answerable", options: [], multiSelect: false }] },
      { callId: "q3", seq: 6, askedAt: 11, questions: [{ question: emoji, options: [], multiSelect: false }, { question: "", options: [], multiSelect: false }] },
      { callId: "q4", seq: 7, askedAt: 12, questions: [] },
    ]);
    expect(out.map((q) => q.callId)).toEqual(["q1", "q3"]);
    const q1 = out[0]!.questions[0]!;
    expect(q1.question.length).toBe(2000);
    expect(q1.question.endsWith("…")).toBe(true);
    expect(q1.header!.length).toBe(12);
    expect(q1.options).toEqual([]);
    expect(q1.placeholder!.length).toBe(80);
    const q3 = out[1]!.questions;
    expect(q3).toHaveLength(1);
    expect(q3[0]!.question.length).toBeLessThanOrEqual(2000);
    expect(q3[0]!.question.isWellFormed()).toBe(true);
    for (const q of out) expect(SESSIONS_METHODS.sessionOpenQuestions.result.shape.open.element.safeParse(q).success).toBe(true);
    expect(clip("abc", 3)).toBe("abc");
  });

  test("a menu's options are bounded: label 200, description 1000, preview 4000, at most 4 options, and the newest 4 questions asked", () => {
    const opt = { label: "L".repeat(500), description: "d".repeat(2000), preview: "p".repeat(9000) };
    const out = openQuestionsOf(Array.from({ length: 7 }, (_, i) => ({ callId: `q${i}`, seq: i, askedAt: i, questions: [{ question: "Q?", options: [opt, opt, opt, opt, opt, opt], multiSelect: false }] })));
    expect(out.map((q) => q.callId)).toEqual(["q3", "q4", "q5", "q6"]);
    const o = out[0]!.questions[0]!.options;
    expect(o).toHaveLength(4);
    expect([o[0]!.label.length, o[0]!.description!.length, o[0]!.preview!.length]).toEqual([200, 1000, 4000]);
    // The largest answer fits well under the phone link's 1 MiB frame.
    expect(Buffer.byteLength(JSON.stringify({ open: out }))).toBeLessThan(512 * 1024);
  });
});
