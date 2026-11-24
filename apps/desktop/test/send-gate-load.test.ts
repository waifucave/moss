// MOSS Code's composer send on a machine that is too busy to schedule the main process (the twin of apps/moss/test/press-load.test.ts).
// SendGate timed a press by when main HANDLED it: the mouse down (`press`), the frame's report (`seen`, 1000 ms) and the call
// (`takeIn`, 1000 ms; `take`, 1000 ms). With a stall watch the age is counted without the time the process itself was not running
// (never more than the cap, none for time it spent working); with no stall every bound is as it was. What must stay refused is
// here beside the stalled cases.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StallWatch, STALL_CREDIT_MAX_MS, STALL_TICK_MS } from "@waifucave/moss-app-release/stall-watch";
import { PRESS_REPORT_MS, SEND_INPUT_WINDOW_MS, SendGate } from "../src/main/ui/brokers";

const WIN = 1;
const A = "10:1";
const B = "10:2";

function rig() {
  const c = { now: 9_000_000, cpu: 0, sw: 0, tick: undefined as (() => void) | undefined };
  const watch = new StallWatch({ now: () => c.now, cpu: () => c.cpu, switches: () => c.sw, uptime: () => 100_000, load: () => ({ avg: 20, cores: 8 }), setTimer: (fn) => { c.tick = fn; return 1; }, clearTimer: () => { c.tick = undefined; } });
  const gate = new SendGate(() => c.now, watch);
  const pass = (ms: number, cpu = 1, tick = true, sw = ms > STALL_TICK_MS + 50 ? ms : Math.round(ms / 100)): void => { c.now += ms; c.cpu += cpu; c.sw += sw; if (tick) c.tick?.(); };
  const calm = (ms: number): void => { for (let left = ms; left > 0; left -= STALL_TICK_MS) pass(Math.min(left, STALL_TICK_MS), 1); };
  /** A click the main process saw land in `frame`: the mouse down, then the frame's report. */
  const click = (frames: readonly string[] = [A], reportAfter = 10): void => { gate.press(WIN, { kind: "mouse", key: "left" }); calm(reportAfter); gate.seen(WIN, frames); };
  return { c, watch, gate, pass, calm, click };
}

describe("the composer's send on a machine that kept up", () => {
  test("the bounds are as they were: the call 1000 ms after the press, the report 1000 ms after it, and not a ms more", () => {
    for (const [after, ok] of [[1_000, true], [1_001, false]] as const) {
      const r = rig();
      r.click();
      r.calm(after - 10);
      expect([after, r.gate.takeIn(WIN, A)]).toEqual([after, ok]);
    }
    for (const [reportAt, ok] of [[PRESS_REPORT_MS, true], [PRESS_REPORT_MS + 1, false]] as const) {
      const r = rig();
      r.click([A], reportAt);
      expect([reportAt, r.gate.takeIn(WIN, A)]).toEqual([reportAt, ok]);
    }
  });

  test("the plain one-second input (take) is as it was, and says no more on a machine that kept up", () => {
    const r = rig();
    r.gate.input(WIN);
    r.calm(SEND_INPUT_WINDOW_MS);
    expect(r.gate.take(WIN)).toBe(true);
    r.gate.input(WIN);
    r.calm(SEND_INPUT_WINDOW_MS + 1);
    expect(r.gate.take(WIN)).toBe(false);
  });

  test("a page holding a press (a script waiting) is refused: no stall, no extra time", () => {
    const r = rig();
    r.click();
    r.calm(6_000);
    expect(r.gate.takeIn(WIN, A)).toBe(false);
    expect(r.gate.whyNot(WIN, A)).toMatch(/^the call came \d+ ms past the press's bound$/);
  });
});

describe("a genuine press while the machine stalled main", () => {
  test("a stall between the mouse down and the frame's report, and between the report and the call", () => {
    for (const tickFirst of [false, true]) {
      const a = rig();
      a.gate.press(WIN, { kind: "mouse", key: "left" });
      a.calm(20);
      a.pass(STALL_TICK_MS + 4_000, 30, tickFirst);
      expect(a.gate.seen(WIN, [A])).toBe(true);
      a.pass(30, 3);
      expect(a.gate.takeIn(WIN, A)).toBe(true);
      const b = rig();
      b.click();
      b.pass(STALL_TICK_MS + 4_000, 30, tickFirst);
      expect(b.gate.takeIn(WIN, A)).toBe(true);
    }
  });

  test("the plain input counts a stall too: a click seen, the call 4 s later", () => {
    const r = rig();
    r.gate.input(WIN);
    r.pass(STALL_TICK_MS + 4_000, 20, false);
    expect(r.gate.take(WIN)).toBe(true);
  });

  test("a stall the process spent working, or one past the cap, earns nothing it could not have had", () => {
    const busy = rig();
    busy.click();
    busy.pass(STALL_TICK_MS + 5_000, 5_000);
    expect(busy.gate.takeIn(WIN, A)).toBe(false);
    const edge = rig();
    edge.click();
    edge.pass(SEND_INPUT_WINDOW_MS + STALL_CREDIT_MAX_MS - 10, 5, false);
    expect(edge.gate.takeIn(WIN, A)).toBe(true);
    const over = rig();
    over.click();
    over.pass(SEND_INPUT_WINDOW_MS + STALL_CREDIT_MAX_MS - 9, 5, false);
    expect(over.gate.takeIn(WIN, A)).toBe(false);
    expect(over.gate.whyNot(WIN, A)).toContain("past the press's bound");
  });

  test("one press, one send; a press in another frame pays for nothing here; a window with no press pays for nothing", () => {
    const r = rig();
    r.click([A]);
    r.pass(STALL_TICK_MS + 3_000, 5, false);
    expect(r.gate.takeIn(WIN, B)).toBe(false);
    expect(r.gate.whyNot(WIN, B)).toContain("the press landed in another frame");
    expect(r.gate.takeIn(WIN + 1, A)).toBe(false);
    expect(r.gate.takeIn(WIN, A)).toBe(true);
    expect(r.gate.takeIn(WIN, A)).toBe(false);
    expect(r.gate.whyNot(WIN, A)).toBe("the press was already used");
    expect(rig().gate.whyNot(WIN, A)).toBe("no press seen in this window");
  });

  test("a report is taken late only while the press has no frames, and a page's own word is never one", () => {
    const r = rig();
    r.gate.press(WIN, { kind: "mouse", key: "left" });
    r.calm(PRESS_REPORT_MS + 500); // nothing stalled: a report this late is dropped, as it was
    expect(r.gate.seen(WIN, [A])).toBe(false);
    expect(r.gate.takeIn(WIN, A)).toBe(false);
    expect(r.gate.whyNot(WIN, A)).toMatch(/^no pointerdown report named where the press landed|^the call came/);
  });

  test("a second press while the first still waits for its report, on a stalled machine: no report is attributed and nothing is sent", () => {
    const r = rig();
    r.gate.press(WIN, { kind: "mouse", key: "left" }); // press 1 (in frame B), its report held up
    r.pass(STALL_TICK_MS + 600, 5, false);
    r.gate.press(WIN, { kind: "mouse", key: "left" }); // press 2 (in frame A)
    expect(r.gate.seen(WIN, [B])).toBe(false); // press 1's late report would name press 2
    expect(r.gate.seen(WIN, [A])).toBe(false);
    expect(r.gate.takeIn(WIN, A)).toBe(false);
    expect(r.gate.whyNot(WIN, A)).toContain("two presses close together on a stalled machine");
    r.calm(2_000);
    r.click([A]); // the next press stands alone
    expect(r.gate.takeIn(WIN, A)).toBe(true);
  });

  test("press A in frame X with no report yet, press B in frame Y with no stall yet, then main stalls, then X's report: it is not B's", () => {
    const r = rig();
    r.gate.press(WIN, { kind: "mouse", key: "left" }); // A, in frame X: its report is slow
    r.calm(100);
    r.gate.press(WIN, { kind: "mouse", key: "left" }); // B, in frame Y: no stall yet
    r.calm(20);
    r.pass(STALL_TICK_MS + 4_000, 30, false); // then main stalls
    expect(r.gate.seen(WIN, ["X:1"])).toBe(false); // A's report would name B's press
    expect(r.gate.takeIn(WIN, "X:1")).toBe(false);
    expect(r.gate.takeIn(WIN, "Y:1")).toBe(false);
    expect(r.gate.whyNot(WIN, "X:1")).toContain("two presses close together on a stalled machine");
    r.calm(2_000);
    r.click(["Y:1"]); // the next press, alone
    expect(r.gate.takeIn(WIN, "Y:1")).toBe(true);
  });

  const CROWDED = "two presses close together on a stalled machine";

  test("three presses: A in X (report held back), B in Y (reports promptly), C in Z, then main stalls and X's report comes: it is not C's", () => {
    const r = rig();
    r.gate.press(WIN, { kind: "mouse", key: "left" }); // A, in frame X: its report is held back
    r.calm(100);
    r.gate.press(WIN, { kind: "mouse", key: "left" }); // B, in frame Y
    expect(r.gate.seen(WIN, ["Y:1"])).toBe(true); // reports promptly
    r.calm(100);
    r.gate.press(WIN, { kind: "mouse", key: "left" }); // C, in frame Z
    r.calm(20);
    r.pass(STALL_TICK_MS + 3_000, 30, false); // main stalls
    expect(r.gate.seen(WIN, ["X:1"])).toBe(false); // A's report, which would name C's press
    for (const f of ["X:1", "Y:1", "Z:1"]) expect([f, r.gate.takeIn(WIN, f)]).toEqual([f, false]);
    expect(r.gate.whyNot(WIN, "X:1")).toContain(CROWDED);
    r.calm(10_000);
    r.click(["Z:1"]); // the next press, alone
    expect(r.gate.takeIn(WIN, "Z:1")).toBe(true);
  });

  test("A's own report window had already closed: X delays its report over 1 s, B lands 1.1 s after A, main stalls 2 s with X's report queued ahead: it is not B's", () => {
    const r = rig();
    r.gate.press(WIN, { kind: "mouse", key: "left" }); // A, in frame X
    r.calm(1_100); // X's report is more than a second late by the page's own doing
    r.gate.press(WIN, { kind: "mouse", key: "left" }); // B, in frame Y
    r.calm(20);
    r.pass(STALL_TICK_MS + 2_000, 30, false); // main stalls 2 s
    expect(r.gate.seen(WIN, ["X:1"])).toBe(false); // the stall would pay for X's own delay
    expect(r.gate.seen(WIN, ["Y:1"])).toBe(false);
    for (const f of ["X:1", "Y:1"]) expect([f, r.gate.takeIn(WIN, f)]).toEqual([f, false]);
    expect(r.gate.whyNot(WIN, "Y:1")).toContain(CROWDED);
  });

  test("four presses, the first two never reported: the report that comes after a stall is none of theirs to spend", () => {
    const r = rig();
    r.gate.press(WIN, { kind: "mouse", key: "left" }); // A
    r.calm(300);
    r.gate.press(WIN, { kind: "mouse", key: "left" }); // B
    r.calm(300);
    r.gate.press(WIN, { kind: "mouse", key: "left" }); // C, reports promptly
    expect(r.gate.seen(WIN, ["Z:1"])).toBe(true);
    r.calm(300);
    r.gate.press(WIN, { kind: "mouse", key: "left" }); // D
    r.calm(20);
    r.pass(STALL_TICK_MS + 4_000, 30, false);
    expect(r.gate.seen(WIN, ["X:1"])).toBe(false);
    for (const f of ["X:1", "Y:1", "Z:1"]) expect([f, r.gate.takeIn(WIN, f)]).toEqual([f, false]);
  });

  test("the earlier press's report came first and on time: the later press, stalled, still works", () => {
    const r = rig();
    r.gate.press(WIN, { kind: "mouse", key: "left" }); // A
    r.calm(100);
    expect(r.gate.seen(WIN, ["X:1"])).toBe(true); // A's report, on time
    r.calm(100);
    r.gate.press(WIN, { kind: "mouse", key: "left" }); // B
    r.calm(20);
    r.pass(STALL_TICK_MS + 3_000, 30, false); // main stalls between B's mouse down and B's report
    expect(r.gate.seen(WIN, ["Y:1"])).toBe(true);
    expect(r.gate.takeIn(WIN, "X:1")).toBe(false);
    expect(r.gate.takeIn(WIN, "Y:1")).toBe(true);
  });

  test("an earlier unreported press 5 s ago makes a later stalled report refused; 9.5 s ago it is out of range; a stall that ended before a prompt press is no reason", () => {
    const r = rig();
    r.gate.press(WIN, { kind: "mouse", key: "left" }); // A, never reported
    r.calm(5_000);
    r.gate.press(WIN, { kind: "mouse", key: "left" }); // B
    r.calm(20);
    r.pass(STALL_TICK_MS + 3_000, 30, false);
    expect(r.gate.seen(WIN, ["Y:1"])).toBe(false);
    const old = rig();
    old.gate.press(WIN, { kind: "mouse", key: "left" });
    old.calm(9_500);
    old.gate.press(WIN, { kind: "mouse", key: "left" });
    old.calm(20);
    old.pass(STALL_TICK_MS + 3_000, 30, false);
    expect(old.gate.seen(WIN, ["Y:1"])).toBe(true);
    expect(old.gate.takeIn(WIN, "Y:1")).toBe(true);
    const tail = rig();
    tail.gate.press(WIN, { kind: "mouse", key: "left" }); // A, never reported
    tail.pass(STALL_TICK_MS + 4_000, 30, true);
    tail.calm(2_000);
    tail.click(["Y:1"]); // a prompt press needs no credit, and A is not in the way
    expect(tail.gate.takeIn(WIN, "Y:1")).toBe(true);
  });

  test("the same two presses with no stall since A are as they were: the report in time is taken", () => {
    const r = rig();
    r.gate.press(WIN, { kind: "mouse", key: "left" });
    r.calm(100);
    r.gate.press(WIN, { kind: "mouse", key: "left" });
    r.calm(20);
    expect(r.gate.seen(WIN, ["Y:1"])).toBe(true);
    expect(r.gate.takeIn(WIN, "Y:1")).toBe(true);
  });

  test("a real stall of this process (sleeping), on the real clock and watch, between the report and the call", () => {
    const t0 = Date.now();
    const starved = () => ({ switches: () => Date.now() - t0, uptime: () => 100_000, load: () => ({ avg: 30, cores: 8 }) });
    const gate = new SendGate(Date.now, new StallWatch(starved()));
    gate.press(WIN, { kind: "mouse", key: "left" });
    gate.seen(WIN, [A]);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_600); // main not running for 1.6 s; the call arrives in the same turn
    expect(gate.takeIn(WIN, A)).toBe(true);
    // Without a watch the same real delay is refused, as before.
    const plain = new SendGate();
    plain.press(WIN, { kind: "mouse", key: "left" });
    plain.seen(WIN, [A]);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_600);
    expect(plain.takeIn(WIN, A)).toBe(false);
  });
});

describe("the wiring", () => {
  test("the stall watch is given the app's own processes' load (a plugin page's workers can raise the machine's load by themselves)", () => {
    const src = readFileSync(join(import.meta.dir, "..", "src", "main", "index.ts"), "utf8");
    expect(src).toContain("new SendGate(Date.now, new StallWatch({ ownLoad: appOwnLoad(() => app.getAppMetrics()) }))");
  });
});
