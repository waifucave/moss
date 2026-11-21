// The app's reading of the engine's registry and choices on a new connection (`loadRegistry`) can fail once for a reason that
// passes: the engine answered `plugin.ui` later than the app's 10 s (a computer stalled for ten seconds, a runner under I/O
// pressure: builder-examples row 91, run 44915715889: the engine's loop and the run's own timer were both held up 8 to 10 s).
// The failure used to be logged and left it there: the window's mount was never applied and the app stayed connected
// to nothing until it was restarted. It is asked again on a growing wait while the connection is still the app's current one.

export interface SetupRetry {
  /** One reading; rejects when it failed. */
  load(): Promise<void>;
  /** The waits before each further try (the number of retries is its length). */
  waits: readonly number[];
  /** Whether the connection this is for is still the app's. */
  current(): boolean;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
  /** Called once, when the first try failed (the caller stops waiting for it and lets the retries run on). */
  onFirstFailure?(): void;
}

/** Reads until one succeeds: true. False when the connection went or the tries are used up (said in the log). */
export async function loadWithRetry(o: SetupRetry): Promise<boolean> {
  for (let i = 0; ; i++) {
    try {
      await o.load();
      return true;
    } catch (err) {
      const said = err instanceof Error ? err.message : String(err);
      if (i === 0) o.onFirstFailure?.();
      if (!o.current()) return false;
      if (i >= o.waits.length) {
        o.log(`pair: setting up the connection failed: ${said}; given up after ${i + 1} tries`);
        return false;
      }
      o.log(`pair: setting up the connection failed: ${said}; asking again in ${o.waits[i]} ms`);
      await o.sleep(o.waits[i]!);
      if (!o.current()) return false;
    }
  }
}
