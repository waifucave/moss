// How long the main process itself was not running between two moments (shared by MOSS and MOSS Code; Node only).
//
// The press checks of both apps time a person's press by when the main process HANDLED it (the mouse down, the page's
// report, the write's arrival), so a machine that left the main process unscheduled for seconds made a genuine press look
// old, and the write was refused. This watch measures that unscheduled time, so a press check can count a press's age
// without it, and nothing else.
//
// What it measures: a timer every STALL_TICK_MS while "armed" (a press was just seen; it stops by itself after the press's
// own window). A tick that comes later than it was due is a lag. A lag is credited only when the OS had the process
// RUNNABLE and did not schedule it, which shows as three things together:
//   1. the lag, less the CPU time the process used in it (a process busy with its own work waited for nothing);
//   2. a rise of the process's involuntary context switches (`process.resourceUsage().involuntaryContextSwitches`: the OS took
//      the CPU from it or kept it off, which a process asleep by its own choice never has). A timer the OS DEFERS on an idle
//      process (App Nap, timer coalescing, a laptop's low-power timer slack) is late with almost no CPU used and no involuntary
//      switches, so it earns nothing: that is what keeps a person from switching to another app and leaving a click to be
//      spent later;
//   3. the platform reads that counter: macOS (getrusage's ru_nivcsw) and Linux (the same) do; Windows' rusage has no
//      context-switch counts (libuv leaves them 0), so on Windows, and wherever the reading throws, there is NO credit rather
//      than a guess, and the bounds are exactly the plain ones.
// The counter is the whole process's (every thread), so a deferral during which some other thread of the process was preempted
// twice or more could still pass the test; it earns at most the cap, and only when the CPU test (1) also holds.
//
// One check can run before the late tick does (the queued handler comes first), so the gap still open at the question
// counts as well: `credit` looks at now less the last tick less the tick's period.
//
// The credit a caller may use is its own to cap (`STALL_CREDIT_MAX_MS` is the number both apps use).

export const STALL_TICK_MS = 250;
/** A lag under this is the timer's ordinary jitter, not a stall. */
export const STALL_MIN_MS = 100;
/** The most stall one press may be credited, however long the process waited: a press is never held longer than its own
 *  bound plus this. 8 s: the longest freeze on record is the engine's ping reply 7.6 s late (not a measured stall of this
 *  process, so it is a ceiling for how long a process can be kept off the CPU, not a measurement), and nothing argues for more. */
export const STALL_CREDIT_MAX_MS = 8_000;
/** The least rise of involuntary context switches that shows the OS had the process runnable and kept it waiting. */
export const STALL_MIN_SWITCHES = 2;
/** How long the credited spans are kept. */
const KEEP_MS = 60_000;

export interface StallWatchDeps {
  now?: () => number;
  /** The CPU time (user and system, in ms) this process has used so far. */
  cpu?: () => number;
  /** The process's involuntary context switches so far, or undefined where the platform has no such reading (then nothing is credited). */
  switches?: () => number | undefined;
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

/** The unscheduled-time watch: `arm` when a press is seen, `credit` when it is judged. */
export class StallWatch {
  private readonly now: () => number;
  private readonly cpu: () => number;
  private readonly switches: () => number | undefined;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private timer: unknown;
  private armedUntil = 0;
  private lastTick = 0;
  private lastCpu = 0;
  private lastSwitches: number | undefined;
  private spans: Span[] = [];

  constructor(deps: StallWatchDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.cpu = deps.cpu ?? processCpuMs;
    this.switches = deps.switches ?? (() => processSwitches());
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
    this.lastTick = now;
    this.lastCpu = this.cpu();
    this.lastSwitches = this.switches();
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
    // Asleep by its own choice or deferred by the OS's timer rules: no involuntary switches, no credit; no reading, no credit.
    const was = this.lastSwitches;
    const now = this.switches();
    if (was === undefined || now === undefined || now - was < STALL_MIN_SWITCHES) return undefined;
    const ran = Math.max(0, this.cpu() - this.lastCpu);
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
