// What is kept beside a session's transcript, by its id (the deletion lane, item 3): deleted with it. Found by searching
// every place a session id names a file under the home (and the one outside it, the staged images' temp folder):
//
// | Where                                                     | What                                         |
// | :-------------------------------------------------------- | :------------------------------------------- |
// | `transcripts/<bot or _>/<stem>.ndjson`, `.meta.json`      | the log and meta (the host deletes these)    |
// | `sessions-runtime/<id>.json`, `.stderr.log`, `.stderr.log.1` | a bot session's driver state, its runtime's stderr |
// | the runtime's own transcript, `sdk/projects/…`            | by the backend id the driver state names     |
// | `agents/<id>/` or `bots/<bot>/agents/<id>/`               | an agent session's ACP transcript            |
// | `scratch/_/<stem>/`                                       | a session with no bot: its working files     |
// | `outputs/<id>/`, `diffs/<id>/`                            | its outputs and captured diffs               |
// | `<tmp>/<id>/` (`sessionTmpDirPath`)                       | images staged for it                         |
// | `<home>-received/<id>/` (`receivedRootOf`)                | files a paired phone sent to a coding session (beside the home) |
// | `runtime-state.db`                                        | its runtime rows (the runtime's own §16 deletion) |
//
// A bot's scratch folder and memory are the bot's, not one conversation's: they stay (deleting the bot removes them).
// Before anything is removed the session is written to a journal (`transcripts/deleting.json`), so a stop in the middle
// is finished at the next start (`finishSessionDeletions`); nothing here follows a link (each path is removed as itself).
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionScratchDir } from "../bots/paths";
import { transcriptPaths } from "../agents/transcript";
import { sessionTmpDirPath } from "../agent/session-tmp";
import { outdirPath } from "../sessions/outdir";
import { diffDirPath } from "../diffs/store";
import { transcriptsDir } from "../sessions/ids";
import { receivedRootOf } from "../bots/staged-files";
import { runtimeStderrPath } from "../runtime-sdk/turn-loop/runtime-stderr";

export interface DeletedSession {
  id: string;
  bot?: string;
  kind: string;
}

export interface SessionFileDeps {
  home: string;
  /** Deletes the runtime's own transcript by its backend id (`mossSessions(home).deleteSession`). */
  deleteRuntimeTranscript?(backendSessionId: string): Promise<unknown>;
  /** The runtime state's rows for the session (`runtime.onSessionDeleted`). */
  onRuntimeRows?(sessionId: string): void;
  log?(line: string): void;
}

const JOURNAL = "deleting.json";
const journalPath = (home: string) => join(transcriptsDir(home), JOURNAL);
const driverStem = (id: string) => id.replace(/[^A-Za-z0-9._-]/g, "_");

function readJournal(home: string): DeletedSession[] {
  try {
    const v = JSON.parse(readFileSync(journalPath(home), "utf8")) as unknown;
    return Array.isArray(v) ? (v as DeletedSession[]).filter((x) => x && typeof x.id === "string") : [];
  } catch {
    return [];
  }
}

function writeJournal(home: string, sessions: DeletedSession[]): void {
  if (sessions.length === 0) {
    rmSync(journalPath(home), { force: true });
    return;
  }
  mkdirSync(transcriptsDir(home), { recursive: true });
  const tmp = `${journalPath(home)}.tmp`;
  writeFileSync(tmp, JSON.stringify(sessions), { mode: 0o600 });
  renameSync(tmp, journalPath(home));
}

/** Writes the sessions about to be deleted into the journal, before anything of theirs is removed. */
export function journalSessionDeletion(home: string, sessions: DeletedSession[]): void {
  const have = readJournal(home);
  writeJournal(home, [...have, ...sessions.filter((s) => !have.some((h) => h.id === s.id))]);
}

/** Removes a path as itself (a link is removed, never followed); absent is fine. */
function removePath(path: string): void {
  try {
    lstatSync(path);
  } catch {
    return;
  }
  rmSync(path, { recursive: true, force: true });
}

/** Every path kept beside one session, besides its log and meta. */
export function sessionSidePaths(home: string, s: DeletedSession): string[] {
  const paths = [join(home, "sessions-runtime", `${driverStem(s.id)}.json`), runtimeStderrPath(home, s.id), `${runtimeStderrPath(home, s.id)}.1`];
  // Each of these refuses an id it could never have made a folder for: then there is nothing of it to remove.
  const tryAdd = (make: () => string) => {
    try {
      paths.push(make());
    } catch {
      // never made
    }
  };
  tryAdd(() => outdirPath(home, s.id));
  tryAdd(() => diffDirPath(home, s.id));
  tryAdd(() => transcriptPaths(home, s.id, s.bot).dir);
  tryAdd(() => sessionTmpDirPath(s.id));
  // A coding session's files from a paired phone, in their folder beside the home (lane PH's `staged-files.ts`).
  if (/^[A-Za-z0-9_-]{1,96}$/.test(s.id)) tryAdd(() => join(receivedRootOf(home), s.id));
  if (s.bot === undefined) tryAdd(() => sessionScratchDir(home, { id: s.id }));
  return paths;
}

/** Removes what is kept beside each deleted session, then takes it off the journal. */
export async function removeSessionFiles(deps: SessionFileDeps, sessions: DeletedSession[]): Promise<void> {
  for (const s of sessions) {
    // The runtime's own transcript, by the backend id the driver kept: read before its state file goes.
    try {
      const raw = JSON.parse(readFileSync(join(deps.home, "sessions-runtime", `${driverStem(s.id)}.json`), "utf8")) as { backendSessionId?: unknown };
      if (typeof raw.backendSessionId === "string" && /^[0-9a-f-]{36}$/.test(raw.backendSessionId)) await deps.deleteRuntimeTranscript?.(raw.backendSessionId).catch(() => undefined);
    } catch {
      // No driver state: no runtime transcript.
    }
    for (const p of sessionSidePaths(deps.home, s)) {
      try {
        removePath(p);
      } catch (err) {
        deps.log?.(`[sessions] ${s.id}: a file beside it wasn't removed (${err instanceof Error ? err.name : "error"}); tried again at the next start`);
        throw err;
      }
    }
    try {
      deps.onRuntimeRows?.(s.id);
    } catch {
      // The runtime's own deletion logs its failures.
    }
    writeJournal(deps.home, readJournal(deps.home).filter((x) => x.id !== s.id));
  }
}

/** At start: finishes every session deletion a stop cut short. Never throws. */
export async function finishSessionDeletions(deps: SessionFileDeps): Promise<number> {
  if (!existsSync(journalPath(deps.home))) return 0;
  const left = readJournal(deps.home);
  try {
    await removeSessionFiles(deps, left);
  } catch {
    // Left in the journal for the next start.
  }
  return left.length;
}
