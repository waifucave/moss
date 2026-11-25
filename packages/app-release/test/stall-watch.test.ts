// The unscheduled-time watch (src/stall-watch.ts): what it credits, what it never does, and that it is quiet when idle.
import { describe, expect, test } from "bun:test";
import { machineLoad, ownLoadReader, processSwitches, StallWatch, STALL_CREDIT_MAX_MS, STALL_MIN_MS, STALL_SWITCH_MULTIPLE, STALL_TICK_MS } from "../src/stall-watch";

/** A clock, a CPU meter, a switch counter, a load reading and a timer the test moves by hand. By default the machine is
 *  overloaded (load 20 on 8 cores) and a pass that ran long past its tick was preempted about once a ms (the reviewer
 *  measured 1.2/ms busy), an on-time one about once per 100 ms (he measured 2 to 3 per 250 ms tick idle). */
function rig(opts: { load?: { avg: number; cores: number } | undefined; uptime?: number; own?: number | undefined } = {}) {
  const c = { now: 1_000_000, cpu: 0, sw: 0, timers: 0, load: "load" in opts ? opts.load : ({ avg: 20, cores: 8 } as { avg: number; cores: number } | undefined), fn: undefined as (() => void) | undefined };
  const watch = new StallWatch({
    now: () => c.now, cpu: () => c.cpu, switches: () => c.sw, uptime: () => opts.uptime ?? 100_000, load: () => c.load, ...("own" in opts ? { ownLoad: () => opts.own } : {}),
    setTimer: (fn) => { c.timers++; c.fn = fn; return c.timers; },
    clearTimer: () => { c.fn = undefined; },
  });
  /** Time passes with the process using `cpu` ms of it and the OS preempting it `sw` times; then the timer, if it is still there, ticks. */
  const pass = (ms: number, cpu: number, tick = true, sw = ms > STALL_TICK_MS + 50 ? ms : Math.round(ms / 100)): void => { c.now += ms; c.cpu += cpu; c.sw += sw; if (tick) c.fn?.(); };
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

  test("a partly working process (up to half the lag) is credited only the part it waited; a mostly working one nothing", () => {
    const { c, watch, pass } = rig();
    const from = c.now;
    watch.arm(12_000);
    pass(STALL_TICK_MS + 4_000, 1_500);
    const credited = watch.credit(from);
    expect(credited).toBeGreaterThan(2_400);
    expect(credited).toBeLessThanOrEqual(2_500);
    const busy = rig();
    const f2 = busy.c.now;
    busy.watch.arm(12_000);
    busy.pass(STALL_TICK_MS + 4_000, 3_000); // used three quarters of the lag: "little CPU" does not hold
    expect(busy.watch.credit(f2)).toBe(0);
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

  test("a timer the OS deferred on an idle process earns nothing even with a few switches, loaded machine or not", () => {
    for (const tickFirst of [true, false]) {
      for (const sw of [0, 1, 3, 20]) {
        for (const load of [{ avg: 20, cores: 8 }, { avg: 1, cores: 8 }]) {
          const { c, watch, pass } = rig({ load });
          const from = c.now;
          watch.arm(12_000);
          pass(STALL_TICK_MS + 6_000, 3, tickFirst, sw); // the person went to another app; macOS held main's timer
          expect([tickFirst, sw, load.avg, watch.credit(from)]).toEqual([tickFirst, sw, load.avg, 0]);
        }
      }
    }
  });

  test("an overloaded machine but this process busy earns nothing", () => {
    for (const tickFirst of [true, false]) {
      const { c, watch, pass } = rig();
      const from = c.now;
      watch.arm(12_000);
      pass(STALL_TICK_MS + 6_000, 5_900, tickFirst, 6_000); // preempted a lot, but it was running most of the time
      expect([tickFirst, watch.credit(from)]).toEqual([tickFirst, 0]);
    }
  });

  test("overloaded, little CPU used, switches far above its own idle rate: credited, before the late tick and after it", () => {
    for (const tickFirst of [true, false]) {
      const { c, watch, pass } = rig();
      const from = c.now;
      watch.arm(12_000);
      pass(STALL_TICK_MS + 3_000, 20, tickFirst);
      const credited = watch.credit(from);
      expect([tickFirst, credited > 2_900, credited <= 3_000]).toEqual([tickFirst, true, true]);
    }
    // A deferral first, starvation after: only the starvation counts.
    const mixed = rig();
    const f2 = mixed.c.now;
    mixed.watch.arm(12_000);
    mixed.pass(STALL_TICK_MS + 6_000, 3, true, 0);
    mixed.pass(STALL_TICK_MS + 2_000, 10, true);
    const credited = mixed.watch.credit(f2);
    expect(credited).toBeGreaterThan(1_900);
    expect(credited).toBeLessThanOrEqual(2_000);
  });

  test("no overload, no credit: lots of switches and little CPU on a machine with room is not a stall", () => {
    for (const avg of [0.5, 7.9]) {
      const { c, watch, pass } = rig({ load: { avg, cores: 8 } });
      const from = c.now;
      watch.arm(12_000);
      pass(STALL_TICK_MS + 4_000, 20);
      expect([avg, watch.credit(from)]).toEqual([avg, 0]);
    }
    const edge = rig({ load: { avg: 8, cores: 8 } }); // load equal to the cores is overloaded
    const f = edge.c.now;
    edge.watch.arm(12_000);
    edge.pass(STALL_TICK_MS + 4_000, 20);
    expect(edge.watch.credit(f)).toBeGreaterThan(3_900);
  });

  test("no load reading (Windows, a throwing read) earns nothing", () => {
    const { c, watch, pass } = rig({ load: undefined });
    const from = c.now;
    watch.arm(12_000);
    pass(STALL_TICK_MS + 4_000, 20);
    expect(watch.credit(from)).toBe(0);
    expect(machineLoad("win32")).toBeUndefined();
  });

  test("load the product's own processes account for earns nothing: 20 on 12 cores with 16 cores' worth burned by our own renderers", () => {
    const own = rig({ load: { avg: 20, cores: 12 }, own: 16 });
    const from = own.c.now;
    own.watch.arm(12_000);
    own.pass(STALL_TICK_MS + 4_000, 20, true);
    expect(own.watch.credit(from)).toBe(0);
    const open = rig({ load: { avg: 20, cores: 12 }, own: 16 });
    const f2 = open.c.now;
    open.watch.arm(12_000);
    open.pass(STALL_TICK_MS + 4_000, 20, false);
    expect(open.watch.credit(f2)).toBe(0);
  });

  test("the same load from elsewhere earns credit; the product's own share only comes off the load", () => {
    const other = rig({ load: { avg: 20, cores: 12 }, own: 0.5 });
    const from = other.c.now;
    other.watch.arm(12_000);
    other.pass(STALL_TICK_MS + 4_000, 20, true);
    expect(other.watch.credit(from)).toBeGreaterThan(3_900);
    // 20 less 8 is exactly the 12 cores: still overloaded; a hair more of ours is not.
    for (const [own, credited] of [[8, true], [8.01, false]] as const) {
      const r = rig({ load: { avg: 20, cores: 12 }, own });
      const f = r.c.now;
      r.watch.arm(12_000);
      r.pass(STALL_TICK_MS + 4_000, 20, true);
      expect([own, r.watch.credit(f) > 3_900]).toEqual([own, credited]);
    }
  });

  test("where the app supplies a reading of its own load and it can't be read, nothing is credited; a throwing reader is no reading", () => {
    for (const own of [undefined, Number.NaN]) {
      const r = rig({ own });
      const from = r.c.now;
      r.watch.arm(12_000);
      r.pass(STALL_TICK_MS + 4_000, 20, true);
      expect([own, r.watch.credit(from)]).toEqual([own, 0]);
    }
    const c = { now: 1_000_000, cpu: 0, sw: 0, fn: undefined as (() => void) | undefined };
    const watch = new StallWatch({ now: () => c.now, cpu: () => c.cpu, switches: () => c.sw, uptime: () => 100_000, load: () => ({ avg: 50, cores: 8 }), ownLoad: () => { throw new Error("boom"); }, setTimer: (fn) => { c.fn = fn; return 1; }, clearTimer: () => { c.fn = undefined; } });
    const from = c.now;
    watch.arm(12_000);
    c.now += STALL_TICK_MS + 4_000; c.cpu += 10; c.sw += 5_000; c.fn?.();
    expect(watch.credit(from)).toBe(0);
  });

  test("the reader of the product's own load: cores' worth from cumulative CPU seconds over the interval between readings", () => {
    const t = { now: 1_000_000, procs: [{ pid: 1, cpuSeconds: 10 }, { pid: 2, cpuSeconds: 100 }] as { pid: number; cpuSeconds?: number }[] };
    const read = ownLoadReader(() => t.procs, () => t.now);
    expect(read()).toBeUndefined(); // the baseline
    t.now += 1_000;
    t.procs = [{ pid: 1, cpuSeconds: 18 }, { pid: 2, cpuSeconds: 108 }]; // 16 cores' worth over 1 s
    expect(read()).toBeCloseTo(16, 5);
    t.now += 50; // within the minimum interval: the same reading, nothing re-sampled
    expect(read()).toBeCloseTo(16, 5);
    t.now += 1_000;
    t.procs = [{ pid: 1, cpuSeconds: 19 }, { pid: 3, cpuSeconds: 4 }]; // pid 3 is new: all it has used counts; pid 2 is gone
    expect(read()).toBeCloseTo(5 / 1.05, 5); // (1 + 4) cpu seconds over the 1.05 s since the last reading
  });

  test("the reader: a metrics call that throws, or that has no CPU seconds, is no reading", () => {
    let mode: "throw" | "none" | "ok" = "ok";
    const t = { now: 1_000_000, n: 0 };
    const read = ownLoadReader(() => { if (mode === "throw") throw new Error("x"); return [{ pid: 1, ...(mode === "ok" ? { cpuSeconds: (t.n += 1) } : {}) }]; }, () => t.now);
    read();
    t.now += 1_000;
    expect(read()).toBeCloseTo(1, 5);
    mode = "throw";
    t.now += 1_000;
    expect(read()).toBeUndefined();
    mode = "none";
    t.now += 1_000;
    expect(read()).toBeUndefined();
  });

  test("end to end: the watch with the reader on fake process metrics, own renderers burning 16 cores' worth over the lag: no credit; burning nothing: credit", () => {
    for (const [burn, credited] of [[16, false], [0.2, true]] as const) {
      const c = { now: 1_000_000, cpu: 0, sw: 0, secs: 0, fn: undefined as (() => void) | undefined };
      const read = ownLoadReader(() => [{ pid: 7, cpuSeconds: c.secs }], () => c.now);
      const watch = new StallWatch({ now: () => c.now, cpu: () => c.cpu, switches: () => c.sw, uptime: () => 100_000, load: () => ({ avg: 20, cores: 12 }), ownLoad: read, setTimer: (fn) => { c.fn = fn; return 1; }, clearTimer: () => { c.fn = undefined; } });
      const step = (ms: number, tick = true): void => { c.now += ms; c.secs += (ms / 1000) * burn; c.sw += ms > 300 ? ms : Math.round(ms / 100); c.cpu += 5; if (tick) c.fn?.(); };
      watch.arm(12_000);
      step(STALL_TICK_MS);
      const from = c.now;
      step(STALL_TICK_MS + 3_000);
      expect([burn, watch.credit(from) > 2_900]).toEqual([burn, credited]);
    }
  });

  test("the bar is a multiple of THIS process's own idle rate, kept from ticks that came on time", () => {
    // A process that is busy-ish when idle (about 1 switch per ms on its on-time ticks): the same 1/ms in a lag is no news.
    const noisy = rig();
    noisy.watch.arm(12_000);
    for (let i = 0; i < 12; i++) noisy.pass(STALL_TICK_MS, 1, true, STALL_TICK_MS);
    const from = noisy.c.now;
    noisy.watch.arm(12_000);
    noisy.pass(STALL_TICK_MS + 3_000, 20, true, 3_250);
    expect(noisy.watch.credit(from)).toBe(0);
    // The same lag at more than the multiple of that rate counts.
    const roused = rig();
    roused.watch.arm(12_000);
    for (let i = 0; i < 12; i++) roused.pass(STALL_TICK_MS, 1, true, STALL_TICK_MS);
    const f2 = roused.c.now;
    roused.watch.arm(12_000);
    roused.pass(STALL_TICK_MS + 3_000, 20, true, 3_250 * (STALL_SWITCH_MULTIPLE + 2));
    expect(roused.watch.credit(f2)).toBeGreaterThan(2_900);
  });

  test("the first guess of the idle rate is the process's lifetime average: a process that always preempted itself that much gets nothing at the same rate", () => {
    const { c, watch, pass } = rig({ uptime: 10_000 });
    c.sw = 10_000; // one per ms since it started
    watch.arm(12_000);
    const from = c.now;
    pass(STALL_TICK_MS + 3_000, 20, true, 3_250);
    expect(watch.credit(from)).toBe(0);
  });

  test("no idea of the idle rate yet (no uptime, no switch reading at arm), no credit", () => {
    const { c, watch, pass } = rig({ uptime: 0 });
    const from = c.now;
    watch.arm(12_000);
    pass(STALL_TICK_MS + 3_000, 20, false);
    expect(watch.credit(from)).toBe(0);
  });

  test("where the platform keeps no context-switch count (Windows) or the reading is missing, nothing is credited", () => {
    const c = { now: 1_000_000, cpu: 0, fn: undefined as (() => void) | undefined };
    const watch = new StallWatch({ now: () => c.now, cpu: () => c.cpu, switches: () => undefined, load: () => ({ avg: 50, cores: 8 }), setTimer: (fn) => { c.fn = fn; return 1; }, clearTimer: () => { c.fn = undefined; } });
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
