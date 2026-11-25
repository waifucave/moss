import { APP_LOG_LINE_MAX } from "../app-log";
/** The longest the counts part of the line may be before the processes and the calls: the rest of the line is theirs. */
const HEAD_MAX = 200;
// What crosses between the main process and the windows, counted by channel, and what each process costs, said in the app's
// own log every few seconds, when asked for (`MOSS_IPC_STATS=1`, or an `ipc-stats` file in the home; off by default, any build): the
// acceptance run reads it to hold an idle app to a budget, and a person chasing a hot idle app reads it to see which channel never stops. Counts only: no
// payload, no plugin id, no text ever goes in the line.

/** The core event types worth naming in the counters; any other is counted as `other`. */
export const NAMED_EVENTS: ReadonlySet<string> = new Set(["plugin_point_changed", "plugin_settings_changed", "plugin_store_changed", "plugin_ui_message", "plugin_ui_changed", "plugin_changed", "methods_changed", "activity_changed", "plugin_api_event"]);
/** The app's own API methods a page may name (`moss:api`); any other is counted as `other`. */
export const NAMED_METHODS: ReadonlySet<string> = new Set(["plugin.layer.call", "plugin.layer.watch", "plugin.layer.unwatch", "events.subscribe", "bot.get", "bot.list", "card.pending", "computer.get", "computer.list", "device.list", "session.answer", "session.attach", "session.detach", "session.get", "session.list"]);


/** The counts of one window of time: messages the windows sent main (`in`, by IPC channel) and main sent them (`out`, by message type). */
export interface IpcWindow {
  seconds: number;
  in: ReadonlyMap<string, number>;
  out: ReadonlyMap<string, number>;
  /** What the `api` calls and `api-event`s were (method names and event types only), so a part in a loop says which call it is looping on. */
  detail?: ReadonlyMap<string, number>;
}

export class IpcStats {
  private inCounts = new Map<string, number>();
  private outCounts = new Map<string, number>();
  private detailCounts = new Map<string, number>();

  /** A window sent main one message on `channel`. */
  received(channel: string): void {
    this.inCounts.set(channel, (this.inCounts.get(channel) ?? 0) + 1);
  }

  /** Main sent a window one message of `type`. */
  sent(type: string): void {
    this.outCounts.set(type, (this.outCounts.get(type) ?? 0) + 1);
  }

  /** One more of a named kind of call or event. Only a name the caller says is the app's own fixed string is kept as it
   *  is (`known`: the SDK's catalog of calls a component may make, a short list of core event types); any other name,
   *  which a plugin could have chosen, is counted as `other`, so no plugin-chosen text reaches the counters line. */
  detail(name: string, known: boolean): void {
    const k = known && /^[A-Za-z0-9._:-]{1,48}$/.test(name) ? name : "other";
    this.detailCounts.set(k, (this.detailCounts.get(k) ?? 0) + 1);
    if (this.detailCounts.size > 64) this.detailCounts.delete(this.detailCounts.keys().next().value!);
  }

  /** The counts since the last take, and a fresh start. */
  take(seconds: number): IpcWindow {
    const w = { seconds, in: this.inCounts, out: this.outCounts, detail: this.detailCounts };
    this.inCounts = new Map();
    this.outCounts = new Map();
    this.detailCounts = new Map();
    return w;
  }
}

const total = (m: ReadonlyMap<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
const top = (m: ReadonlyMap<string, number>, n = 6): string =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k.replace(/^moss:/, "")} ${v}`).join(", ");

/** One process's share of a core over the last window. */
export interface ProcessCpu { type: string; percent: number }

/** A process as `app.getAppMetrics()` lists it: its CPU seconds since it started (`cpu.cumulativeCPUUsage`). */
export interface ProcessCpuTotal { pid: number; type: string; seconds?: number }

/** Each process's share of a core since the last reading, from its cumulative CPU seconds (`percentCPUUsage` read 0.0
 *  for every renderer in a measured run, so it is not used). A process seen for the first time reads from its start
 *  (`since` is when the meter began); one with no cumulative figure is left out. */
export function cpuMeter(list: () => readonly ProcessCpuTotal[], now: () => number = () => Date.now()): () => ProcessCpu[] {
  let last = new Map<number, number>();
  let at = now();
  return () => {
    const t = now();
    const secs = Math.max(0.001, (t - at) / 1000);
    const next = new Map<number, number>();
    const out: ProcessCpu[] = [];
    for (const p of list()) {
      if (p.seconds === undefined) continue;
      next.set(p.pid, p.seconds);
      const before = last.get(p.pid);
      if (before !== undefined) out.push({ type: p.type, percent: Math.max(0, ((p.seconds - before) / secs) * 100) });
    }
    last = next;
    at = t;
    return out;
  };
}

/** The log line: `ipc: 5 s in 12/s (props 40, size 20) out 3/s (props 15) cpu Browser 4.1% Tab 2.0% Tab 1.2% GPU 0.3%`.
 *  The words "ipc: " and the shape are what the acceptance row parses (`parseIpcLine`); keep the two together. */
export function ipcLine(w: IpcWindow, cpu: readonly ProcessCpu[]): string {
  const rate = (n: number) => (n / w.seconds).toFixed(1);
  const headOf = (n: number) => `ipc: ${w.seconds} s in ${rate(total(w.in))}/s (${top(w.in, n)}) out ${rate(total(w.out))}/s (${top(w.out, n)}) cpu`;
  // The most pairs (6 at most) whose head leaves room for the processes' words.
  let n = 6;
  while (n > 0 && headOf(n).length > HEAD_MAX) n--;
  const head = headOf(n);
  // The file keeps a line to APP_LOG_LINE_MAX characters (the timestamp aside) and a cut line is not a kept shape, so the
  // line is built to fit: processes from the first as many as fit, then the calls' names, most-called first, as many as fit.
  let line = head;
  for (const p of cpu) {
    const next = `${line} ${p.type} ${p.percent.toFixed(1)}%`;
    if (next.length > APP_LOG_LINE_MAX) break;
    line = next;
  }
  const names = [...(w.detail ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${v}`);
  let calls = "";
  for (const n of names) {
    const next = calls === "" ? n : `${calls}, ${n}`;
    if (`${line} calls (${next})`.length > APP_LOG_LINE_MAX) break;
    calls = next;
  }
  return calls === "" ? line : `${line} calls (${calls})`;
}

/** Counts every message and says each window's line (`every` ms) while the app runs; the stop function ends it. */
export function startIpcStats(stats: IpcStats, cpu: () => ProcessCpu[], log: (line: string) => void, every = 5_000, setEvery: (fn: () => void, ms: number) => () => void = (fn, ms) => { const t = setInterval(fn, ms); return () => clearInterval(t); }): () => void {
  // The first reading only starts the CPU meter (it covers the time since the app began).
  cpu();
  stats.take(every / 1000);
  return setEvery(() => log(ipcLine(stats.take(every / 1000), cpu())), every);
}

/** The numbers a line carries. */
export interface ParsedIpcLine { seconds: number; inPerSecond: number; outPerSecond: number; cpu: { type: string; percent: number }[] }

/** Reads a line `ipcLine` made (undefined for any other). */
export function parseIpcLine(line: string): ParsedIpcLine | undefined {
  const m = /ipc: (\d+(?:\.\d+)?) s in ([\d.]+)\/s \(.*?\) out ([\d.]+)\/s \(.*?\) cpu(.*)$/.exec(line);
  if (m === null) return undefined;
  const cpu = [...m[4]!.matchAll(/(\S+) ([\d.]+)%/g)].map((c) => ({ type: c[1]!, percent: Number(c[2]) }));
  return { seconds: Number(m[1]), inPerSecond: Number(m[2]), outPerSecond: Number(m[3]), cpu };
}

/** Whether the counter runs, in any build: off by default; on with `MOSS_IPC_STATS=1` in the app's environment, or with an empty
 *  file named `ipc-stats` in the app's home (for an app started from the Dock, where no variable reaches it); read once at start.
 *  It writes counts and CPU only, never a payload, a plugin id or text, so it is safe to leave on. */
export function ipcStatsOn(input: { env: Readonly<Record<string, string | undefined>>; flagFile: boolean }): boolean {
  return input.env.MOSS_IPC_STATS === "1" || input.flagFile;
}
