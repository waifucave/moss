// The files a paired phone sends (`session.stageFile`, the owner's decision of 2026-11-24, PH3). A file arrives in chunks over the
// phone's link, is held aside in the core's own folder until it is whole, then is placed in the folder its bot or coding session
// works in, where a file dropped on the desktop would have been (a bot's `scratch/<bot>/attachments/`; a coding session's own
// `outputs/<session>/received/`), and the phone's next `session.send` names it (`files`). Owner: lane PH.
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
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, rmdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, relative, isAbsolute, sep } from "node:path";
import {
  ERR, FILE_REFERENCE_INVALID, STAGE_FILE_CHUNK_BYTES, STAGE_FILE_DAY_MAX_BYTES, STAGE_FILE_DAY_MAX_FILES, STAGE_FILE_UNSENT_MAX, STAGE_FILE_KEEP_MS, STAGE_FILE_MAX_BYTES, STAGE_FILE_OPEN_MAX,
  STAGE_FILE_PARTIAL_TTL_MS, STAGE_FILE_PENDING_MAX_BYTES, STAGE_FILES_PER_MESSAGE_MAX,
} from "@waifucave/moss-protocol";
import type { SessionView } from "@waifucave/moss-protocol";
import { ContractError } from "../contracts/common";
import { MethodError } from "../rpc/handler";
import { readJson, writeJsonAtomic } from "../sessions/atomic-file";
import { transcriptsDir } from "../sessions/ids";
import { outdirPath } from "../sessions/outdir";
import { botPaths, homeTreePath } from "./paths";
import type { BotService } from "./service";

export interface StageLimits {
  fileBytes: number;
  chunkBytes: number;
  openPerDevice: number;
  pendingBytes: number;
  dayBytes: number;
  dayFiles: number;
  unsentFiles: number;
  partialTtlMs: number;
  keepMs: number;
  perMessage: number;
}

export const STAGE_LIMITS: StageLimits = {
  fileBytes: STAGE_FILE_MAX_BYTES, chunkBytes: STAGE_FILE_CHUNK_BYTES, openPerDevice: STAGE_FILE_OPEN_MAX, pendingBytes: STAGE_FILE_PENDING_MAX_BYTES,
  dayBytes: STAGE_FILE_DAY_MAX_BYTES, dayFiles: STAGE_FILE_DAY_MAX_FILES, unsentFiles: STAGE_FILE_UNSENT_MAX, partialTtlMs: STAGE_FILE_PARTIAL_TTL_MS, keepMs: STAGE_FILE_KEEP_MS, perMessage: STAGE_FILES_PER_MESSAGE_MAX,
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
  /** The folder the file's folder is made in (a bot's scratch, a session's outputs), and the folder in it that holds the file. */
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
}

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
  | { upload: string; offset: number; dataBase64: string }
  | { upload: string; cancel: true };

export class FileStager {
  readonly #o: StagerOptions;
  readonly #limits: StageLimits;
  readonly #file: string;
  readonly #spool: string;

  constructor(o: StagerOptions) {
    this.#o = o;
    this.#limits = { ...STAGE_LIMITS, ...o.limits };
    this.#file = join(transcriptsDir(o.home), "staged-files.json");
    this.#spool = join(transcriptsDir(o.home), "staged-files");
    this.sweep();
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

  /** Removes what a message will never name: an upload idle too long, a finished file no message named in `keepMs`, and the record of a sent one after the same time. */
  sweep(): void {
    const l = this.#read();
    const now = this.#o.now();
    let changed = false;
    for (const u of Object.values(l.uploads)) {
      const age = now - u.touchedAt;
      if (u.state === "open" && age > this.#limits.partialTtlMs) this.#drop(l, u);
      else if (u.state === "ready" && age > this.#limits.keepMs) this.#drop(l, u);
      else if (u.state === "sent" && age > this.#limits.keepMs) delete l.uploads[u.id];
      else continue;
      changed = true;
    }
    for (const [device, d] of Object.entries(l.days)) {
      if (d.day !== this.#day()) { delete l.days[device]; changed = true; }
    }
    if (changed) this.#write(l);
  }

  /** Takes an upload out of the ledger and removes what it holds: its spool file, or the file it placed (and its folder). A sent file is the message's. */
  #drop(l: Ledger, u: Upload): void {
    delete l.uploads[u.id];
    if (u.state === "sent") return;
    try { unlinkSync(this.#spoolPath(u.id)); } catch { /* not there */ }
    if (u.dest === undefined) return;
    try {
      // Only a regular file at the place this module made, inside the folder it made it in; never what a link now leads to.
      const folder = dirname(u.dest);
      if (lstatSync(u.dest).isFile() && realpathSync(folder) === folder && within(realpathSync(u.root), folder)) unlinkSync(u.dest);
      rmdirSync(folder);
    } catch { /* gone, or no longer ours to touch */ }
  }

  // -- one call -----------------------------------------------------------------------------------------------------------

  stage(who: { device: string; client: string }, target: StageTarget, p: StageParams): StageResult {
    this.sweep();
    if ("cancel" in p) return this.#cancel(who, target, p.upload);
    return "name" in p ? this.#begin(who, target, p) : this.#next(who, target, p);
  }

  #folders(t: StageTarget): { root: string; base: string } {
    const root = t.kind === "bot" ? botPaths(this.#o.home, t.bot!).scratch : outdirPath(this.#o.home, t.session);
    return { root, base: join(root, t.kind === "bot" ? "attachments" : "received") };
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
    // The folder this file will be named in must be one the folder tree can name (the same refusal the desktop's drop gives).
    if (this.#treeOf(join(base, "phone-0", name)) === undefined) throw refused("This conversation's folder isn't inside your home folder, so the folder tree can't name a file in it.");
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
    const u: Upload = { id, device: who.device, client: who.client, session: target.session, name, size: p.size, received: bytes.length, state: "open", startedAt: now, touchedAt: now, root, base };
    l.uploads[id] = u;
    l.days[who.device] = { day: this.#day(), bytes: day + bytes.length, files: today.files + 1 };
    this.#finishIfWhole(l, u);
    return this.#progress(l, u);
  }

  #next(who: { device: string; client: string }, target: StageTarget, p: { upload: string; offset: number; dataBase64: string }): StageResult {
    const lim = this.#limits;
    const l = this.#read();
    const u = this.#own(l, who, target, p.upload);
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
    this.#finishIfWhole(l, u);
    return this.#progress(l, u);
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

  #cancel(who: { device: string; client: string }, target: StageTarget, id: string): StageResult {
    const l = this.#read();
    const u = this.#own(l, who, target, id);
    if (u.state === "sent") throw refused("A message already names that file.");
    this.#drop(l, u);
    this.#write(l);
    return { upload: id, received: 0, done: false };
  }

  /** The upload this device staged for this session (never another device's, another session's, or one that is gone). */
  #own(l: Ledger, who: { device: string; client: string }, target: StageTarget, id: string): Upload {
    const u = l.uploads[id];
    if (u === undefined || u.device !== who.device || u.client !== who.client || u.session !== target.session) throw new ContractError("not_found", "no such upload for this phone and conversation");
    return u;
  }

  #progress(l: Ledger, u: Upload): StageResult {
    this.#write(l);
    const done = u.state !== "open";
    return { upload: u.id, received: u.received, done, ...(done && u.dest !== undefined && u.tree !== undefined ? { name: u.name, path: u.tree } : {}) };
  }

  /** `path` (in MOSS's home, spelled either way) as a folder-tree path, or undefined when MOSS's home isn't inside the user's. */
  #treeOf(path: string): string | undefined {
    const real = (p: string): string => { try { return realpathSync.native(p); } catch { return p; } };
    const realHome = real(this.#o.home);
    const dir = within(realHome, path) ? path : within(this.#o.home, path) ? join(realHome, relative(this.#o.home, path)) : path;
    return homeTreePath({ userHome: real(this.#o.userHome), computer: this.#o.computer, dir });
  }

  /** Moves the whole file from the spool to its folder. Every step that can be fooled by a link in the bot's or session's own
   *  (writable) folder is checked: the folders' real paths are the expected ones, and the file is judged by its descriptor first. */
  #place(u: Upload): void {
    const home = realpathSync.native(this.#o.home);
    mkdirSync(u.root, { recursive: true, mode: 0o700 });
    const root = realpathSync.native(u.root);
    if (!within(home, root) || root === home) throw refused("This conversation's folder isn't inside MOSS's own.");
    mkdirSync(u.base, { recursive: true, mode: 0o700 });
    const base = realpathSync.native(u.base);
    // One level under the root, and not through a link: a planted `attachments -> elsewhere` leads nowhere.
    if (base !== join(root, lastPart(u.base)) || !lstatSync(u.base).isDirectory()) throw refused("This conversation's file folder isn't a plain folder; nothing was written.");
    const folder = join(base, `phone-${u.id}`);
    mkdirSync(folder, { mode: 0o700 });
    let created: string | undefined;
    try {
      if (!lstatSync(folder).isDirectory() || realpathSync.native(folder) !== folder) throw refused("The file's folder changed while it was placed; nothing was written.");
      const made = createExclusive(folder, u.name);
      if (made === undefined) throw refused("The file couldn't be given a free name.");
      const { fd, path } = made;
      created = path;
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
      if (created !== undefined) try { unlinkSync(created); } catch { /* best effort */ }
      try { rmSync(folder, { recursive: true, force: true }); } catch { /* best effort */ }
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
