// What the secrets file needs from the disk (spec §9.1; spike S8's "M1 must pin ... atomic writes"):
//   * `writePrivateFile`: a file only its owner can read, never readable by anyone else even for a moment, replaced
//     atomically and durably (flushed before the rename, the rename flushed after: `renameDurably`). It is made empty under a temporary name, locked down (0600; on Windows the inherited entries dropped
//     and the user's SID alone granted, `icacls`, as `platform/pair/run-files.ts` does for the app token), then written
//     and renamed into place, so a reader sees the old file or the new one, never half of one. Windows refuses a
//     rename over a file another process has open for a moment: it is retried briefly.
//   * `withSecretsLock`: one writer at a time across the processes of this user (the daemon, the CLI when the daemon is
//     down, `moss doctor`) and inside one process. The file is read, changed and written whole, so two unlocked
//     writers lose an update. The lock is a file made with `wx` holding the holder's pid and the time; one whose pid is
//     gone, or that is far older than any write takes, is taken over.
// No value passes through here but the bytes the caller hands `writePrivateFile`; nothing is logged.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ContractError } from "../contracts/common";
import { bunRunner, windowsUserSid, type Runner } from "../platform/login/live";

/** The durable steps of a write, in the order they happen. */
export type PrivateFileStep = "created" | "locked" | "written" | "file-flushed" | "renamed" | "rename-flushed";

export interface PrivateFileDeps {
  /** Where the temporary file is made: a folder on the same volume as the file, by default the file's own. The secrets
   *  files pass the run folder, which every fence hides, so a half-made copy never sits under a name no deny list knows. */
  tmpDir?: string;
  /** A test seam: called right after each durable step. A throw here is a crash at that point: nothing after it runs. */
  step?: (name: PrivateFileStep, detail?: string) => void;
  /** Defaults to this process's platform. */
  platform?: NodeJS.Platform;
  /** Windows: runs `icacls`. */
  run?: Runner;
  /** Windows: the user's SID; read with `whoami` when not given. */
  userSid?: string;
}

/** Windows' own tools by full path: a bare `whoami` or `icacls` on PATH may be Git's (Git Bash's coreutils `whoami` takes no
 *  `/user`), and a program a user's PATH names first is not to be trusted with an ACL. */
function system32(run: Runner): Runner {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  return (argv) => {
    const [first, ...rest] = argv;
    return run(first === "whoami" || first === "icacls" ? [`${root}\\System32\\${first}.exe`, ...rest] : argv);
  };
}

let sidMemo: Promise<string | undefined> | undefined;
async function userSidOf(deps: PrivateFileDeps): Promise<string | undefined> {
  if (deps.userSid !== undefined) return deps.userSid;
  sidMemo ??= windowsUserSid(system32(deps.run ?? bunRunner)).then((s) => { if (s === undefined) sidMemo = undefined; return s; });
  return sidMemo;
}

/** Locks `path` (a file or a folder that exists) to the user alone. Throws when the OS will not: a secret is never
 *  written under an ACL that anyone else's inherited entry could widen. */
let windowsAclForTests: ((path: string) => Promise<void>) | undefined;
/** Tests only: what locks a file to the user on Windows instead of `icacls` (one process per write), for the generated-
 *  sequence tests, whose hundreds of writes are about order and crashes, not the ACL. The ACL itself is proven by its
 *  own test (`icacls` read back, secrets-file-backend.test.ts) and the Windows fence e2e. */
export function setWindowsAclForTests(fn: ((path: string) => Promise<void>) | undefined): void { windowsAclForTests = fn; }

export async function lockToOwner(path: string, deps: PrivateFileDeps = {}): Promise<void> {
  if ((deps.platform ?? process.platform) !== "win32") { chmodSync(path, 0o600); return; }
  if (windowsAclForTests !== undefined && deps.run === undefined) { await windowsAclForTests(path); return; }
  const sid = await userSidOf(deps);
  if (sid === undefined) throw new Error("no user SID for the file's ACL");
  const r = await system32(deps.run ?? bunRunner)(["icacls", path, "/inheritance:r", "/grant:r", `*${sid}:F`]);
  if (!r.ok) throw new Error("icacls refused the ACL");
}

const RENAME_RETRIES = 12;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const transient = (e: unknown) => ["EPERM", "EACCES", "EBUSY"].includes((e as NodeJS.ErrnoException).code ?? "");

/** Flushes one file's data and its length to the disk (fsync; on Windows `FlushFileBuffers`). */
export function flushFile(path: string): void {
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Flushes a folder's entries (a rename into it, a file gone from it): fsync of the folder on Linux and macOS. Windows
 *  cannot open a folder to flush it; there the renamed file is flushed instead (`renameDurably`). Only a file
 *  system that has no such flush (EINVAL, ENOTSUP) is let go; any other failure is the caller's. */
export function flushFolder(dir: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  const fd = openSync(dir, "r");
  try { fsyncSync(fd); }
  catch (e) { if (!["EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e; }
  finally { closeSync(fd); }
}

/** Renames `from` over `to` and does not return until the rename has been flushed as far as this OS lets a program ask:
 *   * Linux and macOS: `fsync` of the folder the name now lives in (and of the one it left, when they differ), which is
 *     what makes a rename survive a power cut.
 *   * Windows: Node's rename (`MoveFileExW` with REPLACE_EXISTING), then `FlushFileBuffers` on the renamed file
 *     (`fsync` of a handle opened on it). A folder cannot be flushed on Windows. Microsoft does not state that a rename
 *     is durable once its file is flushed, and `MOVEFILE_WRITE_THROUGH` is documented only for a move made as a copy and
 *     a delete (not a same-volume rename), so it is not claimed: what is relied on is that NTFS commits a file's pending
 *     metadata, its directory entry included, through its log when the file is flushed. The file's DATA was flushed before
 *     the rename either way, so a power cut leaves the old whole file or the new whole file, never a short one.
 *  Retried over the sharing errors Windows gives while another process holds either file. */
export async function renameDurably(from: string, to: string, deps: PrivateFileDeps = {}): Promise<void> {
  const platform = deps.platform ?? process.platform;
  for (let i = 0; ; i++) {
    try { assertLocksHeld(); renameSync(from, to); break; }
    catch (e) { if (!transient(e) || i >= RENAME_RETRIES) throw e; await sleep(25); }
  }
  deps.step?.("renamed");
  if (platform === "win32") flushFile(to);
  else {
    flushFolder(dirname(to), platform);
    if (dirname(from) !== dirname(to)) flushFolder(dirname(from), platform);
  }
  deps.step?.("rename-flushed");
}

/** Writes `data` to `path`: owner-only from the first byte, flushed to the disk before the rename that puts it in place,
 *  and the rename itself made durable (`renameDurably`). It returns only when a power cut can no longer take the new
 *  file back or leave a short one: the name holds the old whole file or the new whole file. (Windows: see `renameDurably`
 *  for what is and is not promised of the rename itself.) */
export async function writePrivateFile(path: string, data: Buffer | string, deps: PrivateFileDeps = {}): Promise<void> {
  const tmpDir = deps.tmpDir ?? dirname(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const tmp = join(tmpDir, `${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, "", { mode: 0o600, flag: "wx" }); // empty until it is locked down
    deps.step?.("created");
    await lockToOwner(tmp, deps);
    deps.step?.("locked");
    const fd = openSync(tmp, "r+"); // the same file, its ACL kept
    try {
      writeFileSync(fd, data);
      deps.step?.("written");
      fsyncSync(fd);
    } finally { closeSync(fd); }
    deps.step?.("file-flushed");
    await renameDurably(tmp, path, deps);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

let statImpl: (path: string) => unknown = (p) => statSync(p);
/** Tests only: what `present` stats with (a stat that throws EACCES or EIO). */
export function setSecretStatForTests(fn: ((path: string) => unknown) | undefined): void { statImpl = fn ?? ((p) => statSync(p)); }

/** Whether `path` is there. ONLY "no such file" (ENOENT, ENOTDIR) is absent: any other failure to look (a folder
 *  this process can't search, a disk error, a share gone) is not "absent" but `locked`, said plainly, so a store that
 *  can't be read now is never taken for one that was never made (and nothing is minted over it). */
export function present(path: string): boolean {
  try { statImpl(path); return true; }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new ContractError("locked", `MOSS can't look at ${basename(path)} right now (${code ?? "an error"}): saved logins stay locked until it can`);
  }
}

/** A read that survives the moment Windows holds a file being replaced. */
export async function readFileRetrying(path: string): Promise<Buffer> {
  for (let i = 0; ; i++) {
    try { return readFileSync(path); }
    catch (e) { if (!transient(e) || i >= RENAME_RETRIES) throw e; await sleep(25); }
  }
}

/** How long a lock may go without its holder renewing it before it is judged gone though its pid answers. A holder
 *  renews its lock every `LOCK_RENEW_MS` for as long as it holds it (a key fetched from a keyring that asks the person
 *  to unlock it takes as long as they do), so only a holder that stopped running loses it.
 *
 *  Who can write `run/` (and so plant a lock): the user's own processes, the daemon and the CLI; on Windows and Linux
 *  also a plugin's host half, which runs as the user (spec §5.2: trusted code). NOT bots' or agents' commands (the
 *  fence write-denies the run folder on every OS: `run-folder` in contracts/fence.ts), NOT the Windows pool accounts
 *  (a deny ACE on `run\`), NOT a macOS plugin host (its sandbox writes only its own folders). A planted lock blocks
 *  writes for at most `LOCK_STALE_MS` unless its planter keeps renewing it, which only a process of the user can do. */
export const LOCK_STALE_MS = 120_000;
/** How often a holder renews its lock. */
export const LOCK_RENEW_MS = 20_000;
/** A lock dated later than now by more than this is judged stale (a clock does not run backwards that far). */
const LOCK_FUTURE_SLACK_MS = 5_000;
/** How long a writer waits for the lock before it says the file is busy. */
export const LOCK_WAIT_MS = 30_000;

const inProcess = new Map<string, Promise<unknown>>();

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The lock's text when it is stale, else null. */
function staleText(lockPath: string, now: number): string | null {
  let text: string;
  try { text = readFileSync(lockPath, "utf8"); } catch { return null; } // gone, or being made: not ours to judge
  const [pidText, atText] = text.split("\n"); // a third line, the holder's nonce, is not judged
  const pid = Number(pidText), at = Number(atText);
  const judged = !Number.isInteger(pid) || pid <= 0 || !Number.isFinite(at)
    ? now - lockMtime(lockPath, now) > 5_000 // a lock still being written is young
    : !alive(pid) || now - at > LOCK_STALE_MS || at - now > LOCK_FUTURE_SLACK_MS;
  return judged ? text : null;
}

/** Removes a stale lock, but only while it still holds the text it was judged by: two waiters that both judge one lock
 *  stale must not each remove the lock the other just made (the window left is the gap between this read and the
 *  remove, and only a crashed holder opens it). */
function takeOver(lockPath: string, judged: string): void {
  try { if (readFileSync(lockPath, "utf8") === judged) rmSync(lockPath, { force: true }); } catch { /* gone already */ }
}

function lockMtime(lockPath: string, now: number): number {
  try { return statSync(lockPath).mtimeMs; } catch { return now; }
}

/** The locks the work under way holds (outermost first), so a write inside it can check before each rename that every
 *  one is still its own (lane SE review: a holder paused past `LOCK_STALE_MS`, a lid closed during a keyring prompt or a
 *  suspended VM, is taken over; when it resumes, its read-change-write must not land over the new holder's). */
// A lease is checked only while its hold lasts: work started inside the hold that runs on after it ends (a change
// listener, a note written without waiting) inherits the store, and is not refused once the lock is let go.
const heldLocks = new AsyncLocalStorage<readonly { path: string; stillMine: () => boolean; released: boolean }[]>();

/** Throws `locked` when the work under way lost any lock it holds: the write is dropped, never put over a newer one. */
export function assertLocksHeld(): void {
  for (const l of heldLocks.getStore() ?? []) {
    if (!l.released && !l.stillMine()) throw new ContractError("locked", `this process lost the lock ${basename(l.path)} while it was paused: its write was dropped, so a newer one is never overwritten`);
  }
}

async function takeFileLock(lockPath: string, waitMs: number, renewMs: number): Promise<{ release: () => Promise<void>; stillMine: () => boolean }> {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      const nonce = randomBytes(6).toString("hex");
      let mine = `${process.pid}\n${Date.now()}\n${nonce}\n`;
      try { writeFileSync(fd, mine); } finally { closeSync(fd); }
      // Whether the lock still holds this holder's text. A sharing error Windows gives for a moment (a waiter reading the
      // lock to judge it) is read again, never taken for "lost"; a lock that is gone or another's is lost.
      const stillMine = () => {
        for (let i = 0; ; i++) {
          try { return readFileSync(lockPath, "utf8") === mine; }
          catch (e) { if (!transient(e) || i >= RENAME_RETRIES) return false; Bun.sleepSync(5); }
        }
      };
      // Renewed while held, and only while it is still this holder's (one taken over is never written over).
      const renew = setInterval(() => {
        if (!stillMine()) return;
        const next = `${process.pid}\n${Date.now()}\n${nonce}\n`;
        // Written whole under another name and renamed over the lock, never in place (a half-written lock is no one's).
        const tmp = `${lockPath}.${nonce}.renew`;
        try { writeFileSync(tmp, next, { mode: 0o600 }); if (!stillMine()) { rmSync(tmp, { force: true }); return; } renameSync(tmp, lockPath); mine = next; }
        catch { rmSync(tmp, { force: true }); /* the next tick tries again */ }
      }, renewMs);
      renew.unref?.();
      return { stillMine, release: async () => {
        clearInterval(renew);
        // Only a lock whose text is still this holder's is removed: one taken over is the new holder's.
        // Windows may hold the file for a moment (a waiter reading it to judge it): retried, never left behind.
        for (let i = 0; i < RENAME_RETRIES; i++) {
          if (!stillMine()) return;
          try { rmSync(lockPath, { force: true }); return; } catch (err) { if (!transient(err)) throw err; await sleep(25); }
        }
      } };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && !(code === "EPERM" || code === "EACCES")) throw e;
      const judged = code === "EEXIST" ? staleText(lockPath, Date.now()) : null;
      if (judged !== null) { takeOver(lockPath, judged); continue; }
      if (Date.now() - started > waitMs) throw new ContractError("locked", "another MOSS process is writing the secrets file and did not finish");
      await sleep(15);
    }
  }
}

/** Runs `fn` with the secrets file's lock held: one at a time in this process, then one at a time across processes. */
export async function withSecretsLock<T>(lockPath: string, fn: () => Promise<T>, waitMs: number = LOCK_WAIT_MS, renewMs: number = LOCK_RENEW_MS): Promise<T> {
  const before = inProcess.get(lockPath) ?? Promise.resolve();
  const run = before.then(async () => {
    const lock = await takeFileLock(lockPath, waitMs, renewMs);
    const lease = { path: lockPath, stillMine: lock.stillMine, released: false };
    try { return await heldLocks.run([...(heldLocks.getStore() ?? []), lease], fn); }
    finally { lease.released = true; await lock.release(); }
  });
  const tail = run.catch(() => undefined);
  inProcess.set(lockPath, tail);
  void tail.then(() => { if (inProcess.get(lockPath) === tail) inProcess.delete(lockPath); });
  return run;
}
