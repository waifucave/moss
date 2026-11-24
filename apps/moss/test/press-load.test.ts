// A person's real press on a machine that is too busy to schedule MOSS's main process (the owner could not send while the load
// was over 300). press.ts times a press by when main HANDLED it: the mouse down (`before-mouse-event`), the page's report
// (`moss:press-seen`) and the write's arrival (`moss:send`), so a stall between two handlers aged a genuine press. `takeWrite`
// subtracts the time main itself was not running (StallWatch: lag less the CPU the process used), and nothing else.
//
// Every refusal that must stay a refusal is here beside the stalled cases: no press, a second write from one press, a press in
// another frame or window, a page holding a press while the machine kept up, a stall the process spent working, a stall past the
// cap, two presses whose reports can't be told apart, and the sealed buttons' `take` (strict, as before).
import { describe, expect, test } from "bun:test";
import { StallWatch, STALL_CREDIT_MAX_MS, STALL_TICK_MS } from "@waifucave/moss-app-release/stall-watch";
import { PRESS_MS, PressRecord, REPORT_MS, writeRefusalWords } from "../src/main/press";

const WIN = 7;
const MAIN = "11:22";

/** A press record on a clock the test moves, with the real StallWatch on the same clock and a CPU meter the test sets. */
function rig() {
  const c = { now: 5_000_000, cpu: 0, sw: 0, tick: undefined as (() => void) | undefined };
  const watch = new StallWatch({ now: () => c.now, cpu: () => c.cpu, switches: () => c.sw, uptime: () => 100_000, load: () => ({ avg: 20, cores: 8 }), setTimer: (fn) => { c.tick = fn; return 1; }, clearTimer: () => { c.tick = undefined; } });
  const record = new PressRecord(() => c.now, watch);
  /** Time passes; the process used `cpu` ms of it; the watch's timer ticks when asked (and it exists). */
  const pass = (ms: number, cpu = 1, tick = true, sw = ms > STALL_TICK_MS + 50 ? ms : Math.round(ms / 100)): void => { c.now += ms; c.cpu += cpu; c.sw += sw; if (tick) c.tick?.(); };
  /** An ordinary stretch: the timer beats on time. */
  const calm = (ms: number): void => { for (let left = ms; left > 0; left -= STALL_TICK_MS) pass(Math.min(left, STALL_TICK_MS), 1); };
  return { c, watch, record, pass, calm };
}

describe("a genuine press on a machine that kept up", () => {
  test("the bounds are today's: the write 1500 ms after the press, the report 1000 ms after it, and not a ms more", () => {
    for (const [reportAt, sendAt, ok] of [[10, 1_500, true], [10, 1_501, false], [1_000, 1_500, true], [1_001, 1_500, false]] as const) {
      const r = rig();
      r.record.mouseDown(WIN);
      r.calm(reportAt);
      r.record.frameSaw(WIN, MAIN);
      r.calm(sendAt - reportAt);
      expect([reportAt, sendAt, r.record.takeWrite(WIN, MAIN).ok]).toEqual([reportAt, sendAt, ok]);
    }
  });

  test("a refusal says which check and by how many ms", () => {
    const r = rig();
    r.record.mouseDown(WIN);
    r.calm(10);
    r.record.frameSaw(WIN, MAIN);
    r.calm(1_641);
    expect(r.record.takeWrite(WIN, MAIN)).toMatchObject({ ok: false, check: "the write came too late", overMs: 151, late: true });
    const q = rig();
    q.record.mouseDown(WIN);
    q.calm(1_200);
    q.record.frameSaw(WIN, MAIN);
    expect(q.record.takeWrite(WIN, MAIN)).toMatchObject({ ok: false, check: "the page's report came too late", overMs: 200, late: true });
  });

  test("a key press: the write 1500 ms after the key down, and not a ms more", () => {
    for (const [at, ok] of [[1_500, true], [1_501, false]] as const) {
      const r = rig();
      r.record.keyDown(WIN, MAIN);
      r.calm(at);
      expect([at, r.record.takeWrite(WIN, MAIN).ok]).toEqual([at, ok]);
    }
  });

  test("a page that holds a press (a script waiting) is refused: no stall, no extra time", () => {
    const r = rig();
    r.record.mouseDown(WIN);
    r.calm(10);
    r.record.frameSaw(WIN, MAIN);
    r.calm(8_000); // eight quiet seconds: the timer beat on time throughout
    expect(r.record.takeWrite(WIN, MAIN)).toMatchObject({ ok: false, check: "the write came too late", stalledMs: 0 });
  });
});

describe("a genuine press while the machine stalled main (the same press, accepted)", () => {
  test("a stall between the mouse down and the page's report (the report handled before the late tick, then after it)", () => {
    for (const tickFirst of [false, true]) {
      const r = rig();
      r.record.mouseDown(WIN);
      r.calm(20);
      r.pass(STALL_TICK_MS + 4_000, 30, tickFirst); // main was not scheduled for 4 s; the OS gave it 30 ms
      r.record.frameSaw(WIN, MAIN);
      r.pass(40, 5);
      expect([tickFirst, r.record.takeWrite(WIN, MAIN)]).toEqual([tickFirst, { ok: true, how: "click", stalledMs: expect.any(Number) }]);
    }
  });

  test("a stall between the report and the write: the write arrives 5 s after the mouse down and counts", () => {
    for (const tickFirst of [false, true]) {
      const r = rig();
      r.record.mouseDown(WIN);
      r.calm(20);
      r.record.frameSaw(WIN, MAIN);
      r.pass(STALL_TICK_MS + 4_700, 30, tickFirst);
      const took = r.record.takeWrite(WIN, MAIN);
      expect([tickFirst, took.ok]).toEqual([tickFirst, true]);
      expect(took.ok && took.stalledMs).toBeGreaterThan(4_000);
    }
  });

  test("a stall before main handled the mouse down is invisible: the press is stamped when main got to it, and counts as it always did", () => {
    const r = rig();
    r.watch.arm(1_000); // something earlier had the watch running
    r.pass(STALL_TICK_MS + 6_000, 10);
    r.record.mouseDown(WIN);
    r.calm(10);
    r.record.frameSaw(WIN, MAIN);
    r.calm(1_400);
    expect(r.record.takeWrite(WIN, MAIN).ok).toBe(true);
  });

  test("a key press written during a stall", () => {
    const r = rig();
    r.record.keyDown(WIN, MAIN);
    r.pass(STALL_TICK_MS + 3_000, 20, false);
    expect(r.record.takeWrite(WIN, MAIN).ok).toBe(true);
  });

  test("a real stall of this process (sleeping, not working) between the mouse down and the report, on the real clock and the real watch", () => {
    // The real clock and the real CPU meter; the OS's preemption count can't be made by a test, so it is read as a rising one.
    const t0 = Date.now();
    const starved = () => ({ switches: () => Date.now() - t0, uptime: () => 100_000, load: () => ({ avg: 30, cores: 8 }) });
    const watch = new StallWatch(starved());
    const record = new PressRecord(Date.now, watch);
    const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
    record.mouseDown(WIN);
    sleep(1_400); // main not running: 1.4 s between the mouse down and the report, which is over REPORT_MS
    record.frameSaw(WIN, MAIN);
    sleep(400);
    // Handled with no yield after the stall (the queued handler runs before the watch's own late tick), at 1.8 s: over both bounds.
    const took = record.takeWrite(WIN, MAIN);
    expect(took.ok).toBe(true);
    // The same timeline on the sealed buttons' strict `take`: refused, as it always was (it has no report in time).
    const strict = new PressRecord(Date.now, new StallWatch(starved()));
    strict.mouseDown(WIN);
    sleep(1_400);
    strict.frameSaw(WIN, MAIN);
    expect(strict.take(WIN, MAIN)).toBeUndefined();
  });

  test("the same real delay spent working (a busy loop) is not a stall: refused", () => {
    const t0 = Date.now();
    const starved = () => ({ switches: () => Date.now() - t0, uptime: () => 100_000, load: () => ({ avg: 30, cores: 8 }) });
    const record = new PressRecord(Date.now, new StallWatch(starved()));
    const spin = (ms: number): void => { const end = Date.now() + ms; while (Date.now() < end) { /* the process is running */ } };
    record.mouseDown(WIN);
    spin(1_400);
    record.frameSaw(WIN, MAIN);
    expect(record.takeWrite(WIN, MAIN)).toMatchObject({ ok: false, check: "the page's report came too late" });
  });
});

describe("what a stall never buys", () => {
  test("a stall the process spent working (a flood of the page's calls kept it busy) earns no time", () => {
    const r = rig();
    r.record.mouseDown(WIN);
    r.calm(10);
    r.record.frameSaw(WIN, MAIN);
    r.pass(STALL_TICK_MS + 5_000, 5_000);
    expect(r.record.takeWrite(WIN, MAIN)).toMatchObject({ ok: false, check: "the write came too late" });
  });

  test("the credit is capped: the press may be held 1.5 s plus eight seconds at most, whatever the stall", () => {
    const edge = rig();
    edge.record.mouseDown(WIN);
    edge.calm(10);
    edge.record.frameSaw(WIN, MAIN);
    edge.pass(PRESS_MS + STALL_CREDIT_MAX_MS - 10, 5, false); // 9 500 ms in all, the whole of it waited
    expect(edge.record.takeWrite(WIN, MAIN).ok).toBe(true);
    const over = rig();
    over.record.mouseDown(WIN);
    over.calm(10);
    over.record.frameSaw(WIN, MAIN);
    over.pass(PRESS_MS + STALL_CREDIT_MAX_MS + 1 - 10, 5, false);
    expect(over.record.takeWrite(WIN, MAIN)).toMatchObject({ ok: false, check: "the write came too late", overMs: 1 });
    const long = rig();
    long.record.mouseDown(WIN);
    long.calm(10);
    long.record.frameSaw(WIN, MAIN);
    long.pass(60_000, 5, false);
    expect(long.record.takeWrite(WIN, MAIN)).toMatchObject({ ok: false, check: "the write came too late" });
  });

  test("a stall earns only the stall's own time: the time before it and after it is still counted against the bound", () => {
    const r = rig();
    r.record.mouseDown(WIN);
    r.calm(10);
    r.record.frameSaw(WIN, MAIN);
    r.calm(1_400); // 1.4 s on time ...
    r.pass(STALL_TICK_MS + 1_000, 5); // ... then a one-second stall: 1.4 s + 0.25 s of timer period is counted, so it is over
    expect(r.record.takeWrite(WIN, MAIN)).toMatchObject({ ok: false, check: "the write came too late" });
  });

  test("no press at all: refused, with a stall or without", () => {
    const r = rig();
    expect(r.record.takeWrite(WIN, MAIN)).toEqual({ ok: false, check: "no press seen" });
    r.watch.arm(12_000);
    r.pass(STALL_TICK_MS + 6_000, 5);
    expect(r.record.takeWrite(WIN, MAIN)).toEqual({ ok: false, check: "no press seen" });
  });

  test("one press, one write: a second write on the same press is refused, even in a stall", () => {
    const r = rig();
    r.record.mouseDown(WIN);
    r.calm(10);
    r.record.frameSaw(WIN, MAIN);
    r.pass(STALL_TICK_MS + 3_000, 5, false);
    expect(r.record.takeWrite(WIN, MAIN).ok).toBe(true);
    expect(r.record.takeWrite(WIN, MAIN)).toEqual({ ok: false, check: "the press was already used" });
    // A key press and a click are different presses, each one write.
    r.record.keyDown(WIN, MAIN);
    expect(r.record.takeWrite(WIN, MAIN).ok).toBe(true);
    expect(r.record.takeWrite(WIN, MAIN)).toMatchObject({ ok: false });
  });

  test("a press that landed in one frame doesn't pay for a write in another, nor in another window", () => {
    const r = rig();
    r.record.mouseDown(WIN);
    r.calm(10);
    r.record.frameSaw(WIN, "99:1"); // the press landed in another frame (a card's)
    r.pass(STALL_TICK_MS + 3_000, 5, false);
    expect(r.record.takeWrite(WIN, MAIN)).toMatchObject({ ok: false, check: "the press landed in another frame" });
    expect(r.record.takeWrite(WIN + 1, "99:1")).toEqual({ ok: false, check: "no press seen" });
    expect(r.record.takeWrite(WIN, "99:1").ok).toBe(true); // it is that frame's own press, once
    const k = rig();
    k.record.keyDown(WIN, "99:1");
    expect(k.record.takeWrite(WIN, MAIN)).toMatchObject({ ok: false, check: "the press landed in another frame" });
  });

  test("a click that no trusted pointerdown in the page followed is no press, in a stall as outside one", () => {
    const r = rig();
    r.record.mouseDown(WIN); // main saw a mouse down (a scroll bar, a drag region); the page's document reported none
    r.pass(STALL_TICK_MS + 3_000, 5, false);
    expect(r.record.takeWrite(WIN, MAIN)).toMatchObject({ ok: false, check: "no pointerdown report from this page" });
  });

  test("a page's report that came only after another press came is not attributed (a second press while the first waits for its report on a stalled machine)", () => {
    const r = rig();
    r.record.mouseDown(WIN); // press 1, which landed in a card's frame; its report is held up by the stall
    r.pass(STALL_TICK_MS + 600, 5, false);
    r.record.mouseDown(WIN); // press 2, in the page
    r.record.frameSaw(WIN, "99:1"); // press 1's report, late: it would name press 2's
    r.record.frameSaw(WIN, MAIN);
    expect(r.record.takeWrite(WIN, MAIN)).toMatchObject({ ok: false, check: "two presses close together on a stalled machine" });
    expect(r.record.takeWrite(WIN, "99:1")).toMatchObject({ ok: false, check: "two presses close together on a stalled machine" });
    // The person's next press stands alone.
    r.calm(2_000);
    r.record.mouseDown(WIN);
    r.record.frameSaw(WIN, MAIN);
    r.calm(50);
    expect(r.record.takeWrite(WIN, MAIN).ok).toBe(true);
  });

  test("press A in frame X with no report yet, press B in frame Y with no stall yet, then main stalls, then X's report: it is not B's (X can't spend Y's press, nor Y use X's)", () => {
    const r = rig();
    r.record.mouseDown(WIN); // A, which landed in frame X: its report is slow
    r.calm(100);
    r.record.mouseDown(WIN); // B, in frame Y: the machine had not stalled yet
    r.calm(20);
    r.pass(STALL_TICK_MS + 4_000, 30, false); // then main stalls
    r.record.frameSaw(WIN, "X:1"); // A's report, which would name B's press
    r.pass(30, 3);
    expect(r.record.takeWrite(WIN, "X:1")).toMatchObject({ ok: false, check: "two presses close together on a stalled machine" });
    expect(r.record.takeWrite(WIN, "Y:1")).toMatchObject({ ok: false, check: "two presses close together on a stalled machine" });
    // Nothing was spent: the person's next press, alone, goes through.
    r.calm(2_000);
    r.record.mouseDown(WIN);
    r.record.frameSaw(WIN, "Y:1");
    r.calm(40);
    expect(r.record.takeWrite(WIN, "Y:1").ok).toBe(true);
  });

  const CROWDED = { ok: false, check: "two presses close together on a stalled machine" } as const;

  test("three presses: A in X (report held back), B in Y (reports promptly), C in Z, then main stalls and X's report comes: it is not C's", () => {
    const r = rig();
    r.record.mouseDown(WIN); // A, in frame X: its report is held back
    r.calm(100);
    r.record.mouseDown(WIN); // B, in frame Y: reports promptly
    r.record.frameSaw(WIN, "Y:1");
    r.calm(100);
    r.record.mouseDown(WIN); // C, in frame Z: no report yet
    r.calm(20);
    r.pass(STALL_TICK_MS + 3_000, 30, false); // main stalls
    r.record.frameSaw(WIN, "X:1"); // A's report, which would name C's press
    r.pass(30, 3);
    for (const f of ["X:1", "Y:1", "Z:1"]) expect([f, r.record.takeWrite(WIN, f)]).toMatchObject([f, CROWDED]);
    // Nothing was spent: the person's next press, alone, goes through.
    r.calm(10_000);
    r.record.mouseDown(WIN);
    r.record.frameSaw(WIN, "Z:1");
    r.calm(40);
    expect(r.record.takeWrite(WIN, "Z:1").ok).toBe(true);
  });

  test("A's own report window had already closed: X delays its report over 1 s, B lands 1.1 s after A, main stalls 2 s with X's report queued ahead: it is not B's", () => {
    const r = rig();
    r.record.mouseDown(WIN); // A, in frame X
    r.calm(1_100); // X's report is over REPORT_MS late by the page's own doing (no stall yet)
    r.record.mouseDown(WIN); // B, in frame Y
    r.calm(20);
    r.pass(STALL_TICK_MS + 2_000, 30, false); // main stalls 2 s
    r.record.frameSaw(WIN, "X:1"); // X's report, handled ahead of Y's: the stall would pay for X's own delay
    r.record.frameSaw(WIN, "Y:1");
    r.pass(30, 3);
    expect(r.record.takeWrite(WIN, "X:1")).toMatchObject(CROWDED);
    expect(r.record.takeWrite(WIN, "Y:1")).toMatchObject(CROWDED);
  });

  test("four presses, the first two never reported: the report that comes after a stall is none of theirs to spend", () => {
    const r = rig();
    r.record.mouseDown(WIN); // A
    r.calm(300);
    r.record.mouseDown(WIN); // B
    r.calm(300);
    r.record.mouseDown(WIN); // C, reports promptly
    r.record.frameSaw(WIN, "Z:1");
    r.calm(300);
    r.record.mouseDown(WIN); // D
    r.calm(20);
    r.pass(STALL_TICK_MS + 4_000, 30, false);
    r.record.frameSaw(WIN, "X:1");
    for (const f of ["X:1", "Y:1", "Z:1"]) expect([f, r.record.takeWrite(WIN, f)]).toMatchObject([f, CROWDED]);
  });

  test("the earlier press's report came first and on time: the later press, stalled, still works (and the earlier press is not spendable)", () => {
    const r = rig();
    r.record.mouseDown(WIN); // A
    r.calm(100);
    r.record.frameSaw(WIN, "X:1"); // A's report, on time
    r.calm(100);
    r.record.mouseDown(WIN); // B
    r.calm(20);
    r.pass(STALL_TICK_MS + 3_000, 30, false); // main stalls between B's mouse down and B's report
    r.record.frameSaw(WIN, "Y:1");
    r.pass(30, 3);
    expect(r.record.takeWrite(WIN, "X:1")).toMatchObject({ ok: false, check: "the press landed in another frame" });
    expect(r.record.takeWrite(WIN, "Y:1")).toMatchObject({ ok: true, how: "click" });
  });

  test("an earlier unreported press 5 s ago (no stall since) makes a later stalled report refused; 9.5 s ago it is out of range; a stall that ended before a prompt press is no reason", () => {
    const r = rig();
    r.record.mouseDown(WIN); // A, never reported
    r.calm(5_000);
    r.record.mouseDown(WIN); // B
    r.calm(20);
    r.pass(STALL_TICK_MS + 3_000, 30, false);
    r.record.frameSaw(WIN, "Y:1");
    expect(r.record.takeWrite(WIN, "Y:1")).toMatchObject(CROWDED);
    const old = rig();
    old.record.mouseDown(WIN);
    old.calm(9_500); // older than REPORT_MS plus the cap: nothing it could still be waiting for
    old.record.mouseDown(WIN);
    old.calm(20);
    old.pass(STALL_TICK_MS + 3_000, 30, false);
    old.record.frameSaw(WIN, "Y:1");
    expect(old.record.takeWrite(WIN, "Y:1").ok).toBe(true);
    // A stalled, then calm, then a prompt press: no credit is needed, and A is not in the way.
    const tail = rig();
    tail.record.mouseDown(WIN); // A, never reported
    tail.pass(STALL_TICK_MS + 4_000, 30, true);
    tail.calm(2_000);
    tail.record.mouseDown(WIN);
    tail.record.frameSaw(WIN, "Y:1");
    tail.calm(40);
    expect(tail.record.takeWrite(WIN, "Y:1").ok).toBe(true);
  });

  test("the same two presses with the report in time and no stall since A are judged as they always were", () => {
    const r = rig();
    r.record.mouseDown(WIN);
    r.calm(100);
    r.record.mouseDown(WIN);
    r.calm(20);
    r.record.frameSaw(WIN, "Y:1");
    r.calm(20);
    expect(r.record.takeWrite(WIN, "Y:1").ok).toBe(true);
  });

  test("a clock that went backwards past a press is no press (the guard SendGate.takeIn has)", () => {
    const r = rig();
    r.record.mouseDown(WIN);
    r.record.frameSaw(WIN, MAIN);
    r.c.now -= 5_000;
    expect(r.record.takeWrite(WIN, MAIN)).toEqual({ ok: false, check: "no press seen" });
    const k = rig();
    k.record.keyDown(WIN, MAIN);
    k.c.now -= 5_000;
    expect(k.record.takeWrite(WIN, MAIN)).toEqual({ ok: false, check: "no press seen" });
  });

  test("two quick presses on a machine that kept up are as they were (nothing is crowded without a stall)", () => {
    const r = rig();
    r.record.mouseDown(WIN);
    r.calm(300);
    r.record.mouseDown(WIN); // the first press's report never came (no document there)
    r.calm(20);
    r.record.frameSaw(WIN, MAIN);
    r.calm(20);
    expect(r.record.takeWrite(WIN, MAIN).ok).toBe(true);
  });

  test("the sealed buttons' take keeps its strict bounds on a stalled machine: it takes no late report and no late answer", () => {
    // Late report: the stalled timeline that takeWrite accepts.
    const a = rig();
    a.record.mouseDown(WIN);
    a.calm(20);
    a.pass(STALL_TICK_MS + 4_000, 30, false);
    a.record.frameSaw(WIN, MAIN);
    expect(a.record.take(WIN, MAIN)).toBeUndefined();
    // Late answer, report in time.
    const b = rig();
    b.record.mouseDown(WIN);
    b.calm(20);
    b.record.frameSaw(WIN, MAIN);
    b.pass(STALL_TICK_MS + 4_000, 30, false);
    expect(b.record.take(WIN, MAIN)).toBeUndefined();
    // On time: taken once.
    const c = rig();
    c.record.mouseDown(WIN);
    c.calm(20);
    c.record.frameSaw(WIN, MAIN);
    c.calm(1_000);
    expect(c.record.take(WIN, MAIN)).toBe("click");
    expect(c.record.take(WIN, MAIN)).toBeUndefined();
  });

  test("a press taken by a write is spent for the sealed path too, and the other way", () => {
    const r = rig();
    r.record.mouseDown(WIN);
    r.record.frameSaw(WIN, MAIN);
    expect(r.record.take(WIN, MAIN)).toBe("click");
    expect(r.record.takeWrite(WIN, MAIN)).toEqual({ ok: false, check: "the press was already used" });
    const q = rig();
    q.record.mouseDown(WIN);
    q.record.frameSaw(WIN, MAIN);
    expect(q.record.takeWrite(WIN, MAIN).ok).toBe(true);
    expect(q.record.take(WIN, MAIN)).toBeUndefined();
  });

  test("bounds are the same constants as before", () => {
    expect([PRESS_MS, REPORT_MS]).toEqual([1_500, 1_000]);
  });
});

describe("a refused sealed press names its check and its ms in the log", () => {
  test("explainTake reads the strict bounds and spends nothing", () => {
    const none = rig();
    expect(none.record.explainTake(WIN, MAIN)).toBe("main saw no mouse down or key down in this window");
    const late = rig();
    late.record.mouseDown(WIN);
    late.calm(1_200);
    late.record.frameSaw(WIN, MAIN);
    expect(late.record.explainTake(WIN, MAIN)).toBe("no report from the page named a frame; the mouse down was 1200 ms ago; a report came 1200 ms after it, limit 1000");
    const old = rig();
    old.record.mouseDown(WIN);
    old.record.frameSaw(WIN, MAIN);
    old.calm(1_700);
    expect(old.record.explainTake(WIN, MAIN)).toBe("the answer came 200 ms past the bound of 1500");
    expect(old.record.explainTake(WIN, "99:1")).toBe("the click landed in another frame");
    expect(old.record.take(WIN, MAIN)).toBeUndefined(); // it spent nothing: the strict answer is the same after asking
    const used = rig();
    used.record.mouseDown(WIN);
    used.record.frameSaw(WIN, MAIN);
    expect(used.record.take(WIN, MAIN)).toBe("click");
    expect(used.record.explainTake(WIN, MAIN)).toBe("the click was already used");
  });
});

describe("what the person is told", () => {
  test("a press that was theirs and only late says the computer was busy and nothing was lost; anything else is the old sentence", () => {
    expect(writeRefusalWords({ check: "the write came too late", late: true })).toBe("Your computer was too busy to confirm that press in time. Nothing was lost: press again.");
    expect(writeRefusalWords({ check: "the page's report came too late", late: true })).toContain("too busy");
    expect(writeRefusalWords({ check: "two presses close together on a stalled machine" })).toContain("too busy");
    expect(writeRefusalWords({ check: "no press seen" })).toBe("Words go only right after your own key press or click.");
    expect(writeRefusalWords({ check: "the press landed in another frame" })).toBe("Words go only right after your own key press or click.");
  });
});
