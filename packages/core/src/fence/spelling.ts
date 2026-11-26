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

/** The long form of the nearest existing ancestor of `path`, with the names below it as they were spelled. */
function expandShort(path: string, long: (p: string) => string | null): string {
  let head = path;
  let tail = "";
  for (let i = 0; i < 128; i++) {
    const found = long(head);
    if (found !== null) return found + tail;
    const parent = win32.dirname(head);
    if (parent === head) return path;
    tail = `\\${win32.basename(head)}${tail}`;
    head = parent;
  }
  return path;
}

export function foldedSpelling(path: string, o: SpellingOptions = {}): string {
  if (!(o.win32 ?? process.platform === "win32")) return path.toLowerCase();
  // `\\?\C:\x`, `\\.\C:\x` and `\??\C:\x` name the same place as `C:\x`.
  const bare = path.replace(/^(?:\\\\[?.]\\|\\\?\?\\|\/\/[?.]\/)(?=[A-Za-z]:)/, "");
  return foldPath(expandShort(bare, o.long ?? getLongPathName), "windows");
}

/** `inside` for two paths of the same machine, both sides through `foldedSpelling`. */
export function insideFolded(path: string, root: string, o: SpellingOptions = {}): boolean {
  const p = foldedSpelling(path, o).replace(/\/+$/, "");
  const r = foldedSpelling(root, o).replace(/\/+$/, "");
  return p === r || p.startsWith(`${r}/`);
}
