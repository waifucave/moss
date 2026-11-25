// The MOSS home is out of every agent's reach (the owner's decision on bots' memory, then #208's check 2): an ACP or
// delegated agent, the delegating bot's own included, can't read or write anything in the MOSS home. Not a list of
// what holds a bot's memory or its conversations (memory, the runtimes' transcript stores, the sessions' event logs, the
// diffs, the scratch and output folders, the runtime's own state), which kept missing some: the whole home, by default.
// The manager already refuses a root inside it, and the daemon writes everything an agent leaves there (its transcript,
// its record). Nothing is carved out: no agent's command or tool has been shown to need a path in the home.
//
// The home goes into every agent's sandbox as a read and write denial, and into moss-code's file tools as deny rules
// and a check of each path as it really is (a link from the root into the home is refused too); a permission request
// that touches it is refused without a card, whatever the level. A bot's own memory (`ownMemory`) is a bot runner's,
// never an agent's.
import { realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Os } from "@waifucave/moss-protocol";
import { isInsideFolded, secretReadPlaces, type SandboxPolicy } from "../contracts/fence";
import { canonicalPath } from "../fence/canonical";
import { pathWithin } from "../fence/fold";
import { ContractError } from "../contracts/common";

/** The policy an agent's sandbox starts from. A bot's own Bash may work in its own memory (the controller's ruling: B's
 *  policy carries that as `ownMemory`, applied after the denials); an agent never may, so a policy that carries it is
 *  refused here and the agent doesn't start. */
export function agentPolicyOf(policy: SandboxPolicy): SandboxPolicy {
  if ((policy as SandboxPolicy & { ownMemory?: unknown }).ownMemory !== undefined) {
    throw new ContractError("refused", "an agent's sandbox may never carry a bot's own memory (ownMemory), so the agent wasn't started");
  }
  // Nor a bot's open access to the MOSS home (`botAccess`, the owner's ruling of November 9): bots' only.
  if ((policy as SandboxPolicy & { botAccess?: unknown }).botAccess !== undefined) {
    throw new ContractError("refused", "an agent's sandbox may never carry a bot's open access to the MOSS home (botAccess), so the agent wasn't started");
  }
  return policy;
}

/** The policy with the whole MOSS home denied to an agent, for reads and writes. */
export function withHomeDenied(policy: SandboxPolicy, home: string): SandboxPolicy {
  const add = (list: readonly string[]) => (list.includes(home) ? [...list] : [...list, home]);
  return { ...policy, denyRead: add(policy.denyRead), denyWrite: add(policy.denyWrite) };
}

/** The policy with the user's secret places (`SECRET_READ_PLACES`) denied to an agent, for reads and writes: its
 *  sandbox (each writer's denials, and MOSS's coding agent's runtime sandbox) holds them out of its commands and file
 *  tools. Unchanged without a user's home. */
export function withSecretsDenied(policy: SandboxPolicy, userHome: string | undefined, os: Os): SandboxPolicy {
  if (userHome === undefined) return policy;
  const places = secretReadPlaces(os, userHome).map((p) => p.path);
  const add = (list: readonly string[]) => [...new Set([...list, ...places])];
  return { ...policy, denyRead: add(policy.denyRead), denyWrite: add(policy.denyWrite) };
}

/** A path as it really is: its real path, or for one that doesn't exist yet its nearest existing folder's, with the rest
 *  appended. On Windows (lane WS8, the reviewer's 8.3 finding) as the fence resolves it (`canonicalPath`: links and
 *  junctions followed in order, then the disk's own spelling, so an 8.3 short name such as `C:\Users\LONGNA~1` comes
 *  back long): the JS `realpathSync` follows links but keeps a short name as written, and a short name of a denied
 *  folder then matched no deny. Past `canonicalPath`'s link limit (a loop, or a chain built to tire the walk) the path is
 *  `TOO_MANY_LINKS`, a device path every deny decision refuses (`windowsPathRefused`), never judged half-walked. */
export function realPathOf(path: string, cwd: string): string {
  let p = isAbsolute(path) ? path : resolve(cwd, path);
  const win = process.platform === "win32";
  if (win) {
    try { return withoutDosDevicePrefix(canonicalPath(p)); } catch { return TOO_MANY_LINKS; }
  }
  const real = (q: string) => realpathSync(q);
  const rest: string[] = [];
  for (;;) {
    try {
      return resolve(real(p), ...rest.reverse());
    } catch {
      const up = dirname(p);
      if (up === p) return resolve(path);
      rest.push(p.slice(up.length).replace(/^[\\/]+/, ""));
      p = up;
    }
  }
}

/** How a path, as written or as it really is, reaches the MOSS home: inside it, holding it (a search from there would
 *  walk into it), or not at all. */
export function homeReach(home: string, path: string, cwd: string, os?: Os, granted: readonly string[] = [cwd]): "inside" | "holds" | undefined {
  // The home as it really is too (a short name or a link to it given as the home).
  const realHome = realPathOf(home, cwd);
  // The granted roots as written and as they resolve (a mapped drive's `Z:\proj` is `\\server\share\proj`), only
  // when a share is asked about.
  const roots = () => grantedForms(granted, cwd);
  if (windowsPathRefused(path.trim(), roots, os)) return "inside"; // as written, before any resolving
  let holds = false;
  for (const p of new Set([isAbsolute(path) ? path : resolve(cwd, path), realPathOf(path, cwd)])) {
    // A path no comparison can place (a device path, a share: `windowsPathRefused`), as written or as it resolves (a
    // link to a share): it reaches every deny. Refused.
    if (windowsPathRefused(p, roots, os)) return "inside";
    for (const h of new Set([home, realHome])) {
      if (reachesInside(p, h, os)) return "inside";
      if (reachesInside(h, p, os)) holds = true;
    }
  }
  return holds ? "holds" : undefined;
}

/** `\\?\C:\x` as `C:\x`, `\\?\UNC\s\x` as `\\s\x`: what `realpathSync.native` may give back on Windows. */
function withoutDosDevicePrefix(p: string): string {
  return p.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\(?=[A-Za-z]:)/, "");
}

/** What `realPathOf` gives for a path past the link limit on Windows: a device path, which every deny decision refuses. */
export const TOO_MANY_LINKS = "\\\\?\\GLOBALROOT\\moss-too-many-links";

/** Whether `path` names a network share on Windows, in any spelling: `\\server\share\…`, `//server/share`, mixed
 *  separators, `\\?\UNC\…`, `\\.\UNC\…`. */
export function uncPath(path: string, os?: Os): boolean {
  if ((os ?? (process.platform === "win32" ? "windows" : "macos")) !== "windows") return false;
  const t = path.trim();
  if (!/^[\\/]{2}/.test(t)) return false;
  const dev = /^[\\/]{2}[?.][\\/](.*)$/.exec(t);
  return dev === null ? true : /^UNC[\\/]/i.test(dev[1]!);
}

/** Whether a file tool's deny decision on Windows refuses `path` outright (lane WS8, the reviewer's findings): a device
 *  path no comparison can place (`opaqueWindowsPath`), and a share (`uncPath`) unless it lies inside a root the caller
 *  was granted that is itself a share, by the one comparison (`pathWithin`). A share can be this very computer
 *  (`\\localhost\C$\…`, `\\127.0.0.1\…`, `\\<its name>\<a share of the user's home>`), which Windows opens as
 *  `\\?\UNC\…`, never `C:\…`, so no deny on `C:\Users\…` would match it; this computer's names are never listed,
 *  every share is refused. False everywhere but Windows. */
export function windowsPathRefused(path: string, granted: readonly string[] | (() => readonly string[]), os?: Os): boolean {
  if (opaqueWindowsPath(path, os)) return true;
  if (!uncPath(path, os)) return false;
  const roots = typeof granted === "function" ? granted() : granted;
  return !roots.some((g) => uncPath(g, os) && pathWithin(path, g, "windows"));
}

/** Granted roots as written and as each resolves (`realPathOf`; lane WS9, the reviewer's should-fix): a project on a
 *  mapped drive (`Z:\proj`, `Z:` a share) is opened as `\\server\share\proj\…`, so its file tools' paths resolve to
 *  the share while the root was granted by its letter; judged against the root's resolved form too, they are inside it. */
export function grantedForms(granted: readonly string[], cwd: string, real: (path: string, cwd: string) => string = realPathOf): string[] {
  return [...new Set([...granted, ...granted.map((g) => real(g, cwd))])];
}

/** Whether `path` is in the Win32 device namespace in a form other than a drive (`\\?\C:\`) or a share
 *  (`\\?\UNC\`): a volume GUID path (`\\?\Volume{…}\`), `\\?\GLOBALROOT\…`, a pipe or a raw device. No path
 *  comparison can say which folder it names (the same volume as `C:\` has a GUID spelling too), so a deny decision
 *  refuses it (lane WS8, the reviewer's open point). Windows only. */
export function opaqueWindowsPath(path: string, os?: Os): boolean {
  if ((os ?? (process.platform === "win32" ? "windows" : "macos")) !== "windows") return false;
  const m = /^[\\/]{2}[?.][\\/](.*)$/.exec(path.trim());
  return m !== null && !/^([A-Za-z]:([\\/]|$)|UNC[\\/])/i.test(m[1]!);
}

/** Whether `path` is `root` or under it, for a deny: on Windows by the fence's one comparison (`pathWithin`: a device
 *  prefix, both separators, `..`, trailing dots and streams, case); on macOS and Linux as before (`isInsideFolded`, which
 *  folds on Linux too: a fold there only denies more, and `pathWithin` keeps Linux's names exact). */
export function reachesInside(path: string, root: string, os?: Os): boolean {
  const o = os ?? (process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux");
  return o === "windows" ? pathWithin(path, root, "windows") : isInsideFolded(path, root, os);
}

/** Deny rules for the file tools: a read-denied folder for every file tool, a write-denied one for the editing ones. */
export function fileToolDenials(denyRead: readonly string[], denyWrite: readonly string[]): string[] {
  const rules = (folders: readonly string[], tools: readonly string[]) => folders
    .map((p) => p.replace(/[\\/]+$/, ""))
    .filter((p) => p !== "")
    .flatMap((p) => tools.flatMap((t) => [`${t}(/${p})`, `${t}(/${p}/**)`]));
  return [...new Set([...rules(denyRead, ["Read", "Edit", "Write", "Glob", "Grep", "NotebookEdit"]), ...rules(denyWrite, ["Edit", "Write", "NotebookEdit"])])];
}
