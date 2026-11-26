// One spelling for a path a DENY check compares (the control-plane, the sdk store, the project-rule guard, the plugin holders).
//
// A deny check that compares two spellings of one place and finds them different lets the path through. On Windows one place
// has many spellings: `C:\Users\me`, `c:/users/ME`, `C:\Users\RUNNER~1` (8.3), `C:\Users\me.` (a trailing dot or space is dropped by
// the OS), `\\?\C:\Users\me` (the extended prefix). This brings both sides to one: the prefix gone, an 8.3 short name expanded by
// `GetLongPathNameW` on the nearest existing ancestor (it follows no link, so the asked path keeps its own spelling: a deny written
// on a junction's name still matches the junction), then every name folded with the trailing dots and spaces dropped and `/` between.
// Elsewhere it is the lowercase every one of these checks always used, so nothing changes off Windows.
import { win32 } from "node:path";
import { foldPath } from "../contracts/fence";
import { getLongPathName } from "../platform/long-name";

export interface SpellingOptions {
  /** Default: this machine. A test says it. */
  win32?: boolean;
  /** Default: `GetLongPathNameW`. A test hands a fake. */
  long?: (path: string) => string | null;
}

/** What a spelling that can't be judged folds to: inside every root (as `TOO_MANY_LINKS` is in agents/memory.ts), so a deny
 *  check refuses it on its own. A path that starts with two separators after the prefix is gone (`\\?\UNC\x`, `\\localhost\C$\x`,
 *  `\\.\GLOBALROOT\x`, `\\?\Volume{..}\x`), a stream or an alternate name the fold doesn't know, a long-name lookup that
 *  found nothing on the way up, or an 8.3 name left in the part that doesn't exist yet. */
export const UNJUDGEABLE = "\u0000unjudgeable";

// An 8.3 name is at most 8 characters before the dot (the base, `~`, digits) and at most 3 after it. `run~2024.log` has that shape too
// (and is refused: fail closed); `release~2024.log` and `notes~1.md.bak` do not.
const SHORT_NAME = /^(?=[^.\\]{2,8}(?:\.|$))[^.\\]{1,6}~\d+(?:\.[^.\\]{0,3})?$/;

/** The long form of the nearest existing ancestor of `path`, with the names below it as they were spelled; undefined when none
 *  of them could be looked up, or a `~N` short name is left in the part that is not there (a name the lookup could not expand). */
function expandShort(path: string, long: (p: string) => string | null): string | undefined {
  let head = path;
  let tail = "";
  for (let i = 0; i < 128; i++) {
    const found = long(head);
    if (found !== null) {
      const names = tail.split("\\").filter((n) => n !== "");
      // Only a name in the 8.3 shape (`PROGRA~1`, `NOTES~1.MD`) is a short name the lookup could not expand; `run~2024.log` is not.
      if (names.some((n) => SHORT_NAME.test(n))) return undefined;
      return names.length === 0 ? found : win32.join(found, ...names);
    }
    const parent = win32.dirname(head);
    if (parent === head) return undefined;
    tail = `\\${win32.basename(head)}${tail}`;
    head = parent;
  }
  return undefined;
}

/** NTFS stream and alternate-name spellings, per name after the drive: `name::$DATA` is the file, `name:$I30:$INDEX_ALLOCATION`
 *  (or `name::$INDEX_ALLOCATION`) is the folder `name`; any other `:` is a stream or a spelling not known here (undefined). */
function withoutStreams(path: string): string | undefined {
  const m = /^([A-Za-z]:)(.*)$/s.exec(path);
  if (m === null) return path.includes(":") ? undefined : path;
  const names = m[2]!.split(/[\\/]/).filter((n) => n !== "").map((n) => n.replace(/::\$DATA$/i, "").replace(/:(?:\$I30)?:\$INDEX_ALLOCATION$/i, ""));
  if (names.some((n) => n.includes(":"))) return undefined;
  return m[1] + m[2]!.replace(/[^\\/]+/g, () => names.shift()!);
}

export function foldedSpelling(path: string, o: SpellingOptions = {}): string {
  if (!(o.win32 ?? process.platform === "win32")) return path.toLowerCase();
  // `\\?\C:\x`, `\\.\C:\x` and `\??\C:\x` name the same place as `C:\x`.
  const bare = path.replace(/^(?:\\\\[?.]\\|\\\?\?\\|\/\/[?.]\/)(?=[A-Za-z]:)/, "");
  if (/^[\\/]{2}/.test(bare)) return UNJUDGEABLE;
  const plain = withoutStreams(bare);
  if (plain === undefined) return UNJUDGEABLE;
  const long = expandShort(plain, o.long ?? getLongPathName);
  if (long === undefined) return UNJUDGEABLE;
  return foldPath(long, "windows");
}

/** `inside` for two paths of the same machine, both sides through `foldedSpelling`; an unjudgeable side is inside everything. */
export function insideFolded(path: string, root: string, o: SpellingOptions = {}): boolean {
  const p = foldedSpelling(path, o).replace(/\/+$/, "");
  const r = foldedSpelling(root, o).replace(/\/+$/, "");
  // An unjudgeable PATH is inside every root; an unjudgeable ROOT (a drive or share that can't be looked up) holds only an unjudgeable path.
  if (p === UNJUDGEABLE) return true;
  if (r === UNJUDGEABLE) return false;
  return p === r || p.startsWith(`${r}/`);
}
