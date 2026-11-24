// How the fence compares names (spec §9.1 "The holder enforces its own rules"; J-M1's review B1; B-M1's contract
// review). A fenced name in another case, another Unicode form, or another spelling the disk takes as the same name
// must not lead past the fence, whether or not the item exists yet.
//   - Folded on every OS, Linux included: NFC, then `toUpperCase().toLowerCase()`. APFS and NTFS take `ſettings` as
//     `settings`; the plain NFC-plus-lowercase fold missed it, as it misses `ß` (→ `ss`) and the Kelvin sign
//     (U+212A → `k`). Folding where a disk doesn't fold only fences more. (B's shared fold, coming in B-M1, is the
//     same function; this one is swapped for it when it lands.) The NFC step errs the same way on Windows: NTFS
//     doesn't normalise, so `é` written composed and decomposed are two names there; taken as one here, a name that
//     only looks like a fenced one is fenced too, and no fenced name is ever taken as another.
//   - On Windows, a name also drops its trailing dots and spaces, and an alternate data stream (`settings.json:x`,
//     `settings.json::$DATA`) names its file: NTFS opens the same file for each.
//   - Where MOSS names things itself (the MOSS home's top level, and any folder holding a fenced item), a name
//     that isn't ASCII is refused outright (`nonAsciiAlias`), so no folding rule has to be right about it.
import type { Os } from "@waifucave/moss-protocol";

/** One name, as the fence compares it. */
export function foldName(name: string): string {
  return name.normalize("NFC").toUpperCase().toLowerCase();
}

/** One path component as `os`'s disks open it: Windows drops trailing dots and spaces and reads a stream suffix as
 *  its file. `.` and `..` stay as they are. */
export function diskName(component: string, os: Os): string {
  if (os !== "windows" || component === "." || component === "..") return component;
  const stream = component.indexOf(":");
  const base = stream >= 0 ? component.slice(0, stream) : component;
  return base.replace(/[. ]+$/, "") || base;
}

/** A path's components with `/` and, on Windows, `\` as separators; a drive (`C:`) stays the first component. */
export function components(path: string, os: Os): string[] {
  return (os === "windows" ? path.replace(/\\/g, "/") : path).split("/");
}

/** A whole absolute path, folded and with each component as the disk opens it, `/`-separated. */
export function foldPath(path: string, os: Os): string {
  const parts = components(path, os);
  const out = parts.map((p, i) => (os === "windows" && i === 0 && /^[A-Za-z]:$/.test(p) ? p.toLowerCase() : foldName(diskName(p, os))));
  return out.join("/");
}

/** Lane WS8, the ONE way the fence compares two paths for "the same" and "inside" (the Windows acceptance lane's two
 *  audits: comparisons that knew only `/` let a path strictly under a Windows deny look outside it). A path's key:
 *   - Windows: a device prefix stripped (`\\?\C:\x` is `C:\x`, `\\?\UNC\s\share` and `\\.\UNC\…` are `\\s\share`),
 *     `/` and `\` both separators and runs of them one, `.` dropped, `..` taken lexically as Windows itself takes it
 *     before any link is followed (never above the drive or share), each name as the disk opens it (`diskName`:
 *     trailing dots and spaces dropped, `name::$DATA` and `name:stream` naming `name`) and folded (`foldName`), the
 *     drive letter lowercased. A drive-relative `C:x` (relative to that drive's current folder) and a relative path
 *     get a key of their own (`?rel:`), so they are never the same as, or inside, an absolute path: callers compare
 *     absolute paths.
 *   - macOS: `/` only, the same steps, folded (APFS compares names case-blind). Linux: the same, NOT folded (its
 *     disks are case-sensitive, and a fold there would make one folder count as another: kept where it isn't).
 *  What only the disk knows is not done here: links, and 8.3 short names (`PROGRA~1`); compare `canonicalPath`s
 *  (canonical.ts) where those matter. Keys are `/`-joined: `c:/users/u/.moss`, `//server/share/x`, `/home/u`. */
export function pathKey(path: string, os: Os): string {
  let p = os === "windows" ? path.replace(/\//g, "\\") : path;
  let lead: string;
  let fixed = 0; // components `..` never removes (a drive, or a share's server and name)
  const out: string[] = [];
  if (os === "windows") {
    const device = /^\\\\[?.]\\(UNC\\)?/i.exec(p);
    if (device !== null) p = (device[1] !== undefined ? "\\\\" : "") + p.slice(device[0].length);
    if (p.startsWith("\\\\")) { lead = "//"; p = p.slice(2); fixed = 2; }
    else if (/^[A-Za-z]:\\/.test(p)) { lead = ""; out.push(p.slice(0, 2).toLowerCase()); p = p.slice(3); fixed = 1; }
    else if (/^[A-Za-z]:/.test(p)) { lead = `?rel:${p.slice(0, 2).toLowerCase()}/`; p = p.slice(2); }
    else if (p.startsWith("\\")) { lead = "/"; p = p.slice(1); }
    else lead = "?rel:";
  } else if (p.startsWith("/")) { lead = "/"; p = p.slice(1); }
  else lead = "?rel:";
  const fold = (n: string) => (os === "linux" ? n : foldName(n));
  for (const raw of p.split(os === "windows" ? /\\+/ : /\/+/)) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") { if (out.length > fixed) out.pop(); continue; }
    out.push(fold(diskName(raw, os)));
  }
  return lead + out.join("/");
}

/** Whether `path` is `root` or lies under it, by `pathKey` (a relative or drive-relative path is inside no absolute
 *  root, and the reverse). */
export function pathWithin(path: string, root: string, os: Os): boolean {
  const p = pathKey(path, os), r = pathKey(root, os);
  if (p === r) return true;
  return p.startsWith(r.endsWith("/") ? r : `${r}/`);
}

/** The second wall, as B's contract builds it (`nonAsciiAlias`, B-M1 #179; the controller's ruling): a name that
 *  isn't ASCII where MOSS names things itself is refused, whatever a disk might fold it to. That is the MOSS home's
 *  own top level and any folder under it that holds a fenced item (`plugins-state/` for `plugins-state/oks`). A bot's
 *  memory note or a plugin's asset may have any name: those folders hold no fenced item. The non-ASCII name found, or
 *  null. (Swapped for B's once #179 is on main.) */
export function nonAsciiAlias(path: string, fenced: readonly string[], mossHome: string, os: Os): string | null {
  const names = components(path, os).filter((c) => c !== "");
  const home = components(mossHome, os).filter((c) => c !== "");
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((n, i) => foldName(diskName(n, os)) === foldName(diskName(b[i]!, os)));
  if (names.length <= home.length || !same(names.slice(0, home.length), home)) return null;
  const holders = fenced.map((p) => components(p, os).filter((c) => c !== ""));
  for (let depth = home.length; depth < names.length; depth++) {
    if (/^[\x00-\x7f]*$/.test(names[depth]!)) continue;
    const folder = names.slice(0, depth);
    if (depth === home.length || holders.some((item) => item.length > depth && same(item.slice(0, depth), folder))) return names[depth]!;
  }
  return null;
}
