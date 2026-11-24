// What a coding session or a background agent pushes to the phones (core-updates.ts, `CoreNotices`), tested through the wiring:
// a real session host (a durable one on a temp home, with a fake driver and the fake approval broker that counts cards), the
// real `CoreNotices`, the real `NotifyService` over the paired phones, and a notifier that keeps what it is handed. Nothing calls
// `NotifyService.core` by hand: the card, the question and the turn's end happen in the host, and the notifier hears them
// with the phones of the app they are for.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotifierUpdate } from "@waifucave/moss-plugin-sdk";
import type { PairedPhone } from "@waifucave/moss-protocol";
import { FakeApprovalBroker } from "../../contracts/fakes/approval-broker";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import type { InvokeRequest } from "../../contracts/plugin-host";
import type { SessionSpec } from "../../contracts/session-host";
import { DurableSessionHost } from "../../sessions/durable-host";
import { CoreNotices, FINISH_MIN_MS } from "../core-updates";
import { NotifyService } from "../service";

const MOSS = "m".repeat(20);
const CODE = "c".repeat(20);
const PHONES: PairedPhone[] = [{ id: MOSS, app: "moss" }, { id: CODE, app: "code" }];

const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

function world(phones: PairedPhone[] = PHONES) {
  const home = mkdtempSync(join(tmpdir(), "moss-notify-sessions-"));
  const clock = new FakeClock();
  const approvals = new FakeApprovalBroker({ clock });
  const heard: NotifierUpdate[] = [];
  const cleared: number[] = [];
  const service = new NotifyService({
    home, computer: "Studio", clock,
    registry: {
      get: () => undefined,
      entries: (point: string) => (point === "notifiers" ? [{ point, pluginId: "pinger", ref: "notifiers/0", value: { id: "ping", handler: "notifier" }, state: "active" }] : []) as never,
    },
    host: () => ({
      invoke: (async (req: InvokeRequest) => {
        if (req.method === "clear") cleared.push(1);
        else heard.push(req.args as NotifierUpdate);
        return undefined;
      }) as never,
    }),
    phones: () => phones,
    grants: () => ["devices.read"],
  });
  const host = new DurableSessionHost({ home, clock, approvals, warn: () => {} });
  const notices = new CoreNotices({ host, sink: service });
  cleanups.push(() => { notices.close(); service.close(); rmSync(home, { recursive: true, force: true }); });
  const open = (spec: SessionSpec) => { const driver = new FakeSessionDriver(); host.open(spec, driver); return driver; };
  const user = (id: string, text = "go") => host.sendUser(id, { text, device: "phone0000000000000", sentAt: clock.now(), clientMessageId: `m-${text}-${clock.now()}` });
  const settle = async () => { await flush(); await new Promise((r) => setTimeout(r, 5)); };
  return { host, clock, approvals, heard, cleared, open, user, settle };
}

const CODING: SessionSpec = { id: "s_code", kind: "coding", computer: "Studio", root: "home/Studio/project1" };
const QUESTION = { type: "question_asked", callId: "q1", questions: [{ question: "Which folder?", header: "Folder", options: [{ label: "a" }, { label: "b" }], multiSelect: false }] };

describe("a coding session's pushes go to the MOSS Code phones", () => {
  test("a card raised for it, and then a question", async () => {
    const w = world();
    const d = w.open(CODING);
    await w.user("s_code");
    await w.settle();
    void w.approvals.request({ kind: "tool", session: "s_code", origin: "user", computers: ["Studio"], effect: "delete", fields: {} });
    await w.settle();
    d.emit(QUESTION);
    await w.settle();
    expect(w.heard.map((u) => [u.kind, u.sessionKind, u.session, u.bot, u.phones])).toEqual([
      ["card", "coding", "s_code", undefined, [CODE]],
      ["question", "coding", "s_code", undefined, [CODE]],
    ]);
    // The words and the session's own count only: its own `unseen`, no bot.
    expect(w.heard.map((u) => u.unseen)).toEqual([1, 2]);
  });

  test("with no MOSS Code phone paired, the person's other phones get it; a phone with no recorded app counts for MOSS Code", async () => {
    const OLD = "o".repeat(20);
    const onlyMoss = world([{ id: MOSS, app: "moss" }]);
    onlyMoss.open(CODING);
    await onlyMoss.user("s_code");
    await onlyMoss.settle();
    void onlyMoss.approvals.request({ kind: "tool", session: "s_code", origin: "user", computers: ["Studio"], effect: "delete", fields: {} });
    await onlyMoss.settle();
    expect(onlyMoss.heard.map((u) => u.phones)).toEqual([[MOSS]]);
    const mixed = world([{ id: MOSS, app: "moss" }, { id: OLD }]);
    mixed.open(CODING);
    await mixed.user("s_code");
    await mixed.settle();
    void mixed.approvals.request({ kind: "tool", session: "s_code", origin: "user", computers: ["Studio"], effect: "delete", fields: {} });
    await mixed.settle();
    expect(mixed.heard.map((u) => u.phones)).toEqual([[OLD]]);
  });

  test("a bot's card still goes to the MOSS phones, beside it", async () => {
    const w = world();
    w.open({ id: "b_luna", kind: "bot", bot: "luna", computer: "Studio" });
    w.open(CODING);
    await w.user("b_luna");
    await w.user("s_code");
    await w.settle();
    void w.approvals.request({ kind: "tool", session: "b_luna", origin: "user", computers: ["Studio"], effect: "delete", fields: {} });
    void w.approvals.request({ kind: "tool", session: "s_code", origin: "user", computers: ["Studio"], effect: "delete", fields: {} });
    await w.settle();
    expect(w.heard.map((u) => [u.sessionKind, u.bot, u.phones])).toEqual([["bot", "luna", [MOSS]], ["coding", undefined, [CODE]]]);
  });

  test("a turn that ends after running a minute is announced, once; a short one, an interrupted one and a stopped one are not", async () => {
    const w = world();
    const d = w.open(CODING);
    // A short turn: the person was waiting for it.
    await w.user("s_code", "quick");
    await w.settle();
    w.clock.advance(FINISH_MIN_MS - 1);
    d.end({ text: "done" });
    await w.settle();
    expect(w.heard).toEqual([]);
    // A long one: announced, to the MOSS Code phones.
    await w.user("s_code", "long");
    await w.settle();
    w.clock.advance(FINISH_MIN_MS);
    d.end({ text: "done" });
    await w.settle();
    expect(w.heard.map((u) => [u.kind, u.sessionKind, u.phones])).toEqual([["agent-finished", "coding", [CODE]]]);
    // A long one the person interrupted, and one that was stopped: nothing more.
    await w.user("s_code", "again");
    await w.settle();
    w.clock.advance(FINISH_MIN_MS * 2);
    d.end({ reason: "interrupted" });
    await w.settle();
    await w.user("s_code", "once more");
    await w.settle();
    w.clock.advance(FINISH_MIN_MS * 2);
    d.end({ reason: "stopped" });
    await w.settle();
    expect(w.heard).toHaveLength(1);
  });

  test("a long turn that failed or was refused is announced too: the session needs the person", async () => {
    const w = world();
    const d = w.open(CODING);
    for (const reason of ["failed", "refusal"] as const) {
      await w.user("s_code", reason);
      await w.settle();
      w.clock.advance(FINISH_MIN_MS);
      d.end({ reason });
      await w.settle();
    }
    expect(w.heard.map((u) => u.kind)).toEqual(["agent-finished", "agent-finished"]);
  });

  test("nothing for progress: tool calls, text, a status change or a note", async () => {
    const w = world();
    const d = w.open(CODING);
    await w.user("s_code");
    await w.settle();
    d.emit({ type: "tool_call", name: "Bash" });
    d.emit({ type: "text", text: "working" });
    w.clock.advance(FINISH_MIN_MS * 5);
    await w.host.deliver("s_code", { from: "note", label: "n", text: "a note", by: { kind: "core" } });
    await w.settle();
    expect(w.heard).toEqual([]);
  });

  test("the person answering in it starts its count again and clears the banners", async () => {
    const w = world();
    const d = w.open(CODING);
    await w.user("s_code");
    await w.settle();
    d.emit(QUESTION);
    d.emit({ ...QUESTION, callId: "q2" });
    await w.settle();
    expect(w.heard.map((u) => u.unseen)).toEqual([1, 2]);
    await w.user("s_code", "the answer");
    await w.settle();
    expect(w.cleared).toHaveLength(1);
    d.emit({ ...QUESTION, callId: "q3" });
    await w.settle();
    expect(w.heard.at(-1)?.unseen).toBe(1);
  });
});

describe("a background agent", () => {
  test("its card or question is the MOSS Code phones' even when a bot started it; its finish is announced only when the person started it", async () => {
    const w = world();
    w.open({ id: "b_luna", kind: "bot", bot: "luna", computer: "Studio" });
    const botsAgent = w.open({ id: "a_bots", kind: "agent", bot: "luna", parent: "b_luna", computer: "Studio", startedBy: { kind: "bot", bot: "luna" } });
    const mine = w.open({ id: "a_mine", kind: "agent", computer: "Studio", startedBy: { kind: "user" } });
    await w.user("a_bots");
    await w.user("a_mine");
    await w.settle();
    botsAgent.emit(QUESTION);
    await w.settle();
    w.clock.advance(FINISH_MIN_MS);
    botsAgent.end({ text: "done" });
    mine.end({ text: "done" });
    await w.settle();
    expect(w.heard.map((u) => [u.kind, u.sessionKind, u.session, u.bot, u.phones])).toEqual([
      ["question", "agent", "a_bots", undefined, [CODE]],
      // The bot's agent finishing reaches the bot's conversation (the MOSS phones' push, as before); the agent's own session adds none.
      ["agent-finished", "bot", "b_luna", "luna", [MOSS]],
      ["agent-finished", "agent", "a_mine", undefined, [CODE]],
    ]);
  });

  test("a side thread (a routine's run) pushes nothing of its own", async () => {
    const w = world();
    w.open({ id: "b_luna", kind: "bot", bot: "luna", computer: "Studio" });
    const side = w.open({ id: "t_run", kind: "side-thread", bot: "luna", parent: "b_luna", computer: "Studio", routine: "daily" });
    await w.settle();
    side.emit(QUESTION);
    void w.approvals.request({ kind: "tool", session: "t_run", origin: "routine", computers: ["Studio"], effect: "delete", fields: {} });
    await w.settle();
    expect(w.heard).toEqual([]);
  });

  test("a session that has ended is let go of: nothing from it afterwards", async () => {
    const w = world();
    const d = w.open(CODING);
    await w.user("s_code");
    await w.settle();
    await w.host.stop("s_code");
    await w.settle();
    d.emit(QUESTION);
    w.clock.advance(FINISH_MIN_MS);
    await w.settle();
    expect(w.heard).toEqual([]);
  });
});
