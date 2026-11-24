// What an "Erase everything" started from the app came to (the deletion lane). The engine erases after it has stopped,
// where nothing can answer the app, and its log goes with the home. So the app decides what to say at its next open from
// what it can check itself on the disk, in its own fixed words, and shows nothing taken from any file.
//
// Why a disk check and not a record: no place survives the erase that a runner can't write. The fence write-denies the
// MOSS home to every runner on all three systems (`fence.ts` `policy()`: `denyWrite` holds the home), and the erase
// removes that home; the user's home folder and the apps' own data folders are in every runner's `allowWrite`; Electron's
// safeStorage is no guard on Windows (DPAPI: any process of the user) or on Linux (it can fall back to plain text).
//
// The signal that an erase ran: `<home>-erased`, beside the home, an empty file the engine writes by temp file and rename
// (packages/core `deletion/erase-home.ts`, `writeEraseSignal`). It carries nothing that is shown. It is taken only when it
// is a regular file owned by this user (never a link, which is removed unread), and removed once read. A runner that plants
// one makes the app say only what the disk shows: whether the home is gone, and which kinds of MOSS data are still in it,
// named from a fixed list.
import { lstatSync, readdirSync, unlinkSync, type Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** The engine's own suffix (`ERASE_SIGNAL_SUFFIX`). */
export const ERASE_SIGNAL_SUFFIX = "-erased";

export function eraseSignalPath(home: string): string {
  const h = resolve(home);
  return join(dirname(h), `${basename(h)}${ERASE_SIGNAL_SUFFIX}`);
}

/** Whether the engine left the signal; it is removed either way, and a link or anything not a plain file of this user's
 *  counts as none. */
export function takeEraseSignal(home: string, uid: number | undefined = process.getuid?.()): boolean {
  const path = eraseSignalPath(home);
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch {
    return false;
  }
  const ok = st.isFile() && !st.isSymbolicLink() && (uid === undefined || st.uid === uid);
  try {
    // Removes the name itself: a link goes, its target is never touched.
    unlinkSync(path);
  } catch {
    // Not ours to remove: shown as none.
    return false;
  }
  return ok;
}

/** The kinds of MOSS data the app names when they are still in the home: a top-level name to the app's own words. */
const KINDS: Record<string, string> = {
  bots: "bots and their memory",
  transcripts: "conversations",
  sessions: "conversations",
  "sessions-runtime": "conversations",
  scratch: "bots' files",
  routines: "routines",
  plugins: "plugins",
  "plugin-data": "plugins",
  settings: "settings",
  "settings.json": "settings",
  logs: "logs",
  audit: "logs",
};

export interface ShownOutcome {
  ok: boolean;
  message: string;
  detail: string;
}

/** The app's own words for what the disk shows now. Read before the engine starts (which makes a new home). */
export function eraseOutcomeOnDisk(home: string): ShownOutcome {
  let names: string[];
  try {
    names = readdirSync(home);
  } catch {
    return { ok: true, message: "Everything MOSS kept on this computer was erased.", detail: "MOSS starts fresh now. The apps themselves stay until you uninstall them." };
  }
  if (names.length === 0) return { ok: true, message: "Everything MOSS kept on this computer was erased.", detail: "MOSS starts fresh now. The apps themselves stay until you uninstall them." };
  const kinds = [...new Set(names.map((n) => KINDS[n] ?? "other files"))].sort();
  return {
    ok: false,
    message: "MOSS couldn't erase everything.",
    detail: `Still on this computer: ${kinds.join(", ")}. You can try Erase everything again in Settings, or remove MOSS's folder by hand.`,
  };
}
