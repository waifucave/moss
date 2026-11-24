// Revoked phones and browsers stop getting pushes (spec §8.1: "Revoking a device cuts its links at once").
//
// The core's `phones` for an update already leaves revoked phones out, but a push that names no phone (a plugin's notice,
// the badge going back to zero, an update whose only phone was revoked) wakes every target the push service holds, and the
// service keeps a revoked phone's target until it is told. So before each push this computer compares the user's devices
// now with the ones it saw before: a phone or a browser that is gone from the list was revoked (the registry lists only
// unrevoked devices), and the service is told with `DELETE /v1/devices/<id>`, which drops its target and refuses it again.
//
// * Only a list that names this computer (`isThis`) is trusted: a list read before the registry is up never revokes.
// * Only devices this computer saw itself, phones and browsers (no computer has a push target): another computer's
//   phones are never revoked from here. What it saw is kept per computer in the plugin's synced store.
// * A revocation the service didn't take (no account yet, the service away) is kept and tried again before the next push.
// * At most `MAX_KNOWN` devices are remembered: an account has a few phones and browsers, never hundreds.

export interface DeviceEntry {
  id: string;
  runsCore: boolean;
  isThis: boolean;
}

export interface SweepStore {
  get(): Promise<unknown>;
  set(value: { known: string[]; pending: string[] }): Promise<void>;
}

export interface RevocationSweepOptions {
  /** The user's unrevoked devices, as `devices.list` gives them. */
  list(): Promise<readonly DeviceEntry[]>;
  store: SweepStore;
  /** Tells the push service; true once it took the revocation. */
  revoke(id: string): Promise<boolean>;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}

const MAX_KNOWN = 64;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && DEVICE_ID_RE.test(v)).slice(0, MAX_KNOWN);
}

export class RevocationSweep {
  private known: Set<string> | null = null;
  private pending = new Set<string>();
  private running: Promise<void> | null = null;
  private again = false;

  constructor(private readonly options: RevocationSweepOptions) {}

  /** Compares the list with what was seen, and tells the service of each phone or browser gone from it. One at a time: a
   *  sweep asked for while one runs runs again after it, so a change that came during it is never missed. */
  sweep(): Promise<void> {
    if (this.running !== null) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.run();
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(): Promise<void> {
    if (this.known === null) {
      const saved = (await this.options.store.get().catch(() => undefined)) as { known?: unknown; pending?: unknown } | undefined;
      this.known = new Set(ids(saved?.known));
      for (const id of ids(saved?.pending)) this.pending.add(id);
    }
    let devices: readonly DeviceEntry[];
    try {
      devices = await this.options.list();
    } catch {
      // No list, no revocation: what was pending stays pending.
      devices = [];
    }
    const trusted = devices.some((d) => d.isThis);
    if (trusted) {
      const now = new Set(devices.filter((d) => !d.runsCore && !d.isThis && DEVICE_ID_RE.test(d.id)).map((d) => d.id));
      for (const id of this.known) if (!now.has(id)) this.pending.add(id);
      // A device listed again (paired anew under the same id can't happen: a revoked id stays refused) is not revoked.
      for (const id of now) this.pending.delete(id);
      this.known = new Set([...now].slice(0, MAX_KNOWN));
    }
    for (const id of [...this.pending]) {
      let taken = false;
      try {
        taken = await this.options.revoke(id);
      } catch {
        taken = false;
      }
      if (taken) this.pending.delete(id);
    }
    if (this.pending.size > 0) this.options.log?.("info", `${this.pending.size} revoked device(s) not yet removed from push; tried again before the next push`);
    await this.options.store.set({ known: [...this.known], pending: [...this.pending].slice(0, MAX_KNOWN) }).catch(() => {});
  }
}
