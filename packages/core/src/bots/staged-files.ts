// The files a paired phone sends (`session.stageFile`, the owner's decision of 2026-11-24, PH3). A file arrives in chunks over the
// phone's link, is held aside in the core's own folder until it is whole, then is placed in the folder its bot or coding session
// works in (a bot's `scratch/<bot>/attachments/`, where a file dropped on the desktop is copied; a coding session's `<home>-received/<session>/`,
// a folder beside MOSS's home (`~/.moss-received/<session>/`), outside it, where no agent may read, and not in the project), and the phone's next `session.send`
// names it (`files`, by its folder-tree path; the agent is told the real one). Owner: lane PH.
//
// What a phone cannot do through it, by construction:
//   - write anywhere else. The destination is computed here from the session, never from the phone; the phone's name is cleaned to
//     one safe file name and sits in a folder this module makes with a name of its own (`phone-<random>`), under a folder whose real
//     path is checked to be the one expected, with the file created `O_EXCL | O_NOFOLLOW` and judged again by its descriptor before a
//     byte is written. A link planted in the bot's or session's folder leads nowhere.
//   - plant something that runs. A file is written `0600`: no execute bit, whatever it is; what launches by being opened (an app, a
//     command file, an installer, a Windows program) and an executable's own bytes (Mach-O, ELF, PE) are refused. A plain script is
//     data like any other file and has no execute bit.
//   - fill the disk. One file, the files a device holds unsent and what it may send in a day are all bounded, counted on the bytes
//     received, and what no message names is removed.
//   - name a file it did not send. `session.send` takes a phone's `files` only if each is one this device staged for this session.
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import {
  ERR, FILE_REFERENCE_INVALID, STAGE_FILE_CHUNK_BYTES, STAGE_FILE_DAY_MAX_BYTES, STAGE_FILE_DAY_MAX_FILES, STAGE_FILE_UNSENT_MAX, STAGE_FILE_KEEP_MS, STAGE_FILE_MAX_BYTES, STAGE_FILE_OPEN_MAX,
  STAGE_FILE_PARTIAL_TTL_MS, STAGE_FILE_PENDING_MAX_BYTES, STAGE_FILES_PER_MESSAGE_MAX, STAGE_IMAGE_MAX_BYTES,
} from "@waifucave/moss-protocol";
import type { SessionView } from "@waifucave/moss-protocol";
import { IMAGE_SNIFF_BYTES, sniffImageMediaType } from "../agent/stage-image";
import type { Clock, TimerHandle } from "../contracts/clock";
import { ContractError } from "../contracts/common";
import { MethodError } from "../rpc/handler";
import { readJson, writeJsonAtomic } from "../sessions/atomic-file";
import { transcriptsDir } from "../sessions/ids";
import { botPaths, homeTreePath } from "./paths";
import type { BotService } from "./service";

/** What is added to MOSS's home folder's name to name the folder the files a phone sends to coding sessions are kept in. */
export const RECEIVED_SUFFIX = "-received";

/** The folder the files a phone sends to coding sessions are kept in, one folder per session: a SIBLING of MOSS's home, named after it
 *  (`~/.moss` gives `~/.moss-received`, `~/.moss-dev` gives `~/.moss-dev-received`, a throwaway home `/tmp/x/home` gives `/tmp/x/home-received`),
 *  so a dev, preview or test daemon on its own home only ever writes beside that home and never in the person's real one. */
export function receivedRootOf(home: string): string {
  const h = resolve(home);
  return join(dirname(h), `${basename(h)}${RECEIVED_SUFFIX}`);
}

/** Test seam (`packages/core/test/preload.ts`): when set, the received folder must be inside it, or nothing is written. The preload sets it
 *  to the run's own temp root, so no test can reach the folder beside the person's real MOSS home. Never set in a real run. */
export const TEST_WRITE_ROOT_ENV = "MOSS_TEST_WRITE_ROOT";

function outsideTestRoot(root: string): boolean {
  const fence = process.env[TEST_WRITE_ROOT_ENV];
  if (fence === undefined || fence === "") return false;
  const real = (p: string): string => { try { return realpathSync.native(p); } catch { return resolve(p); } };
  return !within(real(fence), join(real(dirname(root)), basename(root)));
}

export interface StageLimits {
  fileBytes: number;
  /** One picture, the desktop's own cap (`STAGE_IMAGE_MAX_BYTES`). */
  pictureBytes: number;
  chunkBytes: number;
  openPerDevice: number;
  pendingBytes: number;
  dayBytes: number;
  dayFiles: number;
  unsentFiles: number;
  partialTtlMs: number;
  keepMs: number;
  perMessage: number;
  /** How long a coding session's file stays after the message that named it, then it is deleted. */
  namedKeepMs: number;
  /** How many bytes of named files one coding session keeps; over it, the oldest go first. */
  sessionKeepBytes: number;
}

export const STAGE_LIMITS: StageLimits = {
  fileBytes: STAGE_FILE_MAX_BYTES, pictureBytes: STAGE_IMAGE_MAX_BYTES, chunkBytes: STAGE_FILE_CHUNK_BYTES, openPerDevice: STAGE_FILE_OPEN_MAX, pendingBytes: STAGE_FILE_PENDING_MAX_BYTES,
  dayBytes: STAGE_FILE_DAY_MAX_BYTES, dayFiles: STAGE_FILE_DAY_MAX_FILES, unsentFiles: STAGE_FILE_UNSENT_MAX, partialTtlMs: STAGE_FILE_PARTIAL_TTL_MS, keepMs: STAGE_FILE_KEEP_MS, perMessage: STAGE_FILES_PER_MESSAGE_MAX,
  // A coding agent reads a file in the turn that names it; a later turn may still say "the file I sent", so it stays two weeks, a span
  // that outlasts a long task and still gives the person's home back what a session no longer needs. 500 MB a session bounds a session
  // that sends a lot over those weeks (the day's cap alone would let 14 days of it pile up); the oldest go first, the newest stay.
  namedKeepMs: 14 * 24 * 60 * 60 * 1000, sessionKeepBytes: 500 * 1024 * 1024,
};

// -------------------------------------------------------------------------------------------------
// What a file may be called, and be
// -------------------------------------------------------------------------------------------------

/** Windows' device names, with or without an extension, and the circled digits some of them accept. */
const RESERVED_STEM = /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
/** The longest a name may be in UTF-8: well under the 255 bytes a file system takes, whatever it adds. */
const NAME_MAX_BYTES = 200;
const EXT_MAX_BYTES = 20;

const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");

/** Keeps the end of `s` (its extension) and cuts the stem, by whole characters, until it fits `max` bytes. */
function fitBytes(s: string, max: number): string {
  if (byteLength(s) <= max) return s;
  const dot = s.lastIndexOf(".");
  const ext = dot > 0 && byteLength(s.slice(dot)) <= EXT_MAX_BYTES ? s.slice(dot) : "";
  const stem = ext === "" ? s : s.slice(0, dot);
  let out = "";
  for (const ch of stem) {
    if (byteLength(out + ch) + byteLength(ext) > max) break;
    out += ch;
  }
  return out + ext;
}

/** One safe file name from whatever the phone called the file: normalised, with no control, format or bidi characters, no path
 *  separator or character a file system refuses, no leading dot (never hidden, never `.` or `..`), no trailing dot or space, no
 *  Windows device name, and at most `NAME_MAX_BYTES` bytes of UTF-8 with its extension kept. Never empty. */
export function cleanFileName(raw: string): string {
  let s = raw.normalize("NFC").toWellFormed();
  s = s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, "");
  s = s.replace(/[/\\:*?"<>|]+/g, "_");
  s = s.replace(/^[.\s]+/u, "").replace(/[.\s]+$/u, "");
  if (s === "") return "file";
  const dot = s.indexOf(".");
  if (RESERVED_STEM.test(dot === -1 ? s : s.slice(0, dot))) s = `_${s}`;
  s = fitBytes(s, NAME_MAX_BYTES).replace(/[.\s]+$/u, "");
  return s === "" ? "file" : s;
}

/** Extensions of what launches, installs or runs by being opened: a phone's file is never one. A plain script (`.sh`, `.py`) is not
 *  here: it has no execute bit and runs only when something is told to run it. */
const LAUNCHED_BY_OPENING = new Set([
  "app", "command", "workflow", "action", "scpt", "scptd", "pkg", "mpkg", "dmg", "terminal", "tool", "webloc", "inetloc", "prefpane", "saver", "kext", "dylib", "so",
  "exe", "msi", "msix", "msp", "appx", "appxbundle", "bat", "cmd", "com", "scr", "pif", "lnk", "vbs", "vbe", "wsf", "wsh", "hta", "reg", "dll", "cpl", "sys", "gadget", "jar", "desktop", "appimage", "run",
]);

/** Why a file of this name or beginning is not taken, or undefined. The magic bytes of a program decide as the name does. */
export function refusedKind(name: string, head: Uint8Array): string | undefined {
  const dot = name.lastIndexOf(".");
  const ext = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
  if (LAUNCHED_BY_OPENING.has(ext)) return `a .${ext} file runs or installs when it is opened, so a phone can't send one`;
  const is = (...bytes: number[]) => bytes.every((b, i) => head[i] === b);
  const program = is(0x7f, 0x45, 0x4c, 0x46) || is(0x4d, 0x5a) || is(0xfe, 0xed, 0xfa, 0xce) || is(0xfe, 0xed, 0xfa, 0xcf) || is(0xce, 0xfa, 0xed, 0xfe) || is(0xcf, 0xfa, 0xed, 0xfe) || is(0xca, 0xfe, 0xba, 0xbe) || is(0xbe, 0xba, 0xfe, 0xca);
  if (program) return "that file is a program, and a phone can't send one";
  return undefined;
}

// -------------------------------------------------------------------------------------------------
// The ledger
// -------------------------------------------------------------------------------------------------

interface Upload {
  id: string;
  device: string;
  client: string;
  session: string;
  /** The cleaned name asked for, and the one the file got. */
  name: string;
  size: number;
  received: number;
  state: "open" | "ready" | "sent";
  startedAt: number;
  touchedAt: number;
  /** For a picture (`session.stagePicture`): the media type it said it was. It is checked by its first bytes at once and by the whole at the
   *  end, then handed to the picture stager, and leaves this ledger (the device's `StagedImages` holds it from there). */
  picture?: string;
  /** What it was staged for: a bot's conversation (the file goes in the bot's scratch) or a coding session (the file goes in
   *  the received folder, beside MOSS's home). Either way it is named by a folder-tree path. */
  kind?: "bot" | "coding";
  /** The folder the file's folder is made in (a bot's scratch, the coding sessions' received folder), and the folder in it that holds the file. */
  root: string;
  base: string;
  /** Once `ready`: the file, and what names it in the folder tree. */
  dest?: string;
  tree?: string;
  /** Once `sent`: the message that named it. */
  sentAs?: string;
}

interface Ledger {
  uploads: Record<string, Upload>;
  /** Bytes received per device, per UTC day. */
  days: Record<string, { day: string; bytes: number; files: number }>;
}

export interface StageTarget {
  kind: "bot" | "coding";
  session: string;
  bot?: string;
}

/** What a file or a picture may be staged for: a bot's main conversation that runs on this computer, or a coding session on it,
 *  not ended. `refusal` says why not, with the code the refusal carries. */
export function stageTargetOf(v: SessionView, bots: Pick<BotService, "mainSession" | "botsRunHere">, computer: string): { target: StageTarget } | { refusal: string; code: "closed" | "refused" } {
  if (v.status === "stopped" || v.status === "failed") return { refusal: `session ${v.id} has ended`, code: "closed" };
  if (v.kind === "bot" && v.bot !== undefined && bots.mainSession(v.bot) === v.id) {
    if (!bots.botsRunHere().includes(v.bot)) return { refusal: `${v.bot}'s conversation runs on another computer; send the file there`, code: "refused" };
    return { target: { kind: "bot", session: v.id, bot: v.bot } };
  }
  if (v.kind === "coding") {
    if (v.computer !== computer) return { refusal: `${v.id} runs on ${v.computer}; send the file there`, code: "refused" };
    return { target: { kind: "coding", session: v.id } };
  }
  return { refusal: "a file goes to a bot's conversation or a coding session", code: "refused" };
}

export interface StagerOptions {
  /** MOSS's home. */
  home: string;
  /** The user's home folder, which the tree's `home/<Computer>/` is. */
  userHome: string;
  computer: string;
  now: () => number;
  limits?: Partial<StageLimits>;
  /** Stages a whole picture the way the desktop's `session.stageImage` does (every check it makes, the session's own image folder) and
   *  gives back the path `session.send`'s `images` names it by. Without it a phone's pictures are refused. */
  stagePicture?: (session: string, mediaType: string, dataBase64: string) => string;
  /** The clock the sweep's timer runs on. Without one nothing is swept between calls (the sweep still runs at each call). */
  clock?: Clock;
  /** Whether this computer's host still holds a session. A coding session it no longer holds (removed, or let go with its bot) has its
   *  folder in the received folder deleted by the next sweep. Without it no session is ever taken for gone. */
  known?: (session: string) => boolean;
}

/** How often the sweep runs while the ledger holds anything: well inside the idle time (15 minutes), so a half-sent upload is gone
 *  within a few minutes after it, and a finished file no message named within a few minutes after a day. */
export const STAGE_SWEEP_EVERY_MS = 5 * 60 * 1000;

export interface StageResult {
  upload: string;
  received: number;
  done: boolean;
  name?: string;
  path?: string;
}

const refused = (message: string): ContractError => new ContractError("refused", message);
const invalid = (message: string): ContractError => new ContractError("invalid", message);
const fileRefused = (message: string): MethodError => new MethodError(ERR.INVALID_PARAMS, message, { code: FILE_REFERENCE_INVALID });

const MB = 1024 * 1024;
const mb = (bytes: number): string => `${Math.round(bytes / MB)} MB`;

/** Whether `child` is `parent` or under it (a folder whose own name begins with two dots is inside; a `..` step is not). */
const within = (parent: string, child: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Strict base64, to the bytes it says. */
function decodeChunk(b64: string, max: number): Buffer {
  if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw invalid("the chunk isn't base64");
  const bytes = Buffer.from(b64, "base64");
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  if (bytes.length !== (b64.length / 4) * 3 - pad || bytes.length === 0) throw invalid("the chunk isn't base64");
  if (bytes.length > max) throw invalid(`a chunk is at most ${Math.floor(max / 1024)} KB`);
  return bytes;
}

export type StageParams =
  | { name: string; size: number; dataBase64: string }
  | { mediaType: string; size: number; dataBase64: string }
  | { upload: string; offset: number; dataBase64: string }
  | { upload: string; cancel: true };

export class FileStager {
  readonly #o: StagerOptions;
  readonly #limits: StageLimits;
  readonly #file: string;
  readonly #spool: string;

  #timer: TimerHandle | undefined;
  #closed = false;

  constructor(o: StagerOptions) {
    this.#o = o;
    this.#limits = { ...STAGE_LIMITS, ...o.limits };
    this.#file = join(transcriptsDir(o.home), ".staged-files.json");
    this.#spool = join(transcriptsDir(o.home), ".staged-files");
    this.#arm(this.sweep());
  }

  /** Ends the sweep's timer, and arms no other: the engine's close calls it, so nothing of this is left to run (or to keep a process
   *  alive) after the daemon has gone. Calls still answered after it sweep as they always did, once, and arm nothing. */
  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) this.#o.clock?.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** Sets the next sweep when there is anything to sweep, and none otherwise: an engine nobody has sent a file to has no timer at all. */
  #arm(held: number): void {
    const clock = this.#o.clock;
    if (clock === undefined || this.#closed || this.#timer !== undefined || held === 0) return;
    this.#timer = clock.setTimeout(() => {
      this.#timer = undefined;
      if (this.#closed) return;
      let left = 0;
      try { left = this.sweep(); } catch { /* the next call or the next run tries again */ left = 1; }
      this.#arm(left);
    }, STAGE_SWEEP_EVERY_MS);
  }

  get limits(): StageLimits {
    return this.#limits;
  }

  // -- the ledger, read and written whole each time so every connection's calls agree --------------------------------------

  #read(): Ledger {
    const raw = readJson(this.#file) as Partial<Ledger> | undefined;
    const ok = raw !== null && typeof raw === "object" && raw.uploads !== null && typeof raw.uploads === "object";
    return { uploads: ok ? { ...raw.uploads } : {}, days: ok && raw.days !== null && typeof raw.days === "object" ? { ...raw.days } : {} };
  }

  #write(l: Ledger): void {
    writeJsonAtomic(this.#file, l, { mode: 0o600 });
  }

  #day(): string {
    return new Date(this.#o.now()).toISOString().slice(0, 10);
  }

  #spoolPath(id: string): string {
    return join(this.#spool, `${id}.part`);
  }

  /** Removes what a message will never name or no one will need: an upload idle too long, a finished file no message named in `keepMs`,
   *  a coding session's named file after `namedKeepMs` (and the oldest of a session over `sessionKeepBytes`), whatever a coding session
   *  this computer no longer holds had received, and every folder left empty; the record of a sent bot file goes after `keepMs` (the file
   *  is the bot's, in its own scratch folder). Gives back how many uploads the ledger still holds. */
  sweep(): number {
    const l = this.#read();
    const now = this.#o.now();
    let changed = false;
    for (const u of Object.values(l.uploads)) {
      const age = now - u.touchedAt;
      const gone = u.kind === "coding" && this.#o.known?.(u.session) === false;
      if (gone) this.#drop(l, u);
      else if (u.state === "open" && age > this.#limits.partialTtlMs) this.#drop(l, u);
      else if (u.state === "ready" && age > this.#limits.keepMs) this.#drop(l, u);
      else if (u.state === "sent" && u.kind === "coding" && age > this.#limits.namedKeepMs) this.#drop(l, u);
      else if (u.state === "sent" && u.kind !== "coding" && age > this.#limits.keepMs) delete l.uploads[u.id];
      else continue;
      changed = true;
    }
    // A session that sends a lot keeps the newest of what a message named, up to a size.
    const named = new Map<string, Upload[]>();
    for (const u of Object.values(l.uploads)) if (u.state === "sent" && u.kind === "coding") named.set(u.session, [...(named.get(u.session) ?? []), u]);
    for (const list of named.values()) {
      let total = list.reduce((n, u) => n + u.size, 0);
      for (const u of list.sort((a, b) => a.touchedAt - b.touchedAt)) {
        if (total <= this.#limits.sessionKeepBytes) break;
        total -= u.size;
        this.#drop(l, u);
        changed = true;
      }
    }
    for (const [device, d] of Object.entries(l.days)) {
      if (d.day !== this.#day()) { delete l.days[device]; changed = true; }
    }
    if (changed) this.#write(l);
    this.#tidy();
    return Object.keys(l.uploads).length;
  }

  /** Takes an upload out of the ledger and removes what it holds: its spool file, or the file it placed (and its folder). A sent bot file is the bot's. */
  #drop(l: Ledger, u: Upload): void {
    delete l.uploads[u.id];
    try { unlinkSync(this.#spoolPath(u.id)); } catch { /* not there */ }
    if (u.dest === undefined || (u.state === "sent" && u.kind !== "coding")) return;
    this.#discard(dirname(u.dest));
    if (u.kind === "coding") this.#tidy();
  }

  /** `session` is gone from this computer: its record of files and its folder in the received folder go. (The sweep calls it for a session
   *  the host no longer holds.) A bot's files are in its scratch folder, which is the bot's own. */
  forgetSession(session: string): void {
    const l = this.#read();
    for (const u of Object.values(l.uploads)) if (u.session === session) this.#drop(l, u);
    this.#write(l);
    if (session !== "" && session !== "." && session !== ".." && !/[\\/]/.test(session)) this.#discard(join(receivedRootOf(this.#o.home), session));
    this.#tidy();
  }

  /** Removes a folder this module made (`phone-<id>`, or a session's) without ever deleting by a name an agent that writes the folder's
   *  parent can aim elsewhere: the folder is first RENAMED into the engine's own spool (a rename moves the entry itself, so a link planted in
   *  its place is moved as a link and never followed), and what sits there is deleted, a link by unlinking it. If the rename can't be done
   *  (the folder is gone, or the spool is on another volume) nothing is deleted by name. */
  #discard(folder: string): void {
    const away = join(this.#spool, `drop-${randomBytes(8).toString("hex")}`);
    try {
      mkdirSync(this.#spool, { recursive: true, mode: 0o700 });
      renameSync(folder, away);
    } catch { return; }
    try { rmSync(away, { recursive: true, force: true }); } catch { /* the next sweep takes it */ }
  }

  /** Removes the empty session folders in the received folder (the received folder itself too, once nothing is in it), the leftovers of
   *  earlier discards in the spool, and what a half-done discard left. `rmdir` takes an empty folder only, and never through a link. */
  #tidy(): void {
    try {
      for (const name of readdirSync(this.#spool)) if (name.startsWith("drop-")) rmSync(join(this.#spool, name), { recursive: true, force: true });
    } catch { /* no spool yet */ }
    const root = receivedRootOf(this.#o.home);
    try {
      if (!lstatSync(root).isDirectory()) return;
      for (const session of readdirSync(root)) {
        const dir = join(root, session);
        if (!lstatSync(dir).isDirectory()) continue;
        for (const sub of readdirSync(dir)) if (sub.startsWith("phone-")) try { rmdirSync(join(dir, sub)); } catch { /* not empty */ }
        try { rmdirSync(dir); } catch { /* not empty */ }
      }
      rmdirSync(root);
    } catch { /* not there, or not empty */ }
  }

  // -- one call -----------------------------------------------------------------------------------------------------------

  /** One call of a file's upload (`mode` "file", `session.stageFile`) or a picture's (`mode` "picture", `session.stagePicture`): the same
   *  ledger, spool and quotas, and an upload belongs to the door that began it. */
  stage(who: { device: string; client: string }, target: StageTarget, p: StageParams, mode: "file" | "picture" = "file"): StageResult {
    this.sweep();
    try {
      if ("cancel" in p) return this.#cancel(who, target, p.upload, mode);
      if ("mediaType" in p) return this.#beginPicture(who, target, p);
      return "name" in p ? this.#begin(who, target, p) : this.#next(who, target, p, mode);
    } finally {
      // Whatever is held now is swept on a timer too, not only at the next call.
      this.#arm(Object.keys(this.#read().uploads).length);
    }
  }

  /** Where a file for this target goes. A bot's is in its scratch folder, a place its own file tools open. A coding session's agent
   *  can open nothing inside MOSS's home (its sandbox denies the whole home, with no way back in for the session's own `outputs`, and
   *  the manager refuses any request into it), and the project is not a place to put what a phone sends, so its file goes in a
   *  folder of its own beside MOSS's home, `receivedRootOf(home)/<session>/` (`~/.moss-received/<session>/`), which the sandbox lets it read and the
   *  folder tree names (the agent is told the real path: `promptOf`). */
  #folders(t: StageTarget): { root: string; base: string } {
    if (t.kind === "coding") {
      const root = receivedRootOf(this.#o.home);
      return { root, base: join(root, t.session) };
    }
    const root = botPaths(this.#o.home, t.bot!).scratch;
    return { root, base: join(root, "attachments") };
  }

  #begin(who: { device: string; client: string }, target: StageTarget, p: { name: string; size: number; dataBase64: string }): StageResult {
    const lim = this.#limits;
    if (!Number.isInteger(p.size) || p.size < 1) throw invalid("a file has at least one byte");
    if (p.size > lim.fileBytes) throw refused(`A file can be at most ${mb(lim.fileBytes)}; this one is ${Math.ceil(p.size / MB)} MB.`);
    const bytes = decodeChunk(p.dataBase64, lim.chunkBytes);
    if (bytes.length > p.size) throw invalid("the first chunk is longer than the file");
    const name = cleanFileName(p.name);
    const why = refusedKind(name, bytes.subarray(0, 16));
    if (why !== undefined) throw refused(why);
    const l = this.#read();
    const mine = Object.values(l.uploads).filter((u) => u.device === who.device && u.state !== "sent");
    if (mine.filter((u) => u.state === "open").length >= lim.openPerDevice) throw refused(`Only ${lim.openPerDevice} files can be on their way at once; wait for one to finish or cancel it.`);
    const held = mine.reduce((n, u) => n + u.size, 0);
    if (held + p.size > lim.pendingBytes) throw refused(`This phone has ${mb(held)} of files waiting to be sent; at most ${mb(lim.pendingBytes)} can wait. Send them, or cancel one.`);
    if (mine.length >= lim.unsentFiles) throw refused(`This phone has ${mine.length} files waiting to be sent; at most ${lim.unsentFiles} can wait. Send them, or cancel some.`);
    const today = l.days[who.device]?.day === this.#day() ? l.days[who.device]! : { day: this.#day(), bytes: 0, files: 0 };
    const day = today.bytes;
    if (day + p.size > lim.dayBytes) throw refused(`This phone has sent ${mb(day)} today; at most ${mb(lim.dayBytes)} a day. Try again tomorrow.`);
    if (today.files >= lim.dayFiles) throw refused(`This phone has sent ${today.files} files today; at most ${lim.dayFiles} a day. Try again tomorrow.`);
    const { root, base } = this.#folders(target);
    if (target.kind === "coding" && outsideTestRoot(root)) throw refused("A test may not write the received folder outside its own temp folder; nothing was written.");
    // The folder this file will be named in must be one the folder tree can name (the same refusal the desktop's drop gives).
    if (this.#treeOf(join(base, "phone-0", name)) === undefined) throw refused(target.kind === "coding"
      ? "MOSS's home isn't a folder of your home folder here, so the folder for files a phone sends to a coding session (beside it) can't be named in the folder tree."
      : "This conversation's folder isn't inside your home folder, so the folder tree can't name a file in it.");
    const id = randomBytes(16).toString("hex");
    mkdirSync(this.#spool, { recursive: true, mode: 0o700 });
    const fd = openSync(this.#spoolPath(id), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeAll(fd, bytes);
    } catch (err) {
      closeSync(fd);
      try { unlinkSync(this.#spoolPath(id)); } catch { /* best effort */ }
      throw err;
    }
    closeSync(fd);
    const now = this.#o.now();
    const u: Upload = { id, device: who.device, client: who.client, session: target.session, name, size: p.size, received: bytes.length, state: "open", startedAt: now, touchedAt: now, kind: target.kind, root, base };
    l.uploads[id] = u;
    l.days[who.device] = { day: this.#day(), bytes: day + bytes.length, files: today.files + 1 };
    this.#finishIfWhole(l, u);
    return this.#progress(l, u);
  }

  /** A picture's first chunk: its type is told by its first bytes before the rest is sent (so a file that isn't one is refused at once, not
   *  after 5 MB), under the desktop's own size cap and the same quotas as a file. The whole is checked again when the last chunk lands. */
  #beginPicture(who: { device: string; client: string }, target: StageTarget, p: { mediaType: string; size: number; dataBase64: string }): StageResult {
    const lim = this.#limits;
    if (this.#o.stagePicture === undefined) throw refused("this computer takes no pictures from a phone");
    if (!Number.isInteger(p.size) || p.size < 1) throw invalid("a picture has at least one byte");
    if (p.size > lim.pictureBytes) throw refused(`A picture can be at most ${(lim.pictureBytes / MB).toFixed(1)} MB; this one is ${(p.size / MB).toFixed(1)} MB.`);
    const bytes = decodeChunk(p.dataBase64, lim.chunkBytes);
    if (bytes.length > p.size) throw invalid("the first chunk is longer than the picture");
    if (bytes.length < IMAGE_SNIFF_BYTES && bytes.length < p.size) throw invalid("the first chunk is too short to tell what the picture is");
    const sniffed = sniffImageMediaType(bytes.subarray(0, IMAGE_SNIFF_BYTES));
    if (sniffed === undefined) throw new ContractError("invalid", "Only PNG, JPEG, GIF, WebP, HEIC, TIFF and BMP images are supported");
    if (sniffed !== p.mediaType) throw invalid(`the picture data is ${sniffed}, not the declared ${p.mediaType}`);
    const l = this.#read();
    const mine = Object.values(l.uploads).filter((u) => u.device === who.device && u.state !== "sent");
    if (mine.filter((u) => u.state === "open").length >= lim.openPerDevice) throw refused(`Only ${lim.openPerDevice} files can be on their way at once; wait for one to finish or cancel it.`);
    const held = mine.reduce((n, u) => n + u.size, 0);
    if (held + p.size > lim.pendingBytes) throw refused(`This phone has ${mb(held)} of files waiting to be sent; at most ${mb(lim.pendingBytes)} can wait. Send them, or cancel one.`);
    const today = l.days[who.device]?.day === this.#day() ? l.days[who.device]! : { day: this.#day(), bytes: 0, files: 0 };
    if (today.bytes + p.size > lim.dayBytes) throw refused(`This phone has sent ${mb(today.bytes)} today; at most ${mb(lim.dayBytes)} a day. Try again tomorrow.`);
    if (today.files >= lim.dayFiles) throw refused(`This phone has sent ${today.files} files today; at most ${lim.dayFiles} a day. Try again tomorrow.`);
    const id = randomBytes(16).toString("hex");
    mkdirSync(this.#spool, { recursive: true, mode: 0o700 });
    const fd = openSync(this.#spoolPath(id), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeAll(fd, bytes);
    } catch (err) {
      closeSync(fd);
      try { unlinkSync(this.#spoolPath(id)); } catch { /* best effort */ }
      throw err;
    }
    closeSync(fd);
    const now = this.#o.now();
    const u: Upload = { id, device: who.device, client: who.client, session: target.session, name: "picture", size: p.size, received: bytes.length, state: "open", startedAt: now, touchedAt: now, picture: p.mediaType, root: "", base: "" };
    l.uploads[id] = u;
    l.days[who.device] = { day: this.#day(), bytes: today.bytes + bytes.length, files: today.files + 1 };
    return this.#progress(l, u, this.#finishPictureIfWhole(l, u));
  }

  #next(who: { device: string; client: string }, target: StageTarget, p: { upload: string; offset: number; dataBase64: string }, mode: "file" | "picture"): StageResult {
    const lim = this.#limits;
    const l = this.#read();
    const u = this.#own(l, who, target, p.upload, mode);
    if (u.state !== "open") throw refused("That upload is already complete.");
    if (p.offset !== u.received) throw invalid(`The next chunk starts at byte ${u.received}, not ${p.offset}.`);
    const bytes = decodeChunk(p.dataBase64, lim.chunkBytes);
    if (u.received + bytes.length > u.size) {
      this.#drop(l, u);
      this.#write(l);
      throw invalid("The chunks are longer than the file said it was; the upload is dropped.");
    }
    const today = l.days[who.device]?.day === this.#day() ? l.days[who.device]! : { day: this.#day(), bytes: 0, files: 0 };
    const day = today.bytes;
    if (day + bytes.length > lim.dayBytes) {
      this.#drop(l, u);
      this.#write(l);
      throw refused(`This phone has sent ${mb(day)} today; at most ${mb(lim.dayBytes)} a day. Try again tomorrow.`);
    }
    const fd = openSync(this.#spoolPath(u.id), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try {
      if (fstatSync(fd).size !== u.received) throw invalid("The upload's held bytes don't match; start the file again.");
      writeAll(fd, bytes);
    } finally {
      closeSync(fd);
    }
    u.received += bytes.length;
    u.touchedAt = this.#o.now();
    l.days[who.device] = { day: this.#day(), bytes: day + bytes.length, files: today.files };
    if (u.picture !== undefined) return this.#progress(l, u, this.#finishPictureIfWhole(l, u));
    this.#finishIfWhole(l, u);
    return this.#progress(l, u);
  }

  /** Once every byte of a picture is here it is handed, whole, to the picture stager (every check the desktop's door makes, run again
   *  on the assembled bytes), which gives back the path `images` names it by; the upload then leaves this ledger. A picture that fails
   *  any check is dropped, and says why. */
  #finishPictureIfWhole(l: Ledger, u: Upload): string | undefined {
    if (u.received !== u.size) return undefined;
    try {
      const whole = readFileSync(this.#spoolPath(u.id));
      if (whole.length !== u.size) throw invalid("The picture is shorter or longer than it said.");
      const path = this.#o.stagePicture!(u.session, u.picture!, whole.toString("base64"));
      delete l.uploads[u.id];
      try { unlinkSync(this.#spoolPath(u.id)); } catch { /* the sweep takes it */ }
      return path;
    } catch (err) {
      this.#drop(l, u);
      this.#write(l);
      throw err instanceof ContractError || err instanceof MethodError ? err : refused("The picture couldn't be staged.");
    }
  }

  /** Once every byte is here the file is placed in its folder; a placing that fails drops the upload (and says why). */
  #finishIfWhole(l: Ledger, u: Upload): void {
    if (u.received !== u.size) return;
    try {
      this.#place(u);
    } catch (err) {
      this.#drop(l, u);
      this.#write(l);
      throw err instanceof ContractError ? err : refused("The file couldn't be placed in this conversation's folder.");
    }
  }

  #cancel(who: { device: string; client: string }, target: StageTarget, id: string, mode: "file" | "picture"): StageResult {
    const l = this.#read();
    const u = this.#own(l, who, target, id, mode);
    if (u.state === "sent") throw refused("A message already names that file.");
    this.#drop(l, u);
    this.#write(l);
    return { upload: id, received: 0, done: false };
  }

  /** The upload this device staged for this session (never another device's, another session's, or one that is gone). */
  #own(l: Ledger, who: { device: string; client: string }, target: StageTarget, id: string, mode: "file" | "picture"): Upload {
    const u = l.uploads[id];
    if (u === undefined || u.device !== who.device || u.client !== who.client || u.session !== target.session || (u.picture !== undefined) !== (mode === "picture")) throw new ContractError("not_found", "no such upload for this phone and conversation");
    return u;
  }

  /** The reply to a call. `picture` is the path a finished picture was staged at (and that picture's upload is no longer in the ledger). */
  #progress(l: Ledger, u: Upload, picture?: string): StageResult {
    this.#write(l);
    if (picture !== undefined) return { upload: u.id, received: u.received, done: true, path: picture };
    const done = u.state !== "open";
    return { upload: u.id, received: u.received, done, ...(done && u.dest !== undefined && u.tree !== undefined ? { name: u.name, path: u.tree } : {}) };
  }

  /** `path` (in MOSS's home or the user's, spelled either way) as a folder-tree path, or undefined when it isn't inside the user's home. */
  #treeOf(path: string): string | undefined {
    const real = (p: string): string => { try { return realpathSync.native(p); } catch { return p; } };
    const realUser = real(this.#o.userHome);
    let dir = path;
    for (const spelled of [this.#o.home, this.#o.userHome]) {
      const resolved = real(spelled);
      if (within(resolved, dir)) break;
      if (within(spelled, dir)) { dir = join(resolved, relative(spelled, dir)); break; }
    }
    return homeTreePath({ userHome: realUser, computer: this.#o.computer, dir });
  }

  /** Moves the whole file from the spool to its folder. Every step that can be fooled by a link in the bot's or session's own
   *  (writable) folder is checked: the folders' real paths are the expected ones, and the file is judged by its descriptor first. */
  #place(u: Upload): void {
    const coding = u.kind === "coding";
    const home = realpathSync.native(this.#o.home);
    let root: string;
    if (coding) {
      // The received folder, beside MOSS's home: one real folder of ours, not a link a sandboxed agent (which may write the home's folder) put
      // there to lead the file elsewhere, and not inside or around MOSS's home (inside, no agent could read it).
      if (outsideTestRoot(u.root)) throw refused("A test may not write the received folder outside its own temp folder; nothing was written.");
      const parent = realpathSync.native(dirname(this.#o.home));
      try { mkdirSync(u.root, { mode: 0o700 }); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
      const st = lstatSync(u.root);
      // On Windows there is no owner id to compare: the folder takes the ACL its parent hands down when it is made, and a junction or
      // link in its place fails the real-path comparison below, as everywhere.
      if (!st.isDirectory() || st.isSymbolicLink() || (typeof process.getuid === "function" && st.uid !== process.getuid())) throw refused("The folder for files a phone sends isn't a plain folder of yours; nothing was written.");
      root = realpathSync.native(u.root);
      if (root !== join(parent, lastPart(u.root)) || within(home, root) || within(root, home)) throw refused("The folder for files a phone sends isn't where it should be; nothing was written.");
    } else {
      mkdirSync(u.root, { recursive: true, mode: 0o700 });
      root = realpathSync.native(u.root);
      if (!within(home, root) || root === home) throw refused("This conversation's folder isn't inside MOSS's own.");
    }
    mkdirSync(u.base, { recursive: true, mode: 0o700 });
    const base = realpathSync.native(u.base);
    // One level under the root, and not through a link: a planted `attachments -> elsewhere` leads nowhere.
    if (base !== join(root, lastPart(u.base)) || !lstatSync(u.base).isDirectory()) throw refused("This conversation's file folder isn't a plain folder; nothing was written.");
    const folder = join(base, `phone-${u.id}`);
    mkdirSync(folder, { mode: 0o700 });
    try {
      if (!lstatSync(folder).isDirectory() || realpathSync.native(folder) !== folder) throw refused("The file's folder changed while it was placed; nothing was written.");
      const made = createExclusive(folder, u.name);
      if (made === undefined) throw refused("The file couldn't be given a free name.");
      const { fd, path } = made;
      try {
        // The descriptor must be the file at `path`, and `path` must be where it was made, before a byte goes in.
        const opened = fstatSync(fd);
        const real = realpathSync.native(path);
        const here = statSync(real);
        if (real !== path || here.ino !== opened.ino || here.dev !== opened.dev || !opened.isFile()) throw refused("The file's folder changed while it was placed; nothing was written.");
        const spool = openSync(this.#spoolPath(u.id), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const buf = Buffer.allocUnsafe(64 * 1024);
          let total = 0;
          for (;;) {
            const n = readSync(spool, buf, 0, buf.length, null);
            if (n === 0) break;
            total += n;
            if (total > u.size) throw refused("The file is longer than it said.");
            writeAll(fd, buf.subarray(0, n));
          }
          if (total !== u.size) throw refused("The file is shorter than it said.");
        } finally {
          closeSync(spool);
        }
      } finally {
        closeSync(fd);
      }
      const tree = this.#treeOf(path);
      if (tree === undefined) throw refused("This conversation's folder isn't inside your home folder, so the folder tree can't name a file in it.");
      u.dest = path;
      u.tree = tree;
      u.state = "ready";
      u.name = path.slice(folder.length + 1);
      try { unlinkSync(this.#spoolPath(u.id)); } catch { /* the sweep takes it */ }
    } catch (err) {
      // Never `unlink(created)` by name: the folder is moved into the engine's own spool and removed there.
      this.#discard(folder);
      throw err;
    }
  }

  // -- the next message names what was staged ------------------------------------------------------------------------------

  /** Checks that every path a phone's message names is a file this device staged for this session, whole and still a plain file,
   *  and answers a `commit` that marks them sent. Throws `file_reference_invalid` for any that isn't (and nothing is marked). */
  claim(who: { device: string; client: string }, session: string, clientMessageId: string, paths: readonly string[]): { commit(): void } {
    this.sweep();
    if (paths.length > this.#limits.perMessage) throw fileRefused(`A message can carry at most ${this.#limits.perMessage} files; you named ${paths.length}.`);
    const l = this.#read();
    const mine = Object.values(l.uploads).filter((u) => u.device === who.device && u.client === who.client && u.session === session && u.tree !== undefined);
    const named: Upload[] = [];
    for (const path of paths) {
      const u = mine.find((x) => x.tree === path);
      if (u === undefined || u.dest === undefined) throw fileRefused("A file in the message isn't one this phone sent to this conversation.");
      if (u.state === "sent" && u.sentAs !== clientMessageId) throw fileRefused("A file in the message was already sent in another message; send it again.");
      if (u.state === "open") throw fileRefused("A file in the message hasn't finished arriving.");
      if (named.includes(u)) throw fileRefused("A file is named twice in the message.");
      try {
        const st = lstatSync(u.dest);
        if (!st.isFile() || st.size !== u.size) throw fileRefused("A file in the message has changed since it arrived.");
      } catch (err) {
        if (err instanceof MethodError) throw err;
        throw fileRefused("A file in the message is gone.");
      }
      named.push(u);
    }
    return {
      commit: () => {
        const fresh = this.#read();
        for (const u of named) {
          const held = fresh.uploads[u.id];
          if (held === undefined) continue;
          held.state = "sent";
          held.sentAs = clientMessageId;
          held.touchedAt = this.#o.now();
        }
        this.#write(fresh);
      },
    };
  }
}

/** Creates a new file `name` in `folder`, or `name (2)`, `name (3)`… when that is taken, and never overwrites or follows a link: the
 *  file system says `EEXIST` for a name that is taken in any case spelling it folds together. Mode `0600`: no execute bit. */
export function createExclusive(folder: string, name: string): { fd: number; path: string } | undefined {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let k = 0; k < 100; k++) {
    const path = join(folder, k === 0 ? name : fitBytes(`${stem} (${k + 1})${ext}`, NAME_MAX_BYTES));
    try {
      return { fd: openSync(path, flags, 0o600), path };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  return undefined;
}

function writeAll(fd: number, bytes: Uint8Array): void {
  let off = 0;
  while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
}

/** The last path component of `p` (either separator). */
function lastPart(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? p : p.slice(i + 1);
}
