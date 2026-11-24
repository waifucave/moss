// What an "Erase everything" came to (the deletion lane). The engine erases after it has stopped and leaves a text-free
// signal beside the home; its next start, whichever app started it, is the signal's only reader (packages/core
// `deletion/erase-home.ts`, `takeEraseSignalAtStart`). It decides from a marker it keeps inside the home (removed first by
// an erase; the home is write-denied to every runner): with the marker there the home is healthy and nothing is said;
// without it, "erased" or "partial" with the kinds of MOSS data left. It writes that result inside the home
// (`run/erase-result.json`), where no runner can write, and MOSS shows it once, in its own fixed words, when it connects.
// Nothing from any file is shown: only the result's known values pick among the app's sentences.
import { lstatSync, readFileSync, unlinkSync, type Stats } from "node:fs";
import { join } from "node:path";

export function eraseResultPath(home: string): string {
  return join(home, "run", "erase-result.json");
}

/** The engine's kinds (`ERASE_LEFT_KINDS`) in the app's words; an unknown value is never shown. */
const KIND_WORDS: Record<string, string> = {
  bots: "bots and their memory",
  conversations: "conversations",
  files: "bots' files",
  routines: "routines",
  plugins: "plugins",
  settings: "settings",
};

export interface ShownOutcome {
  ok: boolean;
  message: string;
  detail: string;
}

/** The result, once: read and removed; undefined when there is none, or it isn't a plain file of this user's. */
export function takeEraseResult(home: string, uid: number | undefined = process.getuid?.()): ShownOutcome | undefined {
  const path = eraseResultPath(home);
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch {
    return undefined;
  }
  let raw = "";
  const ok = st.isFile() && !st.isSymbolicLink() && (uid === undefined || st.uid === uid) && st.size <= 4096;
  try {
    if (ok) raw = readFileSync(path, "utf8");
    unlinkSync(path);
  } catch {
    return undefined;
  }
  if (!ok) return undefined;
  let r: { result?: unknown; left?: unknown };
  try {
    r = JSON.parse(raw) as typeof r;
  } catch {
    return undefined;
  }
  if (r.result === "erased") return { ok: true, message: "Everything MOSS kept on this computer was erased.", detail: "MOSS starts fresh now. The apps themselves stay until you uninstall them." };
  if (r.result !== "partial") return undefined;
  const words = [...new Set((Array.isArray(r.left) ? r.left : []).flatMap((k) => (typeof k === "string" && Object.hasOwn(KIND_WORDS, k) ? [KIND_WORDS[k]!] : [])))];
  return {
    ok: false,
    message: "MOSS couldn't erase everything.",
    detail: words.length > 0 ? `Still on this computer: ${words.join(", ")}. You can try Erase everything again in Settings.` : "Some of it is still on this computer. You can try Erase everything again in Settings.",
  };
}
