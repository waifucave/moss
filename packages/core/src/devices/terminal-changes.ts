// A device paired or removed from a terminal while none of the person's apps or phones was connected (lane XC, the
// controller's ruling on `moss device`): a command the person approved to run outside the sandbox can start a process the
// OS owns (launchd's, systemd's), which counts as the person at a terminal; pairing a device is the one thing that is not
// left silent. Each such change is written to the engine's log as one plain line, kept in `<home>/devices/terminal-changes.json`,
// and shown, as the engine's own card, when one of the person's apps or phones next connects, until the person answers it:
// a paired device's card offers to remove it. While an app or phone is connected, a terminal's pairing and removal raise
// their card at once instead (devices/rpc.ts), and need it answered.
//
// The limit, plainly: this catches a process that pairs a device and then leaves things alone. Code running as the person
// outside the sandbox can also delete this file (or the log line), and then no card comes. The durable truth is the device
// list itself (Settings' Paired devices, `moss device list`), which shows every paired device whatever this file says.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface TerminalChange {
  kind: "paired" | "removed";
  /** The device's id and the name it had (shown as a value of its own, never inside the engine's sentence). */
  device: string;
  name: string;
  at: number;
}

/** The engine's fixed words for one change: never the device's own text (its name goes in a row of its own). */
export function terminalChangeWords(c: Pick<TerminalChange, "kind" | "at">): string {
  const when = new Date(c.at).toISOString().slice(0, 10);
  return c.kind === "paired" ? `A device was paired from a terminal on ${when}` : `A device was removed from a terminal on ${when}`;
}

/** The changes waiting to be shown, kept on disk so a restart doesn't drop one. At most `MAX` (the oldest go first). */
export class TerminalChanges {
  static readonly MAX = 64;
  readonly #file: string;
  #pending: TerminalChange[];

  constructor(home: string) {
    this.#file = join(home, "devices", "terminal-changes.json");
    this.#pending = TerminalChanges.#read(this.#file);
  }

  static #read(file: string): TerminalChange[] {
    try {
      if (!existsSync(file)) return [];
      const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw.filter((c): c is TerminalChange => typeof c === "object" && c !== null
        && ((c as TerminalChange).kind === "paired" || (c as TerminalChange).kind === "removed")
        && typeof (c as TerminalChange).device === "string" && typeof (c as TerminalChange).name === "string" && typeof (c as TerminalChange).at === "number");
    } catch {
      return [];
    }
  }

  #save(): void {
    mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.#pending), { mode: 0o600 });
    renameSync(tmp, this.#file);
  }

  add(c: TerminalChange): void {
    this.#pending.push(c);
    while (this.#pending.length > TerminalChanges.MAX) this.#pending.shift();
    this.#save();
  }

  pending(): readonly TerminalChange[] {
    return this.#pending;
  }

  /** The person answered its card: it is gone from the file. */
  remove(c: TerminalChange): void {
    const before = this.#pending.length;
    this.#pending = this.#pending.filter((x) => x !== c);
    if (this.#pending.length !== before) this.#save();
  }
}
