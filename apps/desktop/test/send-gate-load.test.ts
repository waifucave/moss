// MOSS Code's composer send on a machine that is too busy to schedule the main process (the twin of apps/moss/test/press-load.test.ts).
// SendGate timed a press by when main HANDLED it: the mouse down (`press`), the frame's report (`seen`, 1000 ms) and the call
// (`takeIn`, 1000 ms; `take`, 1000 ms). With a stall watch the age is counted without the time the process itself was not running
// (never more than the cap, none for time it spent working); with no stall every bound is as it was. What must stay refused is
// here beside the stalled cases.
import { describe, expect, test } from "bun:test";
import { StallWatch, STALL_CREDIT_MAX_MS, STALL_TICK_MS } from "@waifucave/moss-app-release/stall-watch";
import { PRESS_REPORT_MS, SEND_INPUT_WINDOW_MS, SendGate } from "../src/main/ui/brokers";

const WIN = 1;
const A = "10:1";
const B = "10:2";

function rig() {
  const c = { now: 9_000_000, cpu: 0, sw: 0, tick: undefined as (() => void) | undefined };
  const watch = new StallWatch({ now: () => c.now, cpu: () => c.cpu, switches: () => c.sw, setTimer: (fn) => { c.tick = fn; return 1; }, clearTimer: () => { c.tick = undefined; } });
  const gate = new SendGate(() => c.now, watch);
  const pass = (ms: number, cpu = 1, tick = true, sw = 5): void => { c.now += ms; c.cpu += cpu; c.sw += sw; if (tick) c.tick?.(); };
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
    let preempted = 0;
    const gate = new SendGate(Date.now, new StallWatch({ switches: () => (preempted += 5) }));
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
