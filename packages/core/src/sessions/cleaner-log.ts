import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { appendRotating } from "../append-log";

/** session-activity-hygiene T6 (spec §2): one audit line per session the empty-session reaper (and,
 *  T7, the session cleaner) deletes: how many were deleted, when and why. No title (the deletion lane, item 6): a
 *  session's title is made from what the person wrote, and a record of a deleted session must not keep it. The line is
 *  built field by field, so nothing else a caller passes reaches it. */
export interface CleanerLogEntry {
  sessionId: string;
  reason: string;
  date: string;
}

/** Appends one NDJSON line to `<home>/cleaner.jsonl`, creating the file (and `home`, defensively —
 *  the same `mkdirSync(..., {recursive:true})` precedent `SessionStore`'s own constructor uses) if
 *  missing. `home` is a parameter — never a global/mossHome import — so every caller, test
 *  included, stays temp-home-safe.
 *
 *  Deliberately NOT best-effort itself: this throws like any other fs call (ENOSPC, permissions, a
 *  read-only home, …). The CALLER decides whether a failed write should stop anything — the
 *  reaper's own rule (reaper.ts) is that it never does: the delete this logs already happened, and a
 *  missing audit line is a logged warning, not a reason to undo or retry the delete. Keeping the
 *  throw here (rather than swallowing it internally) is what lets that caller-side contract be
 *  tested on its own terms, and gives T7's cleaner the identical seam to wrap the same way. */
export function appendCleanerLog(home: string, entry: CleanerLogEntry): void {
  mkdirSync(home, { recursive: true });
  const line = { sessionId: entry.sessionId, reason: entry.reason, date: entry.date };
  appendRotating(join(home, "cleaner.jsonl"), JSON.stringify(line) + "\n");
}
