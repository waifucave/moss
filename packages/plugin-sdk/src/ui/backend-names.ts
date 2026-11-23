// The one read of `agent.backends`' display names that `useBackendNames` makes. A part asks on its first lookup; a read that
// fails (the engine's agents aren't up yet, a slow detection timed out) or comes back with no names must not leave the part
// showing a backend's id for good ("codex" for "Codex"), so the next lookup after a short gap asks again. No timer: only a
// lookup (a render) starts a read, so a part that never looks makes no call and an idle one makes none.

/** How long a failed or empty read waits before a later lookup asks again. */
export const BACKEND_NAMES_RETRY_MS = 2_000;

interface BackendRow {
  id?: unknown;
  name?: unknown;
}

/** The names a reply holds, by backend id (a name may be a string or a table with an English entry). */
export function namesOf(reply: { backends?: BackendRow[] } | undefined): Map<string, string> {
  const next = new Map<string, string>();
  for (const b of reply?.backends ?? []) {
    const name = typeof b.name === "string" ? b.name : (b.name as { en?: unknown } | undefined)?.en;
    if (typeof b.id === "string" && typeof name === "string" && name !== "") next.set(b.id, name);
  }
  return next;
}

export class BackendNamesReader {
  #state: "idle" | "loading" | "done" = "idle";
  #retryAt = 0;
  #live = true;

  constructor(
    private readonly call: () => Promise<{ backends?: BackendRow[] } | undefined>,
    private readonly now: () => number,
    private readonly onNames: (names: Map<string, string>) => void,
  ) {}

  /** Starts a read when none is running or finished and the retry gap has passed. */
  ask(): void {
    if (!this.#live || this.#state !== "idle" || this.now() < this.#retryAt) return;
    this.#state = "loading";
    this.call().then(
      (reply) => {
        const names = namesOf(reply);
        if (names.size === 0) return this.#again();
        this.#state = "done";
        if (this.#live) this.onNames(names);
      },
      () => this.#again(),
    );
  }

  #again(): void {
    this.#state = "idle";
    this.#retryAt = this.now() + BACKEND_NAMES_RETRY_MS;
  }

  /** The part left: a read that comes back later changes nothing. */
  stop(): void {
    this.#live = false;
  }
}
