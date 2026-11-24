// The canvas's setting writes, coalesced. A plugin's pages share one budget of settings writes a minute with every page
// of their top-level plugin (`LAYER_SETTING_WRITES_PER_MINUTE`, 30, the core's plugin-host/ui.ts): for the canvas, with
// MOSS's Settings. So the canvas writes a setting at most once per `gapMs` (the newest value; what it holds in memory
// changes at once), writes what is waiting when told to (`flush`: the window hidden, the canvas closed), and when a write
// is refused (the budget spent, say) keeps the value and tries once more later instead of dropping it. Pure but for the
// timers it is given.

export interface Timers {
  now(): number;
  /** Runs `fn` after `ms`; the returned function cancels it. */
  after(ms: number, fn: () => void): () => void;
}

export const REAL_TIMERS: Timers = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

/** How long a refused write waits before its one more try: past most of the budget's minute. */
export const RETRY_MS = 20_000;

export interface CoalescedSetting<T> {
  /** The newest value: written now if the last write is `gapMs` old, else when it is. */
  put(value: T): void;
  /** What is waiting, written now (the gap aside): on hide and on close. */
  flush(): void;
  /** Whether a value waits to be written. */
  waiting(): boolean;
}

export function coalesced<T>(write: (value: T) => Promise<unknown>, gapMs: number, timers: Timers = REAL_TIMERS): CoalescedSetting<T> {
  let pending: { value: T } | undefined;
  let last = Number.NEGATIVE_INFINITY;
  let cancel: (() => void) | undefined;
  let inFlight = false;
  let retried = false;
  const arm = (ms: number) => {
    cancel?.();
    cancel = timers.after(Math.max(0, ms), fire);
  };
  function fire(): void {
    cancel = undefined;
    if (pending === undefined || inFlight) return;
    const { value } = pending;
    pending = undefined;
    inFlight = true;
    last = timers.now();
    void Promise.resolve()
      .then(() => write(value))
      .then(
        () => { retried = false; },
        () => {
          // Refused: kept (unless a newer value came meanwhile), and tried once more later. Refused again, it waits for
          // the next value or the next flush.
          if (pending === undefined) pending = { value };
          if (!retried) {
            retried = true;
            arm(RETRY_MS);
          }
        },
      )
      .finally(() => {
        inFlight = false;
        if (pending !== undefined && cancel === undefined && !retried) arm(last + gapMs - timers.now());
      });
  }
  return {
    put(value) {
      pending = { value };
      if (cancel !== undefined || inFlight) return;
      const wait = last + gapMs - timers.now();
      if (wait <= 0) fire();
      else arm(wait);
    },
    flush() {
      if (pending === undefined || inFlight) return;
      cancel?.();
      cancel = undefined;
      fire();
    },
    waiting: () => pending !== undefined,
  };
}
