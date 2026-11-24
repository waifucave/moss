// How many bots one paired phone may make in a day (`bot.create` from a phone, the owner's follow-up of 2026-11-24 to PH3).
// The desktop's own create has no cap; a phone's has, so a lost or hijacked phone that is still paired can fill the list with at
// most `PHONE_BOT_CREATES_PER_DAY` bots in any 24 hours before the owner revokes it. The count is kept in a small file in the
// core's own folder (`transcripts/` is fenced from every agent), read and written whole each call so every connection agrees and
// a restart doesn't forget it, the way the file quota is. A window of the last 24 hours (not a calendar day) so the cap can't be
// doubled by straddling midnight. Owner: lane PH.
import { join } from "node:path";
import { PHONE_BOT_CREATES_PER_DAY } from "@waifucave/moss-protocol";
import { ContractError } from "../contracts/common";
import { readJson, writeJsonAtomic } from "../sessions/atomic-file";
import { transcriptsDir } from "../sessions/ids";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PhoneBotCapOptions {
  /** MOSS's home. */
  home: string;
  now: () => number;
  /** The cap (the protocol's, unless a test sets another). */
  perDay?: number;
}

export class PhoneBotCap {
  readonly #file: string;
  readonly #o: PhoneBotCapOptions;

  constructor(o: PhoneBotCapOptions) {
    this.#o = o;
    this.#file = join(transcriptsDir(o.home), ".phone-bot-creates.json");
  }

  get perDay(): number {
    return this.#o.perDay ?? PHONE_BOT_CREATES_PER_DAY;
  }

  /** Each device's make times inside the window, the rest dropped. A missing or damaged file counts as empty. */
  #read(): Record<string, number[]> {
    const raw = readJson(this.#file) as { devices?: unknown } | undefined;
    const out: Record<string, number[]> = {};
    if (raw === null || typeof raw !== "object" || raw.devices === null || typeof raw.devices !== "object") return out;
    const since = this.#o.now() - DAY_MS;
    for (const [device, times] of Object.entries(raw.devices as Record<string, unknown>)) {
      if (!Array.isArray(times)) continue;
      const kept = times.filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t > since);
      if (kept.length > 0) out[device] = kept;
    }
    return out;
  }

  /** Takes one of the device's makes for the day, or refuses when it has used them all. Taken before the bot is made, so two calls
   *  at once can't both pass the last one; `give` returns it when the make fails. */
  take(device: string): number {
    const all = this.#read();
    const times = all[device] ?? [];
    if (times.length >= this.perDay) {
      const frees = Math.max(1, Math.ceil((Math.min(...times) + DAY_MS - this.#o.now()) / 60_000));
      throw new ContractError("refused", `this phone has made ${this.perDay} bots in the last 24 hours, which is as many as a phone may; make more on the desktop, or try again in ${frees <= 90 ? `${frees} min` : `${Math.ceil(frees / 60)} h`}`);
    }
    const at = this.#o.now();
    all[device] = [...times, at];
    writeJsonAtomic(this.#file, { devices: all }, { mode: 0o600 });
    return at;
  }

  /** Returns a make that came to nothing (the name was refused, the model wasn't on offer). */
  give(device: string, at: number): void {
    const all = this.#read();
    const times = all[device];
    if (times === undefined) return;
    const i = times.indexOf(at);
    if (i >= 0) times.splice(i, 1);
    if (times.length === 0) delete all[device];
    writeJsonAtomic(this.#file, { devices: all }, { mode: 0o600 });
  }
}
