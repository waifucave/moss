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

interface TombstoneFile {
  v: 1;
  bots: Record<string, number>;
  sessions: Record<string, number>;
  /** A bot's main conversation, deleted and opened again empty under the same id: records older than this are refused. */
  conversations: Record<string, number>;
}

const ID_RE = /^[A-Za-z0-9_./:@-]{1,200}$/;
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
  const clean = (o: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) if (ID_RE.test(k) && typeof v === "number") out[k] = v;
    return out;
  };
  const file: TombstoneFile = { v: 1, bots: clean(raw?.bots), sessions: clean(raw?.sessions), conversations: clean(raw?.conversations) };
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, file });
  return file;
}

function write(home: string, file: TombstoneFile): void {
  writeJsonAtomic(tombstonePath(home), file);
  cache.delete(tombstonePath(home));
}

export function isDeletedBot(home: string, bot: string): boolean {
  return Object.hasOwn(read(home).bots, bot);
}

export function isDeletedSession(home: string, id: string): boolean {
  return Object.hasOwn(read(home).sessions, id);
}

/** Written BEFORE anything is removed, so a sync that lands in the middle is already refused. */
export function tombstoneBot(home: string, bot: string, at: number): void {
  if (!ID_RE.test(bot)) return;
  const f = read(home);
  write(home, { ...f, bots: { ...f.bots, [bot]: at } });
}

export function tombstoneSessions(home: string, ids: readonly string[], at: number): void {
  const add = ids.filter((id) => ID_RE.test(id));
  if (add.length === 0) return;
  const f = read(home);
  const sessions = { ...f.sessions };
  for (const id of add) sessions[id] = at;
  write(home, { ...f, sessions });
}

/** A bot's main conversation, deleted here and opened again empty under the same id: what was written before `at`
 *  is refused from now on, what the bot writes after it is the new conversation. */
export function tombstoneConversation(home: string, id: string, at: number): void {
  if (!ID_RE.test(id)) return;
  const f = read(home);
  write(home, { ...f, conversations: { ...f.conversations, [id]: at } });
}

/** Whether records of session `id` written at `ts` (the oldest of a batch) are of something deleted here. */
export function refusedSessionRecords(home: string, id: string, bot: string | undefined, oldestTs: number | undefined): boolean {
  const f = read(home);
  if (Object.hasOwn(f.sessions, id)) return true;
  if (bot !== undefined && Object.hasOwn(f.bots, bot)) return true;
  const at = f.conversations[id];
  return at !== undefined && (oldestTs === undefined || oldestTs < at);
}
