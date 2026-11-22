// What the secrets file needs from the disk (spec §9.1; spike S8's "M1 must pin ... atomic writes"):
//   * `writePrivateFile`: a file only its owner can read, never readable by anyone else even for a moment, replaced
//     atomically. It is made empty under a temporary name, locked down (0600; on Windows the inherited entries dropped
//     and the user's SID alone granted, `icacls`, as `platform/pair/run-files.ts` does for the app token), then written
//     and renamed into place, so a reader sees the old file or the new one, never half of one. Windows refuses a
//     rename over a file another process has open for a moment: it is retried briefly.
//   * `withSecretsLock`: one writer at a time across the processes of this user (the daemon, the CLI when the daemon is
//     down, `moss doctor`) and inside one process. The file is read, changed and written whole, so two unlocked
//     writers lose an update. The lock is a file made with `wx` holding the holder's pid and the time; one whose pid is
//     gone, or that is far older than any write takes, is taken over.
// No value passes through here but the bytes the caller hands `writePrivateFile`; nothing is logged.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ContractError } from "../contracts/common";
import { bunRunner, windowsUserSid, type Runner } from "../platform/login/live";

export interface PrivateFileDeps {
  /** Defaults to this process's platform. */
  platform?: NodeJS.Platform;
  /** Windows: runs `icacls`. */
  run?: Runner;
  /** Windows: the user's SID; read with `whoami` when not given. */
  userSid?: string;
}

let sidMemo: Promise<string | undefined> | undefined;
async function userSidOf(deps: PrivateFileDeps): Promise<string | undefined> {
  if (deps.userSid !== undefined) return deps.userSid;
  sidMemo ??= windowsUserSid(deps.run ?? bunRunner).then((s) => { if (s === undefined) sidMemo = undefined; return s; });
  return sidMemo;
}

/** Locks `path` (a file or a folder that exists) to the user alone. Throws when the OS will not: a secret is never
 *  written under an ACL that anyone else's inherited entry could widen. */
export async function lockToOwner(path: string, deps: PrivateFileDeps = {}): Promise<void> {
  if ((deps.platform ?? process.platform) !== "win32") { chmodSync(path, 0o600); return; }
  const sid = await userSidOf(deps);
  if (sid === undefined) throw new Error("no user SID for the file's ACL");
  const r = await (deps.run ?? bunRunner)(["icacls", path, "/inheritance:r", "/grant:r", `*${sid}:F`]);
  if (!r.ok) throw new Error("icacls refused the ACL");
}

const RENAME_RETRIES = 12;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const transient = (e: unknown) => ["EPERM", "EACCES", "EBUSY"].includes((e as NodeJS.ErrnoException).code ?? "");

/** Writes `data` to `path`: owner-only from the first byte, atomically replacing what is there. */
export async function writePrivateFile(path: string, data: Buffer | string, deps: PrivateFileDeps = {}): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, "", { mode: 0o600, flag: "wx" }); // empty until it is locked down
    await lockToOwner(tmp, deps);
    writeFileSync(tmp, data, { flag: "r+" }); // the same file, its ACL kept
    for (let i = 0; ; i++) {
      try { renameSync(tmp, path); break; }
      catch (e) { if (!transient(e) || i >= RENAME_RETRIES) throw e; await sleep(25); }
    }
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** A read that survives the moment Windows holds a file being replaced. */
export async function readFileRetrying(path: string): Promise<Buffer> {
  for (let i = 0; ; i++) {
    try { return readFileSync(path); }
    catch (e) { if (!transient(e) || i >= RENAME_RETRIES) throw e; await sleep(25); }
  }
}

/** How long a holder may keep the lock before it is judged gone though its pid answers (a write takes milliseconds;
 *  a key fetched from a keyring that asks the person to unlock it takes as long as they do). */
export const LOCK_STALE_MS = 120_000;
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
  const [pidText, atText] = text.split("\n");
  const pid = Number(pidText), at = Number(atText);
  const judged = !Number.isInteger(pid) || pid <= 0 || !Number.isFinite(at)
    ? now - lockMtime(lockPath, now) > 5_000 // a lock still being written is young
    : !alive(pid) || now - at > LOCK_STALE_MS;
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

async function takeFileLock(lockPath: string, waitMs: number): Promise<() => Promise<void>> {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try { writeFileSync(fd, `${process.pid}\n${Date.now()}\n`); } finally { closeSync(fd); }
      return async () => {
        // Windows may hold the file for a moment (a waiter reading it to judge it): retried, never left behind.
        for (let i = 0; i < RENAME_RETRIES; i++) {
          try { rmSync(lockPath, { force: true }); return; } catch (err) { if (!transient(err)) throw err; await sleep(25); }
        }
      };
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
export async function withSecretsLock<T>(lockPath: string, fn: () => Promise<T>, waitMs: number = LOCK_WAIT_MS): Promise<T> {
  const before = inProcess.get(lockPath) ?? Promise.resolve();
  const run = before.then(async () => {
    const release = await takeFileLock(lockPath, waitMs);
    try { return await fn(); } finally { await release(); }
  });
  const tail = run.catch(() => undefined);
  inProcess.set(lockPath, tail);
  void tail.then(() => { if (inProcess.get(lockPath) === tail) inProcess.delete(lockPath); });
  return run;
}
