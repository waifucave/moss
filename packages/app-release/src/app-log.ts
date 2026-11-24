// The app's own log, shared by MOSS and MOSS Code: the main process's lines (the pair, the layers' refusals and part
// crashes, the sealed path, a refused send or press) also go to a file under `<home>/logs/`, so a packaged app that
// shows a dead button leaves a trace beside the daemon's `daemon.log`. MOSS Code writes `app.log`; MOSS writes
// `moss-app.log`, so the two programs' lines never interleave. Size-capped (it keeps the last file and the one before it),
// appended a line at a time, owner-only, and holding only what the app wrote about itself: no key, and no message content
// (the lines name methods and reasons, never a call's params).
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, renameSync, statSync, writeSync } from "node:fs";
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
 *  stands alone there), and never waiting on a pipe a writer-less open would block on (`O_NONBLOCK`: opening a pipe planted as the
 *  log for writing with no reader fails at once instead of stopping the main process). */
const APPEND_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** Makes an existing log file owner-only through a descriptor opened WITHOUT following a link (and without blocking on a pipe): the
 *  mode changes on what was opened, never on whatever a path names a moment later. A file that is not a plain file, or that has
 *  another hard link (one planted to somebody's file), is left as it is. Where the OS has no `O_NOFOLLOW` (Windows) the `lstat` in
 *  `write` stands alone and there are no modes to set. */
function ownerOnly(path: string): void {
  if (process.platform === "win32") return;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (st.isFile() && st.nlink === 1) fchmodSync(fd, 0o600);
  } catch { /* not there yet, or not ours to change */ } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* gone */ } }
  }
}

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
        ownerOnly(this.file);
        ownerOnly(`${this.file}.1`);
      }
      if (this.size + text.length > this.max) {
        renameSync(this.file, `${this.file}.1`);
        ownerOnly(`${this.file}.1`);
        this.size = 0;
      }
      const fd = openSync(this.file, APPEND_FLAGS, 0o600);
      try {
        // Only a plain file with exactly one link is written: a pipe, a device or a hard link planted as the log (to somebody's file,
        // which an append would grow) is looked at through the descriptor itself, so nothing is swapped in between the look and the write.
        const st = fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1) return;
        writeSync(fd, text);
      } finally { closeSync(fd); }
      this.size += text.length;
    } catch { /* the log is best effort */ }
  }
}

/** A limit on how many lines one thing may write: a looping frame or caller, keyed by its own name, writes at most `max` in `windowMs`,
 *  and the first line after the quiet says how many were left out. Keeps at most `keys` names.
 *
 *  A key's own limit does not bound what many keys write together: a plugin that makes a frame after frame is a new key each time. So a
 *  line may also name its `group` (the window its frame is in): all the keys of one group together write at most `groupMax` lines in
 *  `groupWindowMs` (30 in a minute), whatever their names, and the lines left out are counted into the first line said after the quiet.
 *  At most `groups` groups are kept.
 *
 *  A group at its cap would let one looping frame bury every other frame's line, and the line of the frame whose button is dead is
 *  the one a person needs. So a key that has written no line yet in the group's minute always gets its FIRST line through (a reserve of
 *  `reserve` such lines per group per minute, on top of `groupMax`); a frame that is already writing gets none. The most one group writes
 *  in a minute is `groupMax + reserve`. A plugin that makes a new frame for every line spends the reserve (a new key each time) and then
 *  buries a frame that has not spoken yet: the reserve is a bound on that, not a proof against it. */
export class LineLimiter {
  private readonly seen = new Map<string, { start: number; count: number; left: number }>();
  private readonly byGroup = new Map<string, { start: number; count: number; left: number; spoke: Set<string>; reserved: number }>();

  constructor(
    private readonly max = 5,
    private readonly windowMs = 10_000,
    private readonly keys = 256,
    private readonly now: () => number = Date.now,
    private readonly groupMax = 30,
    private readonly groupWindowMs = 60_000,
    private readonly groups = 64,
    private readonly reserve = 10,
  ) {}

  /** `ok`: write this line; `left`: how many of this key's (and this group's) lines were left out since the last one written. */
  check(key: string, group?: string): { ok: boolean; left: number } {
    const t = this.now();
    let g: { start: number; count: number; left: number; spoke: Set<string>; reserved: number } | undefined;
    if (group !== undefined) {
      g = this.byGroup.get(group);
      if (g === undefined || t - g.start >= this.groupWindowMs) {
        // A new minute: what the last one left out and never said stays counted until a line is written.
        g = { start: t, count: 0, left: g?.left ?? 0, spoke: new Set(), reserved: 0 };
        this.byGroup.delete(group);
        this.byGroup.set(group, g);
        if (this.byGroup.size > this.groups) this.byGroup.delete(this.byGroup.keys().next().value as string);
      }
      // At the cap only a key's first line of the minute passes, from the reserve.
      if (g.count >= this.groupMax && (g.spoke.has(key) || g.reserved >= this.reserve)) { g.left++; return { ok: false, left: 0 }; }
    }
    const r = this.#keyed(key, t);
    if (!r.ok) return r;
    if (g === undefined) return r;
    if (g.count >= this.groupMax) g.reserved++;
    g.spoke.add(key);
    g.count++;
    const left = r.left + g.left;
    g.left = 0;
    return { ok: true, left };
  }

  #keyed(key: string, t: number): { ok: boolean; left: number } {
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
