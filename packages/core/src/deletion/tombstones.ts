// What the person deleted on this computer, kept so it never comes back (the deletion lane; the review of f836c1544,
// blocker 2). A deleted bot's memory and a deleted session's records reach this computer again from the person's other
// computers, which still hold their copies: memory sync (`sync/memory.ts`) and session-record sync
// (`sync/session-records.ts`) take whatever a paired computer pushes. With this file they refuse anything of a deleted
// bot or session, at every door (push, pull, catch-up, mail), and never list it in their heads.
//
// What it does NOT do: tell the other computers. They keep their copies until the person deletes the bot or the
// session there too; the cards and the docs say so ("deleted from this computer").
//
// `<home>/deleted.json`: `{v: 1, bots: {<id>: <ms>}, sessions: {<id>: <ms>}, conversations: {<id>: <ms>}}`. Ids only,
// never a name or a title, kept for as long as the home. A deleted bot's id is never given to a new bot (records.ts
// `#taken`), and session ids are never given again, so nothing new is ever caught by an old tombstone; a bot's main
// conversation, which opens again empty under its id, is refused only what was written before its deletion.
import { statSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJsonAtomic } from "../sessions/atomic-file";
import { ContractError } from "../contracts/common";

interface TombstoneFile {
  v: 1;
  /** The file is there but can't be read or parsed: everything counts as deleted (sync refuses it all) until it is
   *  fixed, and no deletion writes over it. */
  damaged?: true;
  bots: Record<string, number>;
  sessions: Record<string, number>;
  /** A bot's main conversation, deleted and opened again empty under the same id: records older than this are refused. */
  conversations: Record<string, number>;
}

const ID_RE = /^[A-Za-z0-9_./:@-]{1,200}$/;
/** A session's or a bot's id as the engine makes them: the characters above, and no empty, `.` or `..` part. */
const validId = (id: string): boolean => ID_RE.test(id) && !id.split("/").some((p) => p === "" || p === "." || p === "..");
const cache = new Map<string, { mtimeMs: number; size: number; file: TombstoneFile }>();

export function tombstonePath(home: string): string {
  return join(home, "deleted.json");
}

function read(home: string): TombstoneFile {
  const path = tombstonePath(home);
  let st: { mtimeMs: number; size: number };
  try {
    st = statSync(path);
  } catch {
    return { v: 1, bots: {}, sessions: {}, conversations: {} };
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.file;
  const raw = readJson(path) as Partial<TombstoneFile> | undefined;
  if (raw === undefined || raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    const damaged: TombstoneFile = { v: 1, damaged: true, bots: {}, sessions: {}, conversations: {} };
    cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, file: damaged });
    return damaged;
  }
  const clean = (o: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) if (validId(k) && typeof v === "number") out[k] = v;
    return out;
  };
  const file: TombstoneFile = { v: 1, bots: clean(raw?.bots), sessions: clean(raw?.sessions), conversations: clean(raw?.conversations) };
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, file });
  return file;
}

/** Why the record of what was deleted can't be trusted now, or undefined: shown by `moss doctor`, logged by the syncs. */
export function tombstoneProblem(home: string): string | undefined {
  return read(home).damaged ? `${tombstonePath(home)} can't be read: memory and conversation sync is refused until it is fixed or removed (removing it lets deleted bots' memory and sessions come back from your other computers)` : undefined;
}

/** Throws before anything is deleted: an id the record can't hold, or a damaged record. */
function writable(home: string, ids: readonly string[]): TombstoneFile {
  for (const id of ids) if (!validId(id)) throw new ContractError("invalid", "that id can't be recorded as deleted; nothing was deleted");
  const f = read(home);
  if (f.damaged) throw new ContractError("failed", "the record of what was deleted here can't be read (moss doctor says more); nothing was deleted");
  return f;
}

function write(home: string, file: TombstoneFile): void {
  writeJsonAtomic(tombstonePath(home), file);
  cache.delete(tombstonePath(home));
}

export function isDeletedBot(home: string, bot: string): boolean {
  const f = read(home);
  return f.damaged === true || Object.hasOwn(f.bots, bot);
}

export function isDeletedSession(home: string, id: string): boolean {
  const f = read(home);
  return f.damaged === true || Object.hasOwn(f.sessions, id);
}

/** Written BEFORE anything is removed, so a sync that lands in the middle is already refused. */
export function tombstoneBot(home: string, bot: string, at: number): void {
  const f = writable(home, [bot]);
  write(home, { ...f, bots: { ...f.bots, [bot]: at } });
}

export function tombstoneSessions(home: string, ids: readonly string[], at: number): void {
  const f = writable(home, ids);
  const add = [...ids];
  if (add.length === 0) return;
  const sessions = { ...f.sessions };
  for (const id of add) sessions[id] = at;
  write(home, { ...f, sessions });
}

/** A bot's main conversation, deleted here and opened again empty under the same id: what was written before `at`
 *  is refused from now on, what the bot writes after it is the new conversation. */
export function tombstoneConversation(home: string, id: string, at: number): void {
  const f = writable(home, [id]);
  write(home, { ...f, conversations: { ...f.conversations, [id]: at } });
}

/** Whether records of session `id` written at `ts` (the oldest of a batch) are of something deleted here. */
export function refusedSessionRecords(home: string, id: string, bot: string | undefined, oldestTs: number | undefined): boolean {
  const f = read(home);
  if (f.damaged) return true;
  if (Object.hasOwn(f.sessions, id)) return true;
  if (bot !== undefined && Object.hasOwn(f.bots, bot)) return true;
  const at = f.conversations[id];
  return at !== undefined && (oldestTs === undefined || oldestTs < at);
}
