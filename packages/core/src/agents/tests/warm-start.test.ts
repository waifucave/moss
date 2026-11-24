// The agent of a coding session the person opened and has not typed into starts while they write (`AgentDriver.warm`),
// so the first message does not pay for it: only where no card is needed, with no request to a provider, never for a
// bot's agent, and the first message then finds it running. Step timings are one line in the log (`start-timing.ts`).
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { WARM_IDLE_MS } from "../driver";
import { StepTimer } from "../start-timing";
import { World, waitFor } from "./world";

setDefaultTimeout(120_000);

let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const USER = (n: number) => ({ kind: "user", device: "d".repeat(16), clientMessageId: `m${n}` } as const);
const send = (w: World, id: string, text: string, n: number) => w.host.sendUser(id, { text, device: "d".repeat(16), clientMessageId: `m${n}`, sentAt: w.clock.now() });
const driverEvents = (w: World, id: string) => w.host.history(id).filter((x) => x.type === "driver").map((x) => (x as { event: { type: string } }).event.type);

describe("an agent starts when its session is opened, where no card is needed", () => {
  test("opened with no message: the agent is up before anyone types; the first message and the second run on that one process, and the start is recorded once", async () => {
    const lines: string[] = [];
    const w = (world = new World({ script: [[{ say: "one" }], [{ say: "two" }]], log: (l) => lines.push(l) }));
    const r = await w.manager.start({ caller: USER(1), backend: "fake", prompt: "", root: "home/Studio/project1" });
    await waitFor(() => w.report("started").length === 1 || undefined, "the agent up before any message");
    expect(w.report("prompt")).toEqual([]);
    expect(w.approvals.cards()).toEqual([]);
    await waitFor(() => lines.some((l) => l.includes(`${r.sessionId}: fake warm start took`)) || undefined, "the start's timing line");
    await send(w, r.sessionId, "hi", 2);
    await waitFor(() => w.report("prompt").length === 1 || undefined, "the first prompt");
    await waitFor(() => w.host.get(r.sessionId)!.status === "idle" || undefined, "the first turn's end");
    await send(w, r.sessionId, "again", 3);
    await waitFor(() => w.report("prompt").length === 2 || undefined, "the second prompt");
    await waitFor(() => w.host.get(r.sessionId)!.status === "idle" || undefined, "the second turn's end");
    expect(w.report("started").length).toBe(1); // one process for both messages
    expect(driverEvents(w, r.sessionId).filter((t) => t === "agent_started").length).toBe(1);
  });

  test("a message sent while it is still starting joins that start: one process, one prompt", async () => {
    const w = (world = new World({ script: [[{ say: "one" }]] }));
    const r = await w.manager.start({ caller: USER(1), backend: "fake", prompt: "", root: "home/Studio/project1" });
    await send(w, r.sessionId, "hi", 2); // no wait: the start may still be running
    await waitFor(() => w.report("prompt").length === 1 || undefined, "the prompt");
    expect(w.report("started").length).toBe(1);
    expect(driverEvents(w, r.sessionId).filter((t) => t === "agent_started").length).toBe(1);
  });

  test("a start that needs the person's OK is not made before they write: no card and no process, and the first message asks, as it always did", async () => {
    const w = (world = new World({ script: [[{ say: "one" }]], sandbox: "none" }));
    const r = await w.manager.start({ caller: USER(1), backend: "fake", prompt: "", root: "home/Studio/project1" });
    await new Promise((res) => setTimeout(res, 800));
    expect(w.approvals.cards()).toEqual([]);
    expect(w.report("started")).toEqual([]);
    expect(w.host.get(r.sessionId)!.status).not.toBe("failed");
    await send(w, r.sessionId, "hi", 2);
    const card = await waitFor(() => w.approvals.cards()[0], "the start's card at the first message");
    expect(card).toMatchObject({ kind: "change", change: "agent-unsandboxed" });
    expect(w.report("started")).toEqual([]);
  });

  test("a bot's agent and a session opened with a message are not warmed ahead: they start with their own first turn, once", async () => {
    const w = (world = new World({ script: [[{ say: "one" }]] }));
    const r = await w.delegate("Fix the tests.");
    await waitFor(() => w.report("prompt").length === 1 || undefined, "the prompt");
    expect(w.report("started").length).toBe(1);
    expect(r.sessionId).toBeTruthy();
  });

  test("a manager told not to warm starts at the first message", async () => {
    const w = (world = new World({ script: [[{ say: "one" }]], warmStart: false }));
    await w.manager.start({ caller: USER(1), backend: "fake", prompt: "", root: "home/Studio/project1" });
    await new Promise((res) => setTimeout(res, 500));
    expect(w.report("started")).toEqual([]);
  });
});

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
const pidOf = (w: World, n = 0): number => Number(w.report("started")[n]!["pid"]);

describe("an agent started early does not wait for ever", () => {
  test("no first message in 10 minutes: its process is stopped, and the first message then starts it as it always did", async () => {
    const w = (world = new World({ script: [[{ say: "one" }]] }));
    const r = await w.manager.start({ caller: USER(1), backend: "fake", prompt: "", root: "home/Studio/project1" });
    await waitFor(() => w.report("started").length === 1 || undefined, "the agent up");
    const first = pidOf(w);
    expect(alive(first)).toBe(true);
    w.clock.advance(WARM_IDLE_MS - 1000);
    await new Promise((res) => setTimeout(res, 200));
    expect(alive(first)).toBe(true); // not yet
    w.clock.advance(1000);
    await waitFor(() => !alive(first) || undefined, "the idle agent stopped");
    expect(w.host.get(r.sessionId)!.status).not.toBe("failed");
    await send(w, r.sessionId, "hi", 2);
    await waitFor(() => w.report("prompt").length === 1 || undefined, "the prompt after the stop");
    expect(w.report("started").length).toBe(2);
    expect(alive(pidOf(w, 1))).toBe(true);
    expect(driverEvents(w, r.sessionId).filter((t) => t === "agent_started").length).toBe(1);
  });

  test("a message before then keeps it: the timer is gone once a turn has begun", async () => {
    const w = (world = new World({ script: [[{ say: "one" }]] }));
    const r = await w.manager.start({ caller: USER(1), backend: "fake", prompt: "", root: "home/Studio/project1" });
    await waitFor(() => w.report("started").length === 1 || undefined, "the agent up");
    await send(w, r.sessionId, "hi", 2);
    await waitFor(() => w.host.get(r.sessionId)!.status === "idle" && w.report("prompt").length === 1 || undefined, "the turn's end");
    w.clock.advance(WARM_IDLE_MS * 3);
    await new Promise((res) => setTimeout(res, 300));
    expect(alive(pidOf(w))).toBe(true);
    expect(w.report("started").length).toBe(1);
  });

  test("a session closed while its agent waits stops the process, and no timer is left", async () => {
    const w = (world = new World({ script: [[{ say: "one" }]] }));
    const r = await w.manager.start({ caller: USER(1), backend: "fake", prompt: "", root: "home/Studio/project1" });
    await waitFor(() => w.report("started").length === 1 || undefined, "the agent up");
    const pid = pidOf(w);
    await w.host.stop(r.sessionId);
    await waitFor(() => !alive(pid) || undefined, "the process gone with its session");
    w.clock.advance(WARM_IDLE_MS * 2);
    expect(w.report("started").length).toBe(1);
  });
});

describe("the engine's shutdown with an early-started agent waiting", () => {
  test("close() ends its process at once and leaves no timer on the clock", async () => {
    const w = (world = new World({ script: [[{ say: "one" }]] }));
    const base = w.clock.pending();
    await w.manager.start({ caller: USER(1), backend: "fake", prompt: "", root: "home/Studio/project1" });
    await waitFor(() => w.report("started").length === 1 || undefined, "the agent up");
    await waitFor(() => w.clock.pending() > base || undefined, "the idle timer armed");
    const pid = pidOf(w);
    const began = performance.now();
    await w.manager.close();
    expect(performance.now() - began).toBeLessThan(5000);
    await waitFor(() => !alive(pid) || undefined, "the process gone");
    expect(w.clock.pending()).toBe(base);
  });

  test("a close while the early start is still running leaves no timer behind", async () => {
    const w = (world = new World({ script: [[{ say: "one" }]] }));
    const base = w.clock.pending();
    await w.manager.start({ caller: USER(1), backend: "fake", prompt: "", root: "home/Studio/project1" });
    await w.manager.close(); // no wait: the start may still be running
    await new Promise((res) => setTimeout(res, 800));
    expect(w.clock.pending()).toBe(base);
    for (let i = 0; i < w.report("started").length; i++) await waitFor(() => !alive(pidOf(w, i)) || undefined, "no process left");
  });
});

describe("a start probes the program once", () => {
  test("admission and the backend's start share one detection (one program probe), unless a card waited in between", async () => {
    const w = (world = new World({ script: [[{ say: "one" }]], warmStart: false }));
    let detects = 0;
    const detect = w.backend.detect.bind(w.backend);
    w.backend.detect = () => {
      detects++;
      return detect();
    };
    const r = await w.manager.start({ caller: USER(1), backend: "fake", prompt: "hi", root: "home/Studio/project1" });
    await waitFor(() => w.report("prompt").length === 1 || undefined, "the prompt");
    expect(detects).toBe(1);
    expect(r.sessionId).toBeTruthy();
  });
});

describe("the start's step timer", () => {
  test("names each step with the time since the one before, and the total", () => {
    let t = 1000;
    const timer = new StepTimer(() => t);
    t += 5;
    timer.mark("a");
    t += 120;
    timer.mark("b");
    expect(timer.line()).toBe("start took 125 ms: a 5, b 120");
  });
});
