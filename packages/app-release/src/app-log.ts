// The app's own log, shared by MOSS and MOSS Code: the main process's lines (the pair, the layers' refusals and part
// crashes, the sealed path, a refused send or press) also go to a file under `<home>/logs/`, so a packaged app that
// shows a dead button leaves a trace beside the daemon's `daemon.log`. MOSS Code writes `app.log`; MOSS writes
// `moss-app.log`, so the two programs' lines never interleave. Size-capped (it keeps the last file and the one before it),
// appended a line at a time, owner-only, and holding only what the app wrote about itself: no key, and no message content
// (the lines name methods and reasons, never a call's params).
import { appendFileSync, chmodSync, constants, lstatSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export const APP_LOG_MAX_BYTES = 1_000_000;
export const APP_LOG_LINE_MAX = 300;

/** A line as it may reach the disk: a URL keeps no query or fragment, and a long run of token-like characters is a
 *  secret until shown otherwise, so it is blanked. */
export function cleanLogLine(line: string): string {
  return line
    .replace(/[\r\n]+/g, " ")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?#"')]*)[?#][^\s"')]*/gi, "$1")
    .replace(/[A-Za-z0-9_\-+/=]{24,}/g, "[x]")
    .slice(0, APP_LOG_LINE_MAX);
}

/** MOSS Code's log file name; MOSS's is `MOSS_APP_LOG_FILE`. */
export const APP_LOG_FILE = "app.log";
export const MOSS_APP_LOG_FILE = "moss-app.log";

export const appLogPath = (home: string, file: string = APP_LOG_FILE): string => join(home, "logs", file);

/** Whether `path` is a symbolic link (nothing is written through one: a link planted where the log goes could point at any file the
 *  owner can write). */
function isLink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

/** The flags every append uses: never through a link where the OS can say so (`O_NOFOLLOW`; Windows has none, and the `lstat` above
 *  stands alone there). */
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0);

export class AppLog {
  private size: number | undefined;

  constructor(private readonly file: string, private readonly max = APP_LOG_MAX_BYTES) {}

  /** Appends a line; never throws (a log that can't be written is no reason to stop the app). A log or its older file that is a
   *  symbolic link is not written through (nor chmod-ed, nor renamed over): the line is dropped. */
  write(line: string, now: Date = new Date()): void {
    try {
      const text = `${now.toISOString()} ${cleanLogLine(line)}\n`;
      if (isLink(this.file) || isLink(`${this.file}.1`)) return;
      if (this.size === undefined) {
        mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
        try { this.size = statSync(this.file).size; } catch { this.size = 0; }
        // A log that already exists, and the one before it, are the owner's alone.
        for (const f of [this.file, `${this.file}.1`]) { try { chmodSync(f, 0o600); } catch { /* not there yet */ } }
      }
      if (this.size + text.length > this.max) {
        renameSync(this.file, `${this.file}.1`);
        try { chmodSync(`${this.file}.1`, 0o600); } catch { /* best effort */ }
        this.size = 0;
      }
      appendFileSync(this.file, text, { mode: 0o600, flag: APPEND_FLAGS });
      this.size += text.length;
    } catch { /* the log is best effort */ }
  }
}

/** A limit on how many lines one thing may write: a looping frame or caller, keyed by its own name, writes at most `max` in `windowMs`,
 *  and the first line after the quiet says how many were left out. Keeps at most `keys` names. */
export class LineLimiter {
  private readonly seen = new Map<string, { start: number; count: number; left: number }>();

  constructor(private readonly max = 5, private readonly windowMs = 10_000, private readonly keys = 256, private readonly now: () => number = Date.now) {}

  /** `ok`: write this line; `left`: how many of this key's lines were left out since the last one written. */
  check(key: string): { ok: boolean; left: number } {
    const t = this.now();
    let e = this.seen.get(key);
    if (e === undefined || t - e.start >= this.windowMs) {
      const left = e?.left ?? 0;
      e = { start: t, count: 0, left: 0 };
      this.seen.delete(key);
      this.seen.set(key, e);
      if (this.seen.size > this.keys) this.seen.delete(this.seen.keys().next().value as string);
      e.count = 1;
      return { ok: true, left };
    }
    if (e.count >= this.max) { e.left++; return { ok: false, left: 0 }; }
    e.count++;
    return { ok: true, left: 0 };
  }
}
