// How long the main process itself was not running between two moments (shared by MOSS and MOSS Code; Node only).
//
// The press checks of both apps time a person's press by when the main process HANDLED it (the mouse down, the page's
// report, the write's arrival), so a machine that left the main process unscheduled for seconds made a genuine press look
// old, and the write was refused. This watch measures that unscheduled time, so a press check can count a press's age
// without it, and nothing else.
//
// What it measures: a timer every STALL_TICK_MS while "armed" (a press was just seen; it stops by itself after the press's
// own window). A tick that comes later than it was due is a lag. A lag is credited only when ALL of these hold:
//   1. the process used little CPU in it (at most half the lag; the credit is the lag less that CPU): a process busy with its
//      own work waited for nothing;
//   2. its involuntary context switches over the interval (`process.resourceUsage().involuntaryContextSwitches`: the OS took
//      the CPU from it or kept it off) are at least STALL_SWITCH_MULTIPLE times what THIS process makes when idle. The idle
//      rate is measured, not assumed: it starts as the process's lifetime average (startup bursts included, so it starts high)
//      and follows the ticks that came on time (an exponential average), floored at one switch a tick;
//   3. the machine is overloaded: the 1-minute load average is at least the number of cores
//      (`os.loadavg()[0] >= os.availableParallelism()`).
// No reading, no credit: Windows has no context-switch counts (libuv leaves them 0) and a load average of zeros, and wherever a
// reading throws or the idle rate is not known yet, there is no credit and the bounds are exactly the plain ones.
//
// WHAT THIS DOES NOT PROVE. An idle node process is not silent: measured by the reviewer at 2 to 3 involuntary switches a
// 250 ms tick idle (2 over a 3 s idle sleep), 591 over 500 ms of busy CPU. So a bare "two or more switches" cannot tell a
// sleeping process from a starved one, which is why the test is a multiple of the idle rate and why the load test is there.
// The multiple (10) sits between the two measured rates (about 0.01 per ms idle, about 1.2 per ms busy: a factor of about 100)
// with room for the idle rate to vary threefold either way. It is a threshold, not a proof. What stays UNPROVEN: whether App
// Nap (or timer coalescing) defers main's timers at all on an otherwise idle Mac, and whether the three tests together always
// refuse a deferred timer: a deferred timer on a machine that is at the same time overloaded, with switches far above idle from
// some other thread of the process and little CPU used, would still be credited. That earns at most the cap, and only for a
// press that was seen and has not been answered (the callers' own checks still apply).
//
// One check can run before the late tick does (the queued handler comes first), so the gap still open at the question
// counts as well: `credit` looks at now less the last tick less the tick's period.
//
// The credit a caller may use is its own to cap (`STALL_CREDIT_MAX_MS` is the number both apps use).

import * as os from "node:os";

export const STALL_TICK_MS = 250;
/** A lag under this is the timer's ordinary jitter, not a stall. */
export const STALL_MIN_MS = 100;
/** The most stall one press may be credited, however long the process waited: a press is never held longer than its own
 *  bound plus this. 8 s: the longest freeze on record is the engine's ping reply 7.6 s late (not a measured stall of this
 *  process, so it is a ceiling for how long a process can be kept off the CPU, not a measurement), and nothing argues for more. */
export const STALL_CREDIT_MAX_MS = 8_000;
/** How many times its own idle rate the involuntary switches must rise to count as "kept off the CPU". */
export const STALL_SWITCH_MULTIPLE = 10;
/** The idle switch rate never taken as lower than this (per ms): one switch a tick. */
export const STALL_IDLE_RATE_FLOOR = 1 / STALL_TICK_MS;
/** The share of a lag the process may have used for CPU and still be taken as kept waiting. */
export const STALL_MAX_CPU_SHARE = 0.5;
/** Weight of the newest on-time tick in the idle rate. */
const IDLE_RATE_WEIGHT = 0.3;
/** How long the credited spans are kept. */
const KEEP_MS = 60_000;

export interface StallWatchDeps {
  now?: () => number;
  /** The CPU time (user and system, in ms) this process has used so far. */
  cpu?: () => number;
  /** The process's involuntary context switches so far, or undefined where the platform has no such reading (then nothing is credited). */
  switches?: () => number | undefined;
  /** The process's age in ms (for the idle rate's first guess). */
  uptime?: () => number;
  /** The machine's load: the 1-minute average and the cores, or undefined where there is no reading (then nothing is credited). */
  load?: () => { avg: number; cores: number } | undefined;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface Span {
  /** The part of the interval in which the timer was overdue: [from, to]. */
  from: number;
  to: number;
  /** How much of it the process was not running. */
  ms: number;
}

const processCpuMs = (): number => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

/** The involuntary context switches of this process (macOS and Linux); undefined on Windows, which keeps none, and when it can't be read. */
export const processSwitches = (platform: NodeJS.Platform = process.platform): number | undefined => {
  if (platform === "win32") return undefined;
  try {
    const n = process.resourceUsage().involuntaryContextSwitches;
    return typeof n === "number" && Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
};

const processUptimeMs = (): number => process.uptime() * 1000;

/** The 1-minute load average and the core count; undefined on Windows (its load average is zeros) and when it can't be read. */
export const machineLoad = (platform: NodeJS.Platform = process.platform): { avg: number; cores: number } | undefined => {
  if (platform === "win32") return undefined;
  try {
    const avg = os.loadavg()[0];
    const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
    return typeof avg === "number" && Number.isFinite(avg) && avg > 0 && cores > 0 ? { avg, cores } : undefined;
  } catch {
    return undefined;
  }
};

/** The unscheduled-time watch: `arm` when a press is seen, `credit` when it is judged. */
export class StallWatch {
  private readonly now: () => number;
  private readonly cpu: () => number;
  private readonly switches: () => number | undefined;
  private readonly uptime: () => number;
  private readonly load: () => { avg: number; cores: number } | undefined;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private timer: unknown;
  private armedUntil = 0;
  private lastTick = 0;
  private lastCpu = 0;
  private lastSwitches: number | undefined;
  /** Involuntary switches per ms of this process when nothing is wrong with the machine; undefined until it is known. */
  private idleRate: number | undefined;
  private spans: Span[] = [];

  constructor(deps: StallWatchDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.cpu = deps.cpu ?? processCpuMs;
    this.switches = deps.switches ?? (() => processSwitches());
    this.uptime = deps.uptime ?? processUptimeMs;
    this.load = deps.load ?? (() => machineLoad());
    this.setTimer = deps.setTimer ?? ((fn, ms) => { const t = setInterval(fn, ms); (t as { unref?: () => void }).unref?.(); return t; });
    this.clearTimer = deps.clearTimer ?? ((t) => clearInterval(t as ReturnType<typeof setInterval>));
  }

  /** Watches for `forMs` from now (a press was seen: its window and the credit's cap). Adds to what is armed, never cuts it. */
  arm(forMs: number): void {
    const now = this.now();
    this.armedUntil = Math.max(this.armedUntil, now + forMs);
    if (this.timer === undefined) {
      this.lastTick = now;
      this.lastCpu = this.cpu();
      this.lastSwitches = this.switches();
      if (this.idleRate === undefined && this.lastSwitches !== undefined) {
        const up = this.uptime();
        if (up > 0) this.idleRate = this.lastSwitches / up;
      }
      this.timer = this.setTimer(() => this.tick(), STALL_TICK_MS);
    }
  }

  /** Whether the watch's timer is running (idle: no timer, so no wake-ups). */
  get running(): boolean {
    return this.timer !== undefined;
  }

  /** The timer's beat (the tests call it themselves). */
  tick(): void {
    const now = this.now();
    const span = this.gap(now);
    if (span !== undefined) this.spans.push(span);
    const sw = this.switches();
    // A tick that came on time shows what this process does when nothing is wrong: it keeps the idle rate.
    if (now - (this.lastTick + STALL_TICK_MS) < STALL_MIN_MS && sw !== undefined && this.lastSwitches !== undefined && now > this.lastTick) {
      const rate = Math.max(0, sw - this.lastSwitches) / (now - this.lastTick);
      this.idleRate = this.idleRate === undefined ? rate : this.idleRate * (1 - IDLE_RATE_WEIGHT) + rate * IDLE_RATE_WEIGHT;
    }
    this.lastTick = now;
    this.lastCpu = this.cpu();
    this.lastSwitches = sw;
    this.spans = this.spans.filter((s) => now - s.to <= KEEP_MS);
    if (now >= this.armedUntil && this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  /** The stall in the gap since the last tick, as of `at`: undefined when the timer was not overdue by a real lag. */
  private gap(at: number): Span | undefined {
    if (this.timer === undefined) return undefined;
    const due = this.lastTick + STALL_TICK_MS;
    const lag = at - due;
    if (lag < STALL_MIN_MS) return undefined;
    // No reading, no credit (switches, idle rate, load).
    const was = this.lastSwitches;
    const now = this.switches();
    const load = this.load();
    if (was === undefined || now === undefined || this.idleRate === undefined || load === undefined) return undefined;
    // Not overloaded: a late timer on a machine with room is the OS deferring it (or the process's own doing), not a stall.
    if (!(load.avg >= load.cores)) return undefined;
    // Switches far above this process's own idle rate over the whole interval since the last tick.
    const elapsed = at - this.lastTick;
    const idle = Math.max(this.idleRate, STALL_IDLE_RATE_FLOOR);
    if (now - was < STALL_SWITCH_MULTIPLE * idle * elapsed) return undefined;
    // Little CPU used in the lag: a busy process waited for nothing.
    const ran = Math.max(0, this.cpu() - this.lastCpu);
    if (ran > lag * STALL_MAX_CPU_SHARE) return undefined;
    const waited = Math.min(lag, Math.max(0, lag - ran));
    return waited < STALL_MIN_MS ? undefined : { from: due, to: at, ms: waited };
  }

  /** How many ms of [from, to] (default: to now) the main process was not running, as far as the watch saw: the spans
   *  recorded, in proportion to how much of each lies in the interval, and the gap still open at `to`. 0 when it never
   *  watched. Not capped here. */
  credit(from: number, to: number = this.now()): number {
    if (to <= from) return 0;
    const open = this.gap(this.now());
    let total = 0;
    for (const s of open === undefined ? this.spans : [...this.spans, open]) {
      const overlap = Math.min(s.to, to) - Math.max(s.from, from);
      if (overlap > 0 && s.to > s.from) total += s.ms * (overlap / (s.to - s.from));
    }
    return Math.round(total);
  }
}
