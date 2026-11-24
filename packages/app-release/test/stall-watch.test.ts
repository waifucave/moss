// The unscheduled-time watch (src/stall-watch.ts): what it credits, what it never does, and that it is quiet when idle.
import { describe, expect, test } from "bun:test";
import { processSwitches, StallWatch, STALL_CREDIT_MAX_MS, STALL_MIN_MS, STALL_MIN_SWITCHES, STALL_TICK_MS } from "../src/stall-watch";

/** A clock, a CPU meter and a timer the test moves by hand. */
function rig() {
  const c = { now: 1_000_000, cpu: 0, sw: 0, timers: 0, fn: undefined as (() => void) | undefined };
  const watch = new StallWatch({
    now: () => c.now, cpu: () => c.cpu, switches: () => c.sw,
    setTimer: (fn) => { c.timers++; c.fn = fn; return c.timers; },
    clearTimer: () => { c.fn = undefined; },
  });
  /** Time passes with the process using `cpu` ms of it and the OS preempting it `sw` times; then the timer, if it is still there, ticks. */
  const pass = (ms: number, cpu: number, tick = true, sw = 5): void => { c.now += ms; c.cpu += cpu; c.sw += sw; if (tick) c.fn?.(); };
  return { c, watch, pass };
}

describe("the stall watch", () => {
  test("a machine that kept up credits nothing, whatever the span", () => {
    const { c, watch, pass } = rig();
    const from = c.now;
    watch.arm(12_000);
    for (let i = 0; i < 20; i++) pass(STALL_TICK_MS + 20, 2); // ordinary jitter
    expect(watch.credit(from)).toBe(0);
  });

  test("a process the OS left waiting is credited the lag, in the span it fell in", () => {
    const { c, watch, pass } = rig();
    watch.arm(12_000);
    pass(STALL_TICK_MS, 1);
    const from = c.now; // the press
    pass(STALL_TICK_MS + 3_000, 20); // the next tick is 3 s late, the process having used 20 ms of it
    const credited = watch.credit(from);
    expect(credited).toBeGreaterThan(2_900);
    expect(credited).toBeLessThanOrEqual(3_000);
    // The stall before the press is not the press's.
    expect(watch.credit(c.now + 1)).toBe(0);
  });

  test("the gap still open when the question comes counts (the queued handler runs before the late tick)", () => {
    const { c, watch, pass } = rig();
    const from = c.now;
    watch.arm(12_000);
    pass(STALL_TICK_MS + 2_500, 10, false); // no tick yet
    const credited = watch.credit(from);
    expect(credited).toBeGreaterThan(2_400);
    expect(credited).toBeLessThanOrEqual(2_500);
  });

  test("a lag the process spent working earns nothing: busy is not stalled", () => {
    const { c, watch, pass } = rig();
    const from = c.now;
    watch.arm(12_000);
    pass(STALL_TICK_MS + 5_000, 4_900); // a handler a page's calls kept running
    expect(watch.credit(from)).toBeLessThan(STALL_MIN_MS + 100);
    const open = rig();
    const f2 = open.c.now;
    open.watch.arm(12_000);
    open.pass(STALL_TICK_MS + 5_000, 4_900, false);
    expect(open.watch.credit(f2)).toBeLessThan(STALL_MIN_MS + 100);
  });

  test("a partly working process is credited only the part it waited", () => {
    const { c, watch, pass } = rig();
    const from = c.now;
    watch.arm(12_000);
    pass(STALL_TICK_MS + 4_000, 3_000);
    const credited = watch.credit(from);
    expect(credited).toBeGreaterThan(900);
    expect(credited).toBeLessThanOrEqual(1_000);
  });

  test("it asks nothing when idle: no timer until a press arms it, and none after its time", () => {
    const { c, watch, pass } = rig();
    expect(watch.running).toBe(false);
    expect(c.timers).toBe(0);
    expect(watch.credit(c.now - 1_000)).toBe(0); // never watched: nothing to say
    watch.arm(1_000);
    expect(watch.running).toBe(true);
    for (let i = 0; i < 10; i++) pass(STALL_TICK_MS, 1);
    expect(watch.running).toBe(false);
    // A stall after the watch let go is nobody's.
    const from = c.now;
    pass(9_000, 0, false);
    expect(watch.credit(from)).toBe(0);
  });

  test("arming again while it runs adds to the time and never starts a second timer", () => {
    const { watch, c, pass } = rig();
    watch.arm(500);
    watch.arm(5_000);
    expect(c.timers).toBe(1);
    for (let i = 0; i < 10; i++) pass(STALL_TICK_MS, 1);
    expect(watch.running).toBe(true);
  });

  test("a timer the OS deferred on an idle process (App Nap, timer coalescing) earns nothing: late, no CPU used, no involuntary switches", () => {
    for (const tickFirst of [true, false]) {
      const { c, watch, pass } = rig();
      const from = c.now;
      watch.arm(12_000);
      pass(STALL_TICK_MS + 6_000, 3, tickFirst, 0); // the person went to another app; macOS held main's timer
      expect([tickFirst, watch.credit(from)]).toEqual([tickFirst, 0]);
      // One preemption is the ordinary run of a process, not starvation.
      const one = rig();
      const f1 = one.c.now;
      one.watch.arm(12_000);
      one.pass(STALL_TICK_MS + 6_000, 3, tickFirst, STALL_MIN_SWITCHES - 1);
      expect([tickFirst, one.watch.credit(f1)]).toEqual([tickFirst, 0]);
    }
  });

  test("real starvation (runnable, preempted, little CPU) earns credit, deferred or not before it and after it", () => {
    const { c, watch, pass } = rig();
    const from = c.now;
    watch.arm(12_000);
    pass(STALL_TICK_MS + 3_000, 20, true, STALL_MIN_SWITCHES);
    expect(watch.credit(from)).toBeGreaterThan(2_900);
    // A deferral first, starvation after: only the starvation counts.
    const mixed = rig();
    const f2 = mixed.c.now;
    mixed.watch.arm(12_000);
    mixed.pass(STALL_TICK_MS + 6_000, 3, true, 0);
    mixed.pass(STALL_TICK_MS + 2_000, 10, true, 9);
    const credited = mixed.watch.credit(f2);
    expect(credited).toBeGreaterThan(1_900);
    expect(credited).toBeLessThanOrEqual(2_000);
  });

  test("where the platform keeps no context-switch count (Windows) or the reading is missing, nothing is credited", () => {
    const c = { now: 1_000_000, cpu: 0, fn: undefined as (() => void) | undefined };
    const watch = new StallWatch({ now: () => c.now, cpu: () => c.cpu, switches: () => undefined, setTimer: (fn) => { c.fn = fn; return 1; }, clearTimer: () => { c.fn = undefined; } });
    const from = c.now;
    watch.arm(12_000);
    c.now += STALL_TICK_MS + 5_000;
    c.cpu += 10;
    expect(watch.credit(from)).toBe(0);
    c.fn?.();
    expect(watch.credit(from)).toBe(0);
    expect(processSwitches("win32")).toBeUndefined();
  });

  test("the default reading is the process's own count on this platform (non-negative, never falling)", () => {
    if (process.platform === "win32") return;
    const a = processSwitches();
    const b = processSwitches();
    expect(typeof a).toBe("number");
    expect(b! >= a!).toBe(true);
  });

  test("the cap is the callers' number and is eight seconds", () => {
    expect(STALL_CREDIT_MAX_MS).toBe(8_000);
  });
});
