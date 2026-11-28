// The fenced process on Windows: the third leg of `fencedSpawner` (`fenced-process.ts`), beside Seatbelt on macOS and
// bubblewrap on Linux (spec §4, §9.1, item 76, §14.1 item 2). A command runs as one of the owner's pool principals
// (`moss-sb-<6hex>-<n>`, provisioned by `moss-core sandbox setup`) through the hash-pinned srt-win launcher, with a
// write-restricted token, WFP filters keyed to the principal and a kill-on-close job: never as the user, and never with
// a fallback to an unsandboxed shell. Every refusal below is a refusal of the whole run.
//
// The rules, each enforced where it says:
//  1. Who: the launcher must be the pinned build (`launcherProblem`) and the install marker must name this owner, at
//     every launch.
//  2. One principal per command: a pool member is leased exclusively for the command's whole run (an OS lock on its
//     `.lock` in the pool's state, `poolStateDir`, which the reset takes too), so two commands never share a
//     principal, and the lease ends with the command.
//  3. Writes: only the run's write roots, each a persistent root with its own capability SID (`acl grant
//     --persistent`), passed to `exec --write-root`; the write-restricted token lets nothing else be written, whatever
//     BUILTIN\Users or Authenticated Users may write. The roots are the runner's sandbox's `allowWrite` (`planFor`).
//     The session's grants are revoked only when this process's last command ends (`heldGrants`). Outside the
//     roots (a folder on the system drive that Users may modify, `C:\Users\Public`) the token alone refuses the write:
//     the e2e asserts it. 3b: two commands of different callers never run at once when one's read grant lies strictly
//     under the other's read deny (`grantsConflict`); a write root counts as a read grant (its group entry includes
//     read). 3c: a root this process granted before, strictly under a later command's read deny, is denied by name for
//     that command (`strayRoots`): a root's entries outlive the command.
//  4. Denies: every fenced path of the run's sandbox that exists is stamped `--deny-write` / `--deny-read` for this
//     command; a glob is expanded over what exists, one walk per folder with its own budget, and past it the folders
//     not read are denied whole (`existingDeniesOf`); a deny wins over every allow (an explicit deny ACE comes first).
//     A fenced path that doesn't exist yet can only be made inside a write root; rule 7 puts it away after the run.
//  5. Network: a pool principal's WFP filters (installed by setup, loopback closed) refuse every connection but the
//     loopback proxy range 60080–60089, as `srt-win install` sets them; no `--allow-loopback` is ever passed. A
//     command the person approved to leave the sandbox runs as the escape account instead (`FencedRun.network`,
//     `escapeMember`), whose filter blocks only the cloud metadata address (srt-win patch 0003); no other command
//     ever runs as it.
//  6. Environment: built here, whole. The broker gets a fixed system environment; the child gets a home folder of its
//     own, made for the command inside its temp folder and removed after it, as HOME/USERPROFILE/APPDATA (never the
//     user's: the controller's ruling 2, and the M1 floor's "HOME and TEMP in the session's own temp"), its run's temp
//     folder as TEMP/TMP, a fixed PATH and MOSS's empty git template. Nothing of the daemon's environment reaches it.
//  7. Run later: after the run, a git config key a command set in a repo under its write roots is reverted, a hook it
//     planted in such a repo's `.git/hooks` is moved aside, and a fenced path or run-later name (`.vscode`, `.envrc`,
//     `.git`…) it made under a root is moved aside and named in the result (`revertPlantedGitKeys`,
//     `quarantineHooks`, `quarantineWin`, `quarantinePatternMatches`): Linux's way, where the Mac refuses the write.
//     What can't be moved (a folder on its way is a link, the move failed, or a tree on another drive is over
//     `QUARANTINE_COPY_LIMITS` to copy) is left and named in the result.
//  8. Reads: the user's profile through srt-win's profile read grant (`grantProfile`), less every `denyRead`. The
//     grant's exclusions are added to the ones in force, never replacing another engine's (another MOSS home of the
//     same Windows user); a per-command read deny is dropped only when the grant IN FORCE, read back at that command
//     (`profile status`), excludes the path; otherwise it is stamped (`perExecReadDenies`). 8b: when the fenced set
//     gains a path that exists, the grant is made again with it before a command, between commands (`refreshExcludes`).
//     8c: a long command (`onFenceGrew`) is watched while it runs, and ended by its caller when its fenced set grows.
//  9. Nothing carries over (spec §9.1): after each command the reset task (SYSTEM, `sandbox reset`) deletes the
//     principal's whole profile and hive and makes a fresh one from the default profile, then writes a new generation;
//     a command runs only as a principal whose generation isn't the one last used (`leaseFresh`), and marks it used
//     before it starts. The reset is off the command's path; checked at every launch; failing closed.
import { pathWithin } from "./fold";
import { randomBytes } from "node:crypto";
import { closeSync, cpSync, existsSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join, win32 } from "node:path";
import { explainLauncherCwd } from "./win-launch-errors";
import type { SandboxSettingsConfig } from "@waifucave/clover-agent-sdk";
import type { Caller } from "@waifucave/moss-protocol";
import { BOT_READ_DENIED, fenceContextFor, secretReadPlaces } from "../contracts/fence";
import type { MossFence } from "./fence";
import { gitTemplateDir } from "./layout";
import { ordinaryTopFolders } from "./sandbox-settings";
import { reposUnder, revertPlantedGitKeys, snapshotFiles } from "./fenced-process";
import { runCommand, type FencedRun, type FencedRunResult, type FencedSpawner, type RunShell } from "./spawn";
import {
  createWindowsLockStore, execArgs, isFreshGeneration, poolStateDir, poolStateFiles, runResetTaskArgs, installMarkerPath, launcherProblem, minimalChildEnv, parseInstallMarker,
  sandboxLeasesDir, sessionGrantArgs, sessionGrantInput,
  sessionRevokeArgs, setupBashRefusal, srtWinArch, srtWinPath, USER_STATUS_ARGS, winLaunchPlan, type InstallMarker, type LeaseStore,
} from "./win-sandbox";

/** The two shells a fenced command runs in on Windows. */
export type WinShell = "bash" | "powershell";

/** Where the shells are: Git Bash from its two standard installs (all users, then this user) and Windows PowerShell
 *  from System32, never found through PATH (which a command could change). Null where it isn't installed. */
export function windowsShells(env: Readonly<Record<string, string | undefined>> = process.env, exists: (p: string) => boolean = existsSync): { bash: string | null; powershell: string | null } {
  const bash = [env.ProgramFiles && win32.join(env.ProgramFiles, "Git", "bin", "bash.exe"), env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe")]
    .find((p): p is string => typeof p === "string" && exists(p)) ?? null;
  const ps = env.SystemRoot ? win32.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : null;
  return { bash, powershell: ps !== null && exists(ps) ? ps : null };
}

/** The argv that runs `command` in `shell`. PowerShell starts without profiles (`-NoProfile`: a profile is a place
 *  the OS runs code from, fenced) and never reads its input interactively. */
export function shellArgv(shell: WinShell, exe: string, command: string): string[] {
  return shell === "powershell" ? [exe, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command] : [exe, "-c", command];
}

/** One command's sandbox in srt-win's terms. */
export interface WinPlan {
  /** Persistent write roots: the only places the command writes (rule 3). */
  readonly writeRoots: readonly string[];
  /** Read grants beyond what the principal reads already (its own profile, the system). */
  readonly readGrants: readonly string[];
  /** Fenced paths to stamp for this command, as given (globs expanded at launch, over what exists). */
  readonly denyRead: readonly string[];
  readonly denyWrite: readonly string[];
  /** Granted paths under a read deny: left out of the profile read grant's deny (srt-win `--deny-read-except`). */
  readonly denyReadExcept: readonly string[];
}

const fold = (p: string) => win32.normalize(p).replace(/[\\/]+$/, "").toLowerCase();
const uniq = (paths: readonly string[]) => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) { const k = fold(p); if (!seen.has(k)) { seen.add(k); out.push(win32.normalize(p)); } }
  return out;
};
/** Whether `child` is `dir` or sits under it, by the fence's one comparison (`pathWithin`, lane WS8: a device prefix,
 *  `/` and `\\`, `..`, trailing dots and streams, case). A device path it can't place is under nothing. */
export function winUnder(child: string, dir: string): boolean {
  return pathWithin(child, dir, "windows");
}

/** The plan from the runtime's sandbox settings: a bot's Bash gets on Windows exactly the settings Seatbelt and
 *  bubblewrap get on macOS and Linux (`botSandboxSettings`, the single bot Bash sandbox builder). `allowWrite` are the
 *  write roots; `denyWrite` and `denyRead` the stamps. */
export function planFromSettings(s: SandboxSettingsConfig): WinPlan {
  const f = s.filesystem ?? {};
  const roots = uniq(f.allowWrite ?? []);
  return { writeRoots: roots, readGrants: [], denyRead: uniq(f.denyRead ?? []), denyWrite: uniq(f.denyWrite ?? []), denyReadExcept: roots };
}

/** The plan from the fence's policy for a run that brings no settings (the computer node's Bash): Addendum 3's
 *  per-launch plan (`winLaunchPlan`: the fenced set, the home default-deny and the caller's own folders), written into
 *  the caller's own folders and the fence's temp folder; the run's working folder too when the policy lets the caller
 *  write it. The user's whole home is not a root here: a persistent grant walks a root's whole tree. */
/** Why a command's folder can't be its working folder when the daemon itself sees it isn't one, else null. */
export function missingFolderNote(cwd: string): string | null {
  try {
    return statSync(cwd).isDirectory() ? null : `the folder ${cwd} isn't a folder (it is a file), so the command can't run in it; run it from a folder that exists`;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? `the folder ${cwd} isn't there (it was removed or renamed away), so the command can't run in it; run it from a folder that exists` : null;
  }
}

export function planFromPolicy(fence: Pick<MossFence, "policy" | "mossHome" | "temp" | "contextFor">, caller: Caller, cwd: string, o: { bots?: readonly string[]; entries?: (dir: string) => readonly string[] } = {}): WinPlan {
  const ctx = fence.contextFor?.(caller) ?? fenceContextFor(caller);
  const policy = fence.policy(ctx);
  const plan = winLaunchPlan({ policy, mossHome: fence.mossHome, caller, bots: o.bots ?? [], ...(o.entries ? { entries: o.entries } : {}) });
  const denied = (p: string) => plan.denyWrite.some((d) => winUnder(p, d) && !plan.grantWrite.some((g) => winUnder(p, g)));
  // Another computer's call (lane XC): its write roots are the narrowed policy's alone (`peerFence`: its own folder for
  // the call), never the shared temp folder every other caller writes, nor its working folder.
  if (caller.kind === "peer") {
    const roots = uniq(policy.allowWrite);
    return { writeRoots: roots, readGrants: uniq(plan.grantRead), denyRead: plan.denyRead, denyWrite: plan.denyWrite, denyReadExcept: uniq([...roots, ...plan.grantRead]) };
  }
  const cwdRoot = policy.allowWrite.some((a) => winUnder(cwd, a)) && !denied(cwd) ? [cwd] : [];
  const roots = uniq([...plan.grantWrite, fence.temp, ...cwdRoot]);
  return { writeRoots: roots, readGrants: uniq(plan.grantRead), denyRead: plan.denyRead, denyWrite: plan.denyWrite, denyReadExcept: uniq([...roots, ...plan.grantRead]) };
}

/** srt-win refuses a write root on the user's temp folder or on anything above it (its profile read grant leaves the
 *  temp folder ungranted as a whole, and its protected exclusions, `.ssh` and the like, sit under the home). So, on
 *  Windows, a root that is the temp folder becomes the session's own folder inside it (the M1 floor's "temp folder per
 *  session"), and a root that is the home becomes the home's ordinary top-level folders (what "accept edits" writes on
 *  every OS: never a dot-folder, AppData or the MOSS home's way). Any other root above the temp folder is dropped. */
export function windowsRoots(roots: readonly string[], o: { home: string; temp: string; sessionTemp: string; homeFolders: () => readonly string[] }): string[] {
  const out: string[] = [];
  for (const r of roots) {
    if (fold(r) === fold(o.home)) { out.push(...o.homeFolders(), o.sessionTemp); continue; }
    if (winUnder(o.temp, r)) { if (fold(r) === fold(o.temp)) out.push(o.sessionTemp); continue; }
    out.push(r);
  }
  return uniq(out);
}

const GLOB = /[*?[\]{}]/;

/** One glob segment as a case-insensitive regular expression (`*` any run of a name, `?` one character, `[..]` a
 *  class, as the deny lists write case folding: `.[vV][sS]…`). */
function segmentRe(seg: string): RegExp {
  return new RegExp(`^${seg.replace(/[.+^$()|\\{}]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
}

/** How many folder entries the walk of one root may read before it stops (rule 4's budget), and how many unwalked
 *  folders it may deny whole when it stops. */
export const WALK_BUDGET_PER_ROOT = 200_000;
export const UNWALKED_DENY_LIMIT = 256;

/** The paths a deny list names that exist now: literal paths as they are, a glob expanded over what exists (its `*`
 *  one whole name, `**` any depth). A path that doesn't exist isn't stamped (srt-win fails an exec on one). */
export function existingDenies(paths: readonly string[], o: WalkOptions = {}): string[] {
  return existingDeniesOf(paths, o).paths;
}

/** Rule 8c's decision at one look (lane WS8): a new protected root ends the command; new paths its read denies match
 *  are stamped for its account (`sid`), live, or end it when its account's SID isn't known; nothing new, nothing. */
export function lateFenceStep(o: { freshReads: readonly string[]; excludesGrew: boolean; sid: string | null }): { kind: "end" } | { kind: "stamp"; paths: string[] } | { kind: "none" } {
  if (o.excludesGrew) return { kind: "end" };
  if (o.freshReads.length === 0) return { kind: "none" };
  if (o.sid === null) return { kind: "end" };
  return { kind: "stamp", paths: [...o.freshReads] };
}

/** Rule 8c: what a long command's watch looks at, each time: the literal read denies that exist and the matches of
 *  the fixed-depth globs (expanded a segment at a time, listing only the folders the pattern names, never walking a
 *  tree). A `**` glob is not watched: it would walk a whole tree every time (none is among a bot's read denies; a
 *  match made later under one is the per-command stamp's limit, as for a foreground command). */
export function watchedReadDenies(denyRead: readonly string[], o: WalkOptions = {}): string[] {
  return existingDeniesOf(denyRead.filter((p) => !win32.normalize(p).split("\\").includes("**")), o).paths;
}

export interface WalkOptions {
  exists?: (p: string) => boolean;
  list?: (dir: string) => readonly string[];
  isDir?: (p: string) => boolean;
  /** Entries one root's walk may read (`WALK_BUDGET_PER_ROOT`). */
  budget?: number;
}

/** `existingDenies`, and the roots whose walk stopped at its budget. Rule 4's walk:
 *  - A glob with no `**` matches at fixed depths only: it is expanded segment by segment, never walking a tree.
 *  - The `**` globs under one folder (the deny lists' `<root>\**\.vscode` and the rest, ~40 of them) share ONE walk of
 *    that folder, each entry tested against every pattern, with a budget of its own per folder: one large root never
 *    starves another's patterns.
 *  - Past a folder's budget it fails closed without losing the root: the folders the walk had queued but not read are
 *    denied whole (collapsed to their parents until at most `UNWALKED_DENY_LIMIT` remain), so what wasn't looked at
 *    can't be written, and what was looked at stays writable. Never through a link (`isDir` is lstat's). */
export function existingDeniesOf(paths: readonly string[], o: WalkOptions = {}): { paths: string[]; exhausted: boolean; unwalked: string[] } {
  const exists = o.exists ?? ((p: string) => { try { lstatSync(p); return true; } catch { return false; } });
  // On the disk, one listing gives each entry's kind (a link or junction is not a folder: never walked through), so
  // the walk makes no stat call per entry.
  const kinds = new Map<string, boolean>();
  const list = o.list ?? ((d: string) => {
    try { return readdirSync(d, { withFileTypes: true }).map((e) => { kinds.set(fold(win32.join(d, e.name)), e.isDirectory() && !e.isSymbolicLink()); return e.name; }); }
    catch { return []; }
  });
  const isDir = o.isDir ?? ((p: string) => { const k = kinds.get(fold(p)); if (k !== undefined) return k; try { return lstatSync(p).isDirectory(); } catch { return false; } });
  const perRoot = o.budget ?? WALK_BUDGET_PER_ROOT;
  const out: string[] = [];
  const unwalked: string[] = [];
  // Fixed-depth globs: expanded one segment at a time (bounded by the pattern's own depth).
  const fixed = (base: string, segs: readonly string[]): void => {
    if (segs.length === 0) { if (exists(base)) out.push(base); return; }
    const [seg, ...rest] = segs as [string, ...string[]];
    if (!GLOB.test(seg)) { fixed(win32.join(base, seg), rest); return; }
    const re = segmentRe(seg);
    for (const n of list(base)) if (re.test(n)) fixed(win32.join(base, n), rest);
  };
  // `**` globs, grouped by the folder they start under.
  const deep = new Map<string, { key: string; tail: RegExp[] }[]>();
  for (const p of paths) {
    if (!GLOB.test(p)) { if (exists(p)) out.push(p); continue; }
    const parts = win32.normalize(p).split("\\");
    const first = parts.findIndex((x) => GLOB.test(x));
    const prefix = parts.slice(0, first).join("\\") || "\\";
    const rest = parts.slice(first);
    const star = rest.indexOf("**");
    if (star < 0) { fixed(prefix, rest); continue; }
    // Segments before `**` are fixed-depth: expand them, then each folder they reach starts a shared walk.
    // After a second `**` (none in MOSS's lists) only the names after the last one are matched: a wider deny, never
    // a narrower one.
    const before = rest.slice(0, star), after = rest.slice(rest.lastIndexOf("**") + 1);
    const starts: string[] = [];
    const reach = (base: string, segs: readonly string[]): void => {
      if (segs.length === 0) { if (isDir(base)) starts.push(base); return; }
      const [seg, ...more] = segs as [string, ...string[]];
      if (!GLOB.test(seg)) { reach(win32.join(base, seg), more); return; }
      const re = segmentRe(seg);
      for (const n of list(base)) if (re.test(n)) reach(win32.join(base, n), more);
    };
    reach(prefix, before);
    for (const s of starts) {
      const k = fold(s);
      const group = deep.get(k) ?? [];
      group.push({ key: s, tail: after.map(segmentRe) });
      deep.set(k, group);
    }
  }
  for (const group of deep.values()) {
    const root = group[0]!.key;
    // A path relative to the root matches `**\<tail>` when its last `tail.length` names match the tail.
    const matches = (names: readonly string[]): boolean => group.some((g) => {
      if (names.length < g.tail.length) return false;
      const end = names.slice(names.length - g.tail.length);
      return g.tail.every((re, i) => re.test(end[i]!));
    });
    if (matches([])) out.push(root);
    let budget = perRoot;
    const queue: { dir: string; names: string[] }[] = [{ dir: root, names: [] }];
    let head = 0;
    while (head < queue.length) {
      if (budget <= 0) break;
      const { dir, names } = queue[head++]!;
      for (const n of list(dir)) {
        budget--;
        const c = win32.join(dir, n), cn = [...names, n];
        if (matches(cn)) out.push(c);
        if (isDir(c)) queue.push({ dir: c, names: cn });
      }
    }
    if (head < queue.length) {
      // Fail closed: what the walk didn't read is denied whole, collapsed to parents within the limit.
      let left = queue.slice(head).map((q) => q.dir);
      while (left.length > UNWALKED_DENY_LIMIT) {
        const up = uniq(left.map((d) => (fold(d) === fold(root) ? d : win32.dirname(d))));
        if (up.length === left.length) break;
        left = up;
      }
      unwalked.push(...left);
    }
  }
  return { paths: uniq([...out, ...unwalked]), exhausted: unwalked.length > 0, unwalked: uniq(unwalked) };
}

/** CreateProcessW's command line holds 32 767 characters; past ~30 000 (with quoting) the command isn't run. */
export const WIN_ARGV_LIMIT = 30_000;

/** The broker's argv for one command, or why it can't be built. */
export function winExecArgv(o: {
  launcher: string; user: string; plan: WinPlan; denyRead: readonly string[]; denyWrite: readonly string[];
  env: Readonly<Record<string, string>>; shell: readonly string[]; heldBy: number;
}): { argv: string[] } | { refused: string } {
  const base = [...execArgs({ launcher: o.launcher, shell: o.shell, denyRead: o.denyRead, denyWrite: o.denyWrite, env: o.env, writeRoots: o.plan.writeRoots, user: o.user, heldBy: o.heldBy })];
  // `--deny-read-except` sits with the other options, before `--`.
  const dash = base.indexOf("--");
  const except = o.plan.denyReadExcept.flatMap((p) => ["--deny-read-except", p]);
  const argv = [...base.slice(0, dash), ...except, ...base.slice(dash)];
  const length = argv.reduce((n, a) => n + a.length + 3, 0);
  if (length > WIN_ARGV_LIMIT) {
    return { refused: `the command and its sandbox (${o.denyRead.length} read denies, ${o.denyWrite.length} write denies, ${o.plan.writeRoots.length} write roots) don't fit Windows' command line (~${length} of ${WIN_ARGV_LIMIT} characters); nothing ran` };
  }
  return { argv };
}

/** The child's environment (rule 6): the principal's profile as its home, the run's temp folder, a fixed PATH. */
export function winChildEnv(o: { profileRoot: string; temp: string; systemRoot: string; gitRoot: string | null; gitTemplate: string }): Record<string, string> {
  const sys = o.systemRoot;
  const path = [
    ...(o.gitRoot ? [win32.join(o.gitRoot, "cmd"), win32.join(o.gitRoot, "mingw64", "bin"), win32.join(o.gitRoot, "usr", "bin")] : []),
    win32.join(sys, "System32"), sys, win32.join(sys, "System32", "Wbem"), win32.join(sys, "System32", "WindowsPowerShell", "v1.0"),
  ].join(";");
  return {
    PATH: path,
    PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC;.PS1",
    SystemRoot: sys, windir: sys, ComSpec: win32.join(sys, "System32", "cmd.exe"),
    HOME: o.profileRoot, USERPROFILE: o.profileRoot,
    APPDATA: win32.join(o.profileRoot, "AppData", "Roaming"), LOCALAPPDATA: win32.join(o.profileRoot, "AppData", "Local"),
    TEMP: o.temp, TMP: o.temp, TMPDIR: o.temp,
    GIT_TEMPLATE_DIR: o.gitTemplate,
    LANG: "en_US.UTF-8", TERM: "dumb",
    // Git Bash: no login profile, no Windows paths rewritten into a command's arguments.
    CHERE_INVOKING: "1",
  };
}

/** What the Windows leg needs from the machine; `windowsDeps` gives the real ones (tests pass fakes). */
export interface WinFencedDeps {
  readonly launcher: string;
  /** Why the launcher can't be used, or null when it is the pinned build (`launcherProblem`: the digest check). */
  launcherProblem(): string | null;
  readonly ownerSid: string | null;
  /** `%ProgramData%`, where `sandbox setup` writes the install marker. */
  readonly programData: string | null;
  readonly systemRoot: string;
  readonly shells: { bash: string | null; powershell: string | null };
  readonly leases: () => LeaseStore;
  /** The pool's state folder (`poolStateDir`): the leases' locks and each principal's generation and used record. */
  readonly leasesDir: string;
  /** A short helper process (srt-win's acl and status, reg): exit code and output. */
  exec(argv: readonly string[], o?: { stdin?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
  readFile(path: string): string | null;
  /** Writes an existing file whole (the pool's `.used` record); false when it can't. */
  writeFile(path: string, text: string): boolean;
  /** How long a command waits for a free, reset principal before it is refused, and how often it looks. */
  readonly leaseTimeoutMs?: number;
  readonly leasePollMs?: number;
  /** How long a command's session grant waits while another process's profile grant is being written or removed
   *  (srt-win's exit 25, `profile_operation_in_progress`), and how often it tries again. */
  readonly profileBusyWaitMs?: number;
  readonly profileBusyPollMs?: number;
  /** Rule 8c: how often a long command's fenced set is looked at again (`FencedRun.onFenceGrew`). */
  readonly fenceWatchMs?: number;
}

declare const __MOSS_TEST_BUILD__: string | false | undefined;

/** The real machine's deps. */
export function windowsDeps(mossHome: string, o: { ownerSid: string | null; programData: string | null }): WinFencedDeps {
  const env = minimalChildEnv();
  // The pool's state lives where only SYSTEM and administrators write (`poolStateDir`); without the owner's SID or
  // ProgramData it is the old per-home folder, which no install has (every launch is then refused at `install`).
  const leasesDir = o.ownerSid !== null && o.programData !== null ? poolStateDir(o.programData, o.ownerSid) : sandboxLeasesDir(mossHome);
  let store: LeaseStore | undefined;
  // The launcher is the protected copy's (`%ProgramFiles%\MOSS Sandbox\<SID>\srt-win.exe`, written by the installer
  // elevated, admin-write only), never the one beside the daemon in its user-writable install folder: nothing can
  // swap it between the digest check and the spawn. `MOSS_SRT_WIN` names another only in a dev or test build (run
  // from source, or `__MOSS_TEST_BUILD__` a label); a release build (`false`) never reads it. The digest is checked
  // at every launch either way.
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const override = typeof __MOSS_TEST_BUILD__ === "boolean" ? undefined : process.env.MOSS_SRT_WIN;
  const launcher = override ?? (o.ownerSid === null ? srtWinPath() : win32.join(programFiles, "MOSS Sandbox", o.ownerSid, "srt-win.exe"));
  return {
    launcher,
    launcherProblem() { return launcherProblem(this.launcher, srtWinArch()); },
    ownerSid: o.ownerSid,
    programData: o.programData,
    systemRoot: process.env.SystemRoot ?? "C:\\Windows",
    shells: windowsShells(),
    leases: () => (store ??= createWindowsLockStore(leasesDir, { poolState: o.ownerSid !== null && o.programData !== null })),
    leasesDir,
    async exec(argv, x = {}) {
      try {
        const p = Bun.spawn([...argv], { stdin: x.stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true, env });
        if (x.stdin !== undefined && p.stdin) { p.stdin.write(x.stdin); await p.stdin.end(); }
        const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, x.timeoutMs ?? 120_000);
        const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
        const code = await p.exited;
        clearTimeout(timer);
        return { code, stdout, stderr };
      } catch (e) {
        return { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
      }
    },
    readFile: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
    // `r+`: the file must already be there (setup made it; the owner can't make one in that folder).
    writeFile: (p, text) => { try { const fd = openSync(p, "r+"); try { ftruncateSync(fd, 0); writeSync(fd, text, 0); fsyncSync(fd); } finally { closeSync(fd); } return true; } catch { return false; } },
  };
}

/** The git config files and hook folders a command could plant something in that runs later, under its write roots. */
function gitPlaces(roots: readonly string[]): { configs: string[]; hooks: string[] } {
  const found = reposUnder(roots.filter((r) => { try { return statSync(r).isDirectory(); } catch { return false; } }), 2_000);
  const configs = found.files;
  const hooks = [...new Set(configs.map((c) => join(c, "..", "hooks")))];
  return { configs, hooks };
}

/** What each hook folder holds, by name (a sample hook git itself writes is no hook). */
function hookFiles(dirs: readonly string[]): Map<string, boolean> {
  const m = new Map<string, boolean>();
  for (const d of dirs) {
    let names: string[] = [];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) if (!n.endsWith(".sample")) m.set(join(d, n), true);
  }
  return m;
}

/** Whether every folder holding `path` is a plain folder, read without following links (a junction or symbolic
 *  link reads as a link): the move below never goes through one (the git cleanup's `chainIsClean`, for Windows). */
export function winChainIsClean(path: string, lstat: (p: string) => { isDirectory(): boolean; isSymbolicLink(): boolean } = lstatSync): boolean {
  let at = win32.dirname(path);
  for (;;) {
    try { const st = lstat(at); if (st.isSymbolicLink() || !st.isDirectory()) return false; } catch { return false; }
    const up = win32.dirname(at);
    if (up === at) return true;
    at = up;
  }
}

/** Rule 7's move aside: each path a command made (`false` in `before`: it wasn't there) goes into the MOSS home's
 *  quarantine. Across drives (a write root on another volume: a rename can't) it is copied there, links kept as
 *  links, and then deleted. Left where it is, and NAMED in the result, when a folder on its way is a link
 *  (`winChainIsClean`: the move would act through it) or the move fails (the reviewer's WS2 finding 4). */
/** The most a move across drives copies of one planted tree into the MOSS home (the WS3 reviewer's finding 4): past
 *  either it is left where it is and named. Counted before anything is copied, never following a link. */
export const QUARANTINE_COPY_LIMITS = { bytes: 64 * 1024 * 1024, entries: 10_000 } as const;

/** Whether the tree at `p` (itself included) fits `limits`, walked without following links; stops at the first
 *  excess, so a huge tree costs no more than the limit to measure. */
export function treeWithin(p: string, limits: { bytes: number; entries: number }): boolean {
  let bytes = 0, entries = 0;
  const stack = [p];
  while (stack.length > 0) {
    const at = stack.pop()!;
    const st = lstatSync(at);
    entries++;
    bytes += st.isFile() ? st.size : 0;
    if (entries > limits.entries || bytes > limits.bytes) return false;
    if (st.isDirectory() && !st.isSymbolicLink()) for (const n of readdirSync(at)) stack.push(join(at, n));
  }
  return true;
}

export function quarantineWin(before: Map<string, boolean>, mossHome: string, o: { rename?: (from: string, to: string) => void; limits?: { bytes: number; entries: number } } = {}): string | null {
  const rename = o.rename ?? renameSync;
  const limits = o.limits ?? QUARANTINE_COPY_LIMITS;
  const moved: string[] = [];
  const left: string[] = [];
  for (const [p, wasThere] of before) {
    if (wasThere) continue;
    try { lstatSync(p); } catch { continue; } // not made
    if (!winChainIsClean(p)) { left.push(`${p} (a folder on its way is a link)`); continue; }
    const qdir = join(mossHome, "quarantine");
    const q = join(qdir, `${win32.basename(p)}.quarantined-${randomBytes(4).toString("hex")}`);
    try {
      mkdirSync(qdir, { recursive: true });
      try { rename(p, q); } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
        // Across drives it is copied: never more than `limits` (counted first), or it stays and is named.
        if (!treeWithin(p, limits)) { left.push(`${p} (more than ${limits.entries} entries or ${Math.round(limits.bytes / 1048576)} MB to copy across drives)`); continue; }
        cpSync(p, q, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
        rmSync(p, { recursive: true, force: true });
      }
      moved.push(p);
    } catch (e) { left.push(`${p} (${(e as Error).message.slice(0, 120)})`); }
  }
  const lines = [moved.length === 0 ? null : `moss: the run planted ${moved.join(", ")}; quarantined\n`,
    left.length === 0 ? null : `moss: the run planted ${left.join(", ")}; it could NOT be moved aside, and is still there\n`].filter((l): l is string => l !== null);
  return lines.length === 0 ? null : lines.join("");
}

/** A hook a command planted under its write roots is moved aside (rule 7); the report line, or null. */
function quarantineHooks(before: Map<string, boolean>, dirs: readonly string[], mossHome: string): string | null {
  const after = hookFiles(dirs);
  const planted = new Map<string, boolean>();
  for (const p of after.keys()) planted.set(p, before.has(p));
  return quarantineWin(planted, mossHome);
}

/** Rule 7 for the run-later names (the reviewer's "runs later" finding 1): a deny pattern (`<root>\**\.vscode`,
 *  `.envrc`, `.mcp.json`, `.claude`, `.husky`, `.git`…) is stamped only on what exists when the command starts, so a
 *  name the command MAKES under a write root carries no deny. After the run the patterns whose folder is under a write
 *  root are walked again; a match that wasn't there before is moved aside into the MOSS home's quarantine (the
 *  shallowest first, so a planted folder goes whole) and named in the result, as Linux's sandbox puts away what a
 *  command made at a held place. The Mac refuses the write itself (Seatbelt matches the pattern as the path opens);
 *  here the name exists until the command ends, so something the command itself starts could use it before then:
 *  that is the residual. `before` is the pre-run walk's result. */
export function quarantinePatternMatches(patterns: readonly string[], roots: readonly string[], before: readonly string[], mossHome: string, o: WalkOptions = {}): string | null {
  const under = patterns.filter((p) => GLOB.test(p) && roots.some((r) => winUnder(p.split(/[*?[]/)[0]!.replace(/[\\/]+$/, ""), r)));
  if (under.length === 0) return null;
  const had = new Set(before.map(fold));
  const now = existingDeniesOf(under, o);
  const unwalked = new Set(now.unwalked.map(fold));
  const fresh = now.paths.filter((p) => !had.has(fold(p)) && !unwalked.has(fold(p))).sort((a, b) => a.length - b.length);
  const planted = new Map<string, boolean>();
  for (const p of fresh) if (![...planted.keys()].some((q) => winUnder(p, q))) planted.set(p, false);
  return quarantineWin(planted, mossHome);
}

/** What the profile read grant may exclude (rule 8's floor, `grantProfile`): every literal read deny a bot's shell
 *  carries (the fence's own, the secret places of `SECRET_READ_PLACES`, the MOSS home's key places of
 *  `BOT_READ_DENIED`; `withSecretReads`, `withBotKeyReads`) inside the home. Bots read the most, so what a bot may not
 *  read, no caller may (win-fenced.test.ts checks the list against a bot's shell denies). Never the MOSS home or a
 *  folder above it, nor anything in the folders sessions are given (a bot's folder, its scratch, an agent's outputs):
 *  srt-win refuses every session grant that lies inside an exclusion, or reaches one. */
export function profileExcludeCandidates(fence: Pick<MossFence, "policy" | "contextFor" | "home" | "mossHome">): string[] {
  try {
    const bot = { kind: "session", sessionId: "profile-read-grant", sessionKind: "bot", bot: "profile-read-grant" } as Caller;
    const denied = [...fence.policy(fence.contextFor?.(bot) ?? fenceContextFor(bot)).denyRead,
      ...secretReadPlaces("windows", fence.home).map((x) => x.path), ...BOT_READ_DENIED.map((rel) => win32.join(fence.mossHome, ...rel))];
    const sessionFolders = ["bots", "scratch", "outputs"].map((d) => win32.join(fence.mossHome, d));
    return uniq(denied.filter((p) => !GLOB.test(p) && winUnder(p, fence.home) && !winUnder(fence.mossHome, p) && !sessionFolders.some((f) => winUnder(p, f))));
  } catch { return []; }
}

/** The profile read grant, by launcher and MOSS home: made once per process for each home (`grantProfile`), again
 *  after one that failed. */
const profileGrants = new Map<string, Promise<string | null>>();
/** Rule 8b: this process's commands past their exclusions' check and not yet ended, every spawner counted. */
let commandsActive = 0;
/** The exclusions the last grant this process made succeeded with, by the same key (rule 8b). */
const grantedExcludes = new Map<string, string[]>();

/** The literal paths the profile read grant in force excludes, from `srt-win profile status` (its `exclusions`: every
 *  protected path, built-in and added, of whichever run made the grant last), or [] when it can't be read or a grant
 *  is half-written (`in_progress`): then no per-exec deny is dropped. */
export function parseProfileExclusions(stdout: string): string[] {
  try {
    const o = JSON.parse(stdout) as { exclusions?: unknown; state?: unknown };
    if (o.state === "in_progress" || !Array.isArray(o.exclusions)) return [];
    return o.exclusions.filter((e): e is string => typeof e === "string").map((e) => e.replace(/^\\\\\?\\/, "")).filter((e) => !GLOB.test(e));
  } catch { return []; }
}

/** A command's plan while it runs (rule 3b): its caller, every folder its grants open to the sandbox group (its read
 *  grants AND its write roots: a root's group entry is srt-win's `MODIFY_NO_FDC`, read included), its literal read
 *  denies. */
interface PlanInFlight { readonly caller: string; readonly opens: readonly string[]; readonly denyRead: readonly string[] }
const plansInFlight = new Set<PlanInFlight>();
/** Rule 3c: every write root this process has granted, by its folded path. A root is PERSISTENT (`acl grant
 *  --persistent`): its group entry, read included, stays after the command and the daemon, so a later command of
 *  another caller whose plan denies a folder above it stamps that root by name (`strayRoots`). */
const grantedRoots = new Map<string, string>();
/** Rule 3c across a restart (the WS4 reviewer's item 2): srt-win keeps the roots it granted for this user (`user status`,
 *  `persistent_grants.roots`, and `pending` for an absent volume) after the engine that granted them is gone, so the
 *  record is seeded from that list once per process and launcher, before any command's plan is drawn. A seed that
 *  fails is not kept: the next command reads it again. */
const rootsSeeded = new Map<string, Promise<boolean>>();
/** The persistent roots srt-win lists for the calling user, as plain paths (`persistent_grants.roots`, and `pending`
 *  when present); null when the output isn't that shape (not JSON, no `persistent_grants` object, `roots` not a list
 *  of strings, `pending` present but not one): the seed then counts as failed, never as an empty list (the WS5
 *  reviewer's should-fix 2). */
export function parsePersistentRoots(stdout: string): string[] | null {
  let o: unknown;
  try { o = JSON.parse(stdout); } catch { return null; }
  if (typeof o !== "object" || o === null) return null;
  const g = (o as { persistent_grants?: unknown }).persistent_grants;
  if (typeof g !== "object" || g === null) return null;
  const { roots, pending } = g as { roots?: unknown; pending?: unknown };
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);
  if (!strings(roots) || (pending !== undefined && !strings(pending))) return null;
  return [...roots, ...(pending ?? [])].map((x) => x.replace(/^\\\\\?\\/, ""));
}
/** The roots this process granted that lie strictly under one of `denyRead` without being denied by name there, and
 *  under none of the command's own folders (`own`): each gets a read deny of its own for the command. */
export function strayRoots(granted: Iterable<string>, denyRead: readonly string[], own: readonly string[]): string[] {
  const same = (a: string, b: string) => win32.normalize(a).toUpperCase() === win32.normalize(b).toUpperCase();
  return [...granted].filter((g) => !own.some((o) => winUnder(g, o)) && !denyRead.some((d) => same(d, g)) && denyRead.some((d) => winUnder(g, d)));
}
const callerKey = (c: Caller): string => c.kind === "session" ? `session:${c.sessionId}` : c.kind === "plugin" ? `plugin:${c.pluginId}` : c.kind;
/** Two commands of different callers where one's read grant lies STRICTLY under the other's read deny and the other
 *  doesn't deny that very folder too. Windows orders an object's explicit deny before its explicit allow, and a
 *  closer inherited entry before a farther one: a grant on the denied folder itself (a bot's on the MOSS home beside a
 *  coding session's deny of it), or on a folder the other denies by name (another session's folder that existed when
 *  the other started), is still refused to it; only a deeper grant beneath a farther deny (a folder made since) would
 *  open to it. */
export function grantsConflict(x: PlanInFlight, y: PlanInFlight): boolean {
  if (x.caller === y.caller) return false;
  const same = (a: string, b: string) => win32.normalize(a).toUpperCase() === win32.normalize(b).toUpperCase();
  const opens = (a: PlanInFlight, b: PlanInFlight) => a.opens.some((g) =>
    !b.denyRead.some((d) => same(d, g)) && b.denyRead.some((d) => winUnder(g, d)));
  return opens(x, y) || opens(y, x);
}

/** The session grants this process holds (`acl grant --holder-pid <this pid>`), counted across every spawner in it
 *  (the daemon has more than one: the bot shell's and the computer node's). srt-win's `acl revoke --holder-pid`
 *  releases ALL of a holder's grants and its holds on the kept roots, so a command that ended revoking while another
 *  ran would take that one's read grants from under it (the reviewer's finding 5). The revoke runs only when the last
 *  command of this process ends; until then a root granted by an ended command stays granted, as a persistent root
 *  does anyway (only a token carrying the root's capability SID writes there). */
const heldGrants = { inFlight: 0, chain: Promise.resolve() as Promise<unknown> };
/** `f` after every grant and revoke this process started before it: a revoke never lands between another command's
 *  count and its grant. */
/** srt-win's answer while another process writes or removes the profile read grant: exit 25, its JSON code
 *  `profile_operation_in_progress`. Only that one is tried again. */
/** What a command's live output says while its session grant waits for another process's profile operation. */
export const PROFILE_BUSY_WAIT_LINE = "moss: waiting for the sandbox's setup to finish (its read access to your profile is being changed)";

export function profileBusy(r: { code: number; stdout: string; stderr: string }): boolean {
  return r.code === 25 && `${r.stderr}\n${r.stdout}`.includes("\"code\":\"profile_operation_in_progress\"");
}

function grantsInTurn<T>(f: () => Promise<T>): Promise<T> {
  const next = heldGrants.chain.then(f, f);
  heldGrants.chain = next.catch(() => {});
  return next;
}

/** The Windows leg of the fenced spawner. */
export function winFencedSpawner(o: { fence: MossFence; deps: WinFencedDeps; bots?: () => readonly string[]; grantAhead?: boolean }): FencedSpawner {
  const { fence, deps } = o;
  const refuse = (reason: string): FencedRunResult => ({ kind: "refused", reason: `a fenced process can't be started here: ${reason}` });
  /** Rule 1's first half: the pinned launcher and this owner's install. */
  const install = (): { marker: InstallMarker } | { why: string } => {
    const problem = deps.launcherProblem();
    if (problem !== null) return { why: setupBashRefusal(problem) };
    if (deps.ownerSid === null) return { why: "the user's SID can't be read" };
    if (deps.programData === null) return { why: "ProgramData can't be resolved" };
    const marker = parseInstallMarker(deps.readFile(installMarkerPath(deps.programData, deps.ownerSid)));
    if (marker === null || marker.ownerSid !== deps.ownerSid || marker.members.length === 0) return { why: setupBashRefusal(null) };
    if (marker.members.some((m) => m.principalSid === null)) return { why: setupBashRefusal("a principal's SID isn't recorded") };
    return { marker };
  };
  // The read half of the Mac's fence (rule 8): the principal reads the user's home as a Mac command does, through
  // srt-win's profile read grant, which never grants the key and credential stores, browser data or the registry hives
  // (they get a read deny instead). Written once per daemon, before its first command (srt-win refuses to change it
  // while a session it holds runs): a folder made in the home after it is not readable until the next daemon start.
  /** The machine-wide install record's sandbox user (`HKLM\SOFTWARE\sandbox-runtime`, `SandboxUserSid`, which
   *  srt-win's `acl grant --persistent` checks its `--sandbox-user-sid` against): read from the registry, where every
   *  user may read it, because `srt-win user status` withholds that record from a standard user (it carries no owner;
   *  only the per-principal records do). Read at each command (a `setup --force` may change it). */
  const installedSandboxSid = async (): Promise<string | null> => {
    const r = await deps.exec(["reg", "query", "HKLM\\SOFTWARE\\sandbox-runtime", "/v", "SandboxUserSid"], { timeoutMs: 15_000 });
    if (r.code !== 0) return null;
    const m = /SandboxUserSid\s+REG_SZ\s+(S-1-[0-9-]+)/i.exec(r.stdout);
    return m ? m[1]! : null;
  };
  // Rule 8's floor, kept in the profile read grant itself (`--exclude`: never granted, a read deny of its own, kept
  // while the grant is): every literal path of the fenced read set inside the home that exists when the grant is made.
  // The set is a bot's (`profileExcludes`): bots read the most, so what a bot may not read, no caller may. Two things
  // follow:
  //  - What the daemon writes WHILE a command runs (the reviewer's finding 2): with an exclusion beneath it, each
  //    folder on the way is granted child by child instead of whole, so a file the daemon makes there later (a
  //    settings or secrets file written to a temporary name and renamed over the old one, a new one) carries no
  //    grant at all, unreadable to a running command until the daemon's next start grants what is readable again.
  //  - Speed: a per-exec read deny under the profile grant is also stamped on every allow the grant recorded beneath
  //    it, then taken off after (srt-win's deny expansion: seconds a command); what is excluded here needs no per-exec
  //    deny at all (`perExecReadDenies`).
  const profileExcludes = (): string[] => profileExcludeCandidates(fence).filter((p) => existsSync(p)).slice(0, 400);
  /** A command's read denies less what the profile grant IN FORCE excludes (a path at or under one), read back at
   *  each command (the reviewer's WS2 finding 1): another engine of the same Windows user, with another home, makes
   *  the grant too, so what this process asked for is never assumed to hold. Unreadable: nothing is dropped. */
  const perExecReadDenies = async (denies: readonly string[]): Promise<string[]> => {
    if (denies.length === 0) return [];
    const st = await deps.exec([deps.launcher, "profile", "status"], { timeoutMs: 30_000 });
    const ex = st.code === 0 ? parseProfileExclusions(st.stdout) : [];
    return ex.length === 0 ? [...denies] : denies.filter((d) => !ex.some((e) => winUnder(d, e)));
  };
  // A grant that failed is not kept: the next command tries again (the reviewer's finding 5), so one failure (a
  // command of another daemon running, srt-win's exit 24) doesn't leave the home unreadable until a restart.
  // One grant per process and home, whichever spawner asks first (the daemon has two). The exclusions are ADDED to
  // what earlier runs recorded (no `--replace-excludes`): another engine's home keeps its own (srt-win keeps every
  // added exclusion until `profile forget`, which `sandbox forget` runs at uninstall).
  const grantKey = `${deps.launcher}\u0000${fold(fence.mossHome)}`;
  const grantProfile = (): Promise<string | null> => {
    const had = profileGrants.get(grantKey);
    if (had !== undefined) return had;
    const p = (async () => {
      const started = Date.now();
      // Another process's profile operation holds srt-win's lock (exit 25: another engine on this user, or the CLI's
      // `sandbox forget`): this grant waits it out the same bounded while a session grant does, then fails as before.
      const busyUntil = Date.now() + (deps.profileBusyWaitMs ?? 120_000);
      const grant = async (ex: readonly string[]) => {
        for (;;) {
          const r = await deps.exec([deps.launcher, "profile", "grant", "--quiet", "--json", ...ex.flatMap((p) => ["--exclude", p])], { timeoutMs: 1_800_000 });
          if (!profileBusy(r) || Date.now() >= busyUntil) return r;
          await Bun.sleep(deps.profileBusyPollMs ?? 1_000);
        }
      };
      let excludes = profileExcludes();
      let r = await grant(excludes);
      // srt-win makes each protected folder of its own list that is missing (`.aws`, `.kube`, `.gnupg`…) to carry its
      // deny: they exist now, so the list is read again and, when it grew, granted again (a later run writes only what
      // changed). Then no per-exec deny is left on a path the grant denies already, and a launch with no per-exec read
      // deny never loads the grant's record (srt-win reads it whole for the first read deny: 15–25 s on the runner).
      if (r.code === 0) {
        const again = profileExcludes();
        if (again.some((p) => !excludes.some((e) => fold(e) === fold(p)))) { const r2 = await grant(again); if (r2.code === 0) excludes = again; else r = r2; }
      }
      const took = `${Math.round((Date.now() - started) / 1000)} s`;
      if (r.code === 0) { grantedExcludes.set(grantKey, excludes); return null; }
      profileGrants.delete(grantKey);
      // srt-win's own words (its `error:` line, else its last line), so a refusal in no time at all says what it was.
      const said = r.stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
      const why = (said.find((l) => /\berror\b/i.test(l)) ?? said[said.length - 1] ?? "").replace(/^srt-win:\s*/, "").slice(0, 240);
      return `the read grant on your profile didn't complete (srt-win exit ${r.code}, ${took}${why === "" ? "" : `: ${why}`}): commands can't read your home folder yet`;
    })();
    profileGrants.set(grantKey, p);
    return p;
  };
  // Rule 8b (lane WS7): the exclusions follow the fenced set. A secret folder made after the grant (a new key store, a
  // new place the fence names) is excluded only by a per-command deny, which costs its stamp and its parent's every
  // command; so before a command, when no command of this process holds session grants (srt-win refuses a grant while
  // one does), the exclusions are read again and, when one was added, the grant is made again with them (a run that
  // changes only what changed). A command that comes meanwhile waits for it; one that fails (another engine's command,
  // srt-win's exit 24) leaves the grant as it was, and the per-command denies stand in until a later command tries.
  let refreshing: Promise<void> | null = null;
  const counted = new Set<FencedRun>();
  const refreshExcludes = async (): Promise<void> => {
    if (refreshing !== null) return refreshing;
    const had = grantedExcludes.get(grantKey);
    // The command asking is counted already (`runOne`): none other may be.
    if (had === undefined || heldGrants.inFlight > 0 || plansInFlight.size > 0 || commandsActive > 1) return;
    const now = profileExcludes();
    if (!now.some((p) => !had.some((e) => fold(e) === fold(p)))) return;
    refreshing = (async () => {
      const merged = uniq([...had, ...now]);
      const r = await deps.exec([deps.launcher, "profile", "grant", "--quiet", "--json", ...merged.flatMap((p) => ["--exclude", p])], { timeoutMs: 1_800_000 });
      if (r.code === 0) grantedExcludes.set(grantKey, merged);
    })().finally(() => { refreshing = null; });
    return refreshing;
  };
  // The read grant is made when the spawner is, off any command's path (its first run walks the profile: ~18 s on the
  // runner); a command that comes before it ends waits for it, as before.
  if (o.grantAhead !== false) setTimeout(() => { if (!("why" in install())) void grantProfile(); }, 0);
  /** Rule 3c's seed (`rootsSeeded`): srt-win's own list of this user's persistent roots, once per process. */
  // No command runs until the seed has succeeded (the WS5 reviewer's should-fix 2): without it, a root granted before
  // this engine started could open another caller's folder to a running command. A failed read is not kept: the
  // next command reads it again. True when seeded.
  const seedRoots = async (): Promise<boolean> => {
    let p = rootsSeeded.get(deps.launcher);
    if (p === undefined) {
      p = (async () => {
        const st = await deps.exec([deps.launcher, ...USER_STATUS_ARGS], { timeoutMs: 30_000 });
        if (st.code !== 0) return false;
        const roots = parsePersistentRoots(st.stdout);
        if (roots === null) return false;
        for (const x of roots) grantedRoots.set(fold(x), x);
        return true;
      })();
      rootsSeeded.set(deps.launcher, p);
    }
    const ok = await p;
    if (!ok) rootsSeeded.delete(deps.launcher);
    return ok;
  };
  return {
    get available() { return !("why" in install()); },
    // Rule 8b's count: every command of this process from its exclusions' check to its end, so a fresh grant waits
    // until none is between that check and its own session grant.
    run: async (r: FencedRun): Promise<FencedRunResult> => {
      try { return await runOne(r); } finally { if (counted.delete(r)) commandsActive--; }
    },
  };

  async function runOne(r: FencedRun): Promise<FencedRunResult> {
    {
      if (r.signal?.aborted) return { kind: "refused", reason: "cancelled before it started" };
      const got = install();
      if ("why" in got) return refuse(got.why);
      // Counted before the exclusions' check (the WS7 reviewer's nit): another command's check then sees this one.
      commandsActive++;
      counted.add(r);
      const readNote = await grantProfile();
      if (readNote === null) await refreshExcludes();
      const shell: WinShell = r.shell ?? "bash";
      const exe = shell === "powershell" ? deps.shells.powershell : deps.shells.bash;
      if (exe === null) return refuse(shell === "powershell" ? "Windows PowerShell isn't in System32" : "Git for Windows' bash isn't installed (Program Files\\Git, or this user's Programs\\Git)");
      // Rules 2 and 9: a principal for this command alone, and a fresh one.
      let leases: LeaseStore;
      try { leases = deps.leases(); } catch (e) { return refuse(e instanceof Error ? e.message : String(e)); }
      // Each phase's time, on stderr with MOSS_WIN_FENCE_TIMING=1 (the windows-fence workflow's measurement).
      const phases: string[] = [];
      let at = Date.now();
      const mark = (name: string) => { const now = Date.now(); phases.push(`${name} ${now - at} ms`); at = now; };
      // Rule 5: an approved escape runs only as the escape account (the network but the metadata address), every other
      // command only as a pool account (no network); an install without the escape account refuses the escape.
      const members = got.marker.members.filter((m) => (m.network === true) === (r.network === true));
      if (members.length === 0) return refuse(r.network === true ? "the escape account isn't set up; run `moss-core sandbox setup` again" : setupBashRefusal(null));
      // The command's folder must be there: the launcher starts in it (the process's own cwd), so a missing one makes the spawn itself
      // fail with an ENOENT that reads as a missing launcher. Said plainly here; a folder that exists but the sandbox account
      // can't enter is the launcher's own `cwd_unusable` (win-launch-errors.ts).
      const folder = missingFolderNote(r.cwd);
      if (folder !== null) return refuse(folder);
      // Rule 3c's seed first, before an account is leased: a refusal here uses no account up (leasing marks a generation used, and a failed
      // read can wait up to 30 s for `user status`). It needs neither the plan nor the account.
      if (!(await seedRoots())) return refuse("the sandbox's list of folders it already opened (srt-win user status) couldn't be read; try again in a moment, and if it keeps failing run `moss-core sandbox setup` again, or restart MOSS");
      mark("seed");
      const lease = await leaseFresh(leases, { ...got.marker, members }, deps.ownerSid!);
      mark("lease");
      if (!lease.ok) return refuse(lease.reason);
      let runHome: string | null = null;
      let flight: PlanInFlight | null = null;
      try {
        const drawn = r.sandbox !== undefined ? planFromSettings(r.sandbox) : planFromPolicy(fence, r.who.caller, r.cwd, { ...(o.bots ? { bots: o.bots() } : {}) });
        const session = r.who.caller.kind === "session" ? r.who.caller.sessionId : "shared";
        const sessionTemp = win32.join(fence.temp, `moss-${session.replace(/[^A-Za-z0-9._-]/g, "_")}`);
        try { mkdirSync(sessionTemp, { recursive: true }); } catch { /* the grant below reports it */ }
        const mapped = windowsRoots(drawn.writeRoots, { home: fence.home, temp: fence.temp, sessionTemp,
          homeFolders: () => ordinaryTopFolders(fence.home, { os: "windows", mossHome: fence.mossHome, pathFolders: [] }) });
        const plan: WinPlan = { ...drawn, writeRoots: mapped, denyReadExcept: uniq([...mapped, ...drawn.readGrants]) };
        // The caller's own folders exist before they are granted: a root must be on the disk to carry its ACE.
        for (const root of plan.writeRoots) {
          if (winUnder(root, fence.mossHome)) { try { mkdirSync(root, { recursive: true }); } catch { /* the grant below reports it */ } }
        }
        const roots = plan.writeRoots.filter((p) => existsSync(p));
        const grantPlan = { ...plan, writeRoots: roots };
        const temp = r.env.TMPDIR !== undefined && roots.some((x) => winUnder(r.env.TMPDIR!, x)) ? r.env.TMPDIR : sessionTemp;
        // Rule 6: the command's home is a folder of its own inside its temp folder, made now and removed after it,
        // so what a tool keeps in its home (a git config, a cache) goes with the command too.
        runHome = win32.join(temp, `.moss-home-${randomBytes(6).toString("hex")}`);
        try { mkdirSync(win32.join(runHome, "AppData", "Roaming"), { recursive: true }); mkdirSync(win32.join(runHome, "AppData", "Local"), { recursive: true }); }
        catch (e) { return refuse(`its home folder ${runHome} can't be made (${e instanceof Error ? e.message : String(e)})`); }
        const template = gitTemplateDir(fence.mossHome);
        try { mkdirSync(template, { recursive: true }); } catch { /* git then finds no template, and copies nothing */ }
        // Rule 3: the session's write roots, held by the daemon (`--holder-pid`), each with its capability SID. The
        // roots' entries are for the sandbox group every pool member is in (the patched launcher's shared group), and
        // srt-win records them against the installed sandbox user, the install record's own (`marker_user_sid`):
        // so they are granted as that user, whichever member runs this command.
        mark("plan");
        // Rule 3b (the reviewer's WS2 finding 6): read grants are the sandbox group's, so while two commands run, each
        // can read what the other's grant opens. Read grants are a caller's own folders in the MOSS home (and the home
        // itself for a bot), and every plan denies by name the others' folders that exist when it starts; but a grant
        // on a folder made AFTER the other started carries an explicit allow that beats the farther deny the other
        // has above it. So a command waits while one of another caller runs whose read grant lies strictly under its
        // own read deny, or the reverse (`grantsConflict`): never both at once. Anything else a running command can
        // read through another's grant, its own plan allows too. A write root opens as a read grant does (its group
        // entry includes read, the WS3 reviewer's finding 1): a coding session's first command makes its outputs
        // folder a root while another's runs, so both count. Rule 3c: a root this process granted earlier, strictly
        // under one of this plan's read denies, is denied by name for this command (`strayRoots`).
        const own = uniq([...plan.writeRoots, ...plan.readGrants]);
        const literalDenies = plan.denyRead.filter((d) => !GLOB.test(d));
        const stray = strayRoots(grantedRoots.values(), literalDenies, own);
        // Only what is granted opens anything: the roots that exist (a missing one isn't granted) and the read grants.
        flight = { caller: callerKey(r.who.caller), opens: uniq([...roots, ...plan.readGrants]), denyRead: [...literalDenies, ...stray] };
        const waitUntil = Date.now() + (deps.leaseTimeoutMs ?? 120_000);
        while ([...plansInFlight].some((y) => grantsConflict(flight!, y))) {
          if (Date.now() >= waitUntil) return refuse("another session's command holds read grants this one may not share; try again when it ends");
          await Bun.sleep(deps.leasePollMs ?? 250);
        }
        plansInFlight.add(flight);
        const installed = await installedSandboxSid();
        if (installed === null) return refuse("the launcher reports no installed sandbox user; run `moss-core sandbox setup` again");
        const grantSid = installed;
        // srt-win refuses every session grant while ANOTHER process writes or removes the profile read grant (exit 25):
        // this engine's own grant is awaited above, so that is another engine on this user (a second home) or the CLI's
        // `sandbox forget`. Tried again, a bounded while, then refused as before. The wait is what a principal lease waits
        // (2 minutes): srt-win answers 25 only while a LIVE profile operation holds its init lock (an OS lock let go when
        // its process dies, and its holder word checked), and those operations queue on that one lock, each 15-25 s on the
        // runner and often two per engine (the grant, then again for the folders it made): row 150 still met one after
        // 20 s (run 46003230665).
        const busyUntil = Date.now() + (deps.profileBusyWaitMs ?? 120_000);
        let grant: { code: number; stdout: string; stderr: string };
        let saidWaiting = false;
        for (;;) {
          grant = await grantsInTurn(() => {
            heldGrants.inFlight++;
            return deps.exec(sessionGrantArgs({ launcher: deps.launcher, sid: grantSid, holderPid: process.pid }), {
              stdin: sessionGrantInput({ read: grantPlan.readGrants.filter((g) => !roots.some((x) => winUnder(g, x))), write: roots }), timeoutMs: 600_000,
            });
          });
          if (!profileBusy(grant) || Date.now() >= busyUntil) break;
          heldGrants.inFlight--;
          // Said once while it waits (srt-win itself waited 3 s before answering busy), to whoever streams the output.
          if (!saidWaiting) {
            saidWaiting = true;
            try { r.onOutput?.(`${PROFILE_BUSY_WAIT_LINE}\n`, "stderr"); } catch { /* a listener never fails the command */ }
          }
          await Bun.sleep(deps.profileBusyPollMs ?? 1_000);
        }
        try {
          mark("grant");
          if (grant.code !== 0) return refuse(`srt-win acl grant exited ${grant.code}: ${(grant.stderr || grant.stdout).trim().slice(0, 400)}`);
          for (const x of roots) grantedRoots.set(fold(x), x);
          // Rule 4: what exists of the fenced set, stamped for this command; past a root's walk budget, the folders it
          // didn't read are denied whole (`existingDeniesOf`). And rule 3c's stray roots, by name.
          const readWalk = existingDeniesOf(plan.denyRead);
          const denyRead = await perExecReadDenies(uniq([...readWalk.paths, ...stray.filter((x) => existsSync(x))]));
          const writeWalk = existingDeniesOf(plan.denyWrite);
          // Only a write deny at or under a write root is stamped: nothing outside the roots is writable with the
          // write-restricted token (rule 3), and each stamp on a folder is a DACL write Windows carries down its whole
          // tree, then takes back after the command (tens of seconds on a big one).
          const denyWrite = writeWalk.paths.filter((d) => roots.some((x) => winUnder(d, x)));
          mark("denies");
          // Rule 4's belt: a fenced path that doesn't exist yet but could be made inside a write root (a PowerShell
          // profile under Documents when the home's folders are written) can't carry a deny; if the command makes it,
          // it is moved aside after the run, as on Linux (`quarantineWin`).
          const missingFenced = new Map<string, boolean>();
          for (const d of plan.denyWrite) {
            if (GLOB.test(d) || !roots.some((x) => winUnder(d, x) && fold(d) !== fold(x))) continue;
            let there = false;
            try { lstatSync(d); there = true; } catch { /* missing */ }
            if (!there && missingFenced.size < 2_000) missingFenced.set(d, false);
          }
          const gitRoot = deps.shells.bash === null ? null : win32.dirname(win32.dirname(deps.shells.bash));
          const env = winChildEnv({ profileRoot: runHome, temp, systemRoot: deps.systemRoot, gitRoot, gitTemplate: template });
          const built = winExecArgv({ launcher: deps.launcher, user: lease.principal, plan: grantPlan, denyRead, denyWrite, env, shell: shellArgv(shell, exe, r.command), heldBy: process.pid });
          if ("refused" in built) return refuse(built.refused);
          // Rule 7's snapshot: the git places under the roots as they are now.
          const places = gitPlaces(roots);
          const configBefore = snapshotFiles(places.configs);
          const hooksBefore = hookFiles(places.hooks);
          mark("snapshot");
          const runShell: RunShell = shell === "powershell" ? "none" : "git-bash";
          // MOSS_WIN_FENCE_TIMING=1 (the windows-fence workflow): the broker says what it stamped (no `--quiet`), and
          // its own lines go to the timing line, never into the command's output.
          const timing = process.env.MOSS_WIN_FENCE_TIMING === "1";
          const argv = timing ? built.argv.filter((a, i) => !(a === "--quiet" && i < built.argv.indexOf("--"))) : built.argv;
          // Rule 8c (lane WS7, the WS7 reviewer's items 1 and 3; lane WS8): a long command is planned and stamped once, at
          // its start, so what the fence protects that appears later would stay open to it for its whole life, and the
          // profile grant's refresh (rule 8b) can't run while it holds its session grant. So while it runs, its fenced
          // set is looked at again every `fenceWatchMs` (`lateFenceStep` decides):
          //  - a new path its read denies match (`watchedReadDenies`: the literal ones and the fixed-depth globs; a new
          //    conversation's transcript sidecar in the MOSS home, made in a folder the command reads, is the common
          //    one) is stamped for the command's own account, live (`acl stamp`, held by this process, released when
          //    the command ends): the command keeps running, and the path is closed to it from that look on. Only when
          //    the stamp fails is it ended. (Lane WS8: ending it on each new sidecar ended every background command at
          //    every new conversation.)
          //  - a new protected ROOT (a place the profile grant must now exclude, compared with what the grant IN FORCE
          //    holds, the WS7 reviewer's point) ends it: the grant is made again only when no command runs.
          // Between a path's appearing and the next look it is open to the command: that is the window (`fenceWatchMs`,
          // 5 s; one look costs a few ms). Write denies are not watched: inside its own write roots the command makes
          // such paths itself (a `git clone` makes `.git\hooks`), dealt with after it as for any command (rule 4's belt).
          // A foreground command has no watch: it lives at most its 10-minute limit, and the next one is planned anew.
          const memberSid = got.marker.members.find((m) => m.principal === lease.principal)?.principalSid ?? null;
          let stampedLate = false;
          const fenceWatch = r.onFenceGrew === undefined ? null : (() => {
            const had = new Set(watchedReadDenies(plan.denyRead).map(fold));
            let busy = false, done = false;
            const end = () => { done = true; clearInterval(t); try { r.onFenceGrew!(); } catch { /* the caller's own */ } };
            const t = setInterval(() => {
              if (busy || done) return;
              busy = true;
              void (async () => {
                const granted = grantedExcludes.get(grantKey);
                const step = lateFenceStep({
                  freshReads: watchedReadDenies(plan.denyRead).filter((x) => !had.has(fold(x))),
                  excludesGrew: granted !== undefined && profileExcludes().some((x) => !granted.some((e) => fold(e) === fold(x))),
                  sid: memberSid,
                });
                if (step.kind === "end") return end();
                if (step.kind === "none") return;
                const stamped = await deps.exec([deps.launcher, "acl", "stamp", "--holder-pid", String(process.pid), "--sandbox-user-sid", memberSid!],
                  { stdin: JSON.stringify({ denyRead: step.paths, denyWrite: [] }), timeoutMs: 60_000 });
                if (stamped.code !== 0) return end();
                stampedLate = true;
                for (const x of step.paths) had.add(fold(x));
                if (process.env.MOSS_WIN_FENCE_TIMING === "1") console.error(`[win-fence] ${lease.principal}: stamped late: ${step.paths.map((x) => win32.basename(x)).join(",")}`);
              })().catch(() => end()).finally(() => { busy = false; });
            }, deps.fenceWatchMs ?? 5_000);
            return t;
          })();
          const ran = await runCommand({ ...r, env: minimalChildEnv() }, { shell: runShell, argv })
            .finally(() => { if (fenceWatch !== null) clearInterval(fenceWatch); });
          // What was stamped late is this process's hold for this account: let go now the command has ended.
          if (stampedLate && memberSid !== null) {
            await deps.exec([deps.launcher, "acl", "restore", "--holder-pid", String(process.pid), "--sandbox-user-sid", memberSid], { timeoutMs: 120_000 });
          }
          mark("exec");
          if (ran.kind === "refused") return ran;
          let result = ran;
          if (timing) {
            const said = ran.stderr.split(/\r?\n/).filter((l) => l.startsWith("srt-win:"));
            phases.push(`denies ${denyRead.length}r/${denyWrite.length}w (read: ${denyRead.map((d) => win32.basename(d)).join(",").slice(0, 300)}), except ${grantPlan.denyReadExcept.length}, roots ${roots.length}; ${said.join(" | ").slice(0, 1500)}`);
            result = { ...ran, stderr: ran.stderr.split(/\r?\n/).filter((l) => !l.startsWith("srt-win:")).join("\n") };
          }
          // A folder the launcher couldn't start the command in is said in words, not as its JSON line and exit code.
          if (ran.kind === "exited") {
            const refused = explainLauncherCwd(ran.code, ran.stderr);
            if (refused !== null) result = { ...result, stderr: `${refused}\n` };
          }
          const after = gitPlaces(roots);
          for (const p of after.configs) if (!configBefore.has(p)) configBefore.set(p, null);
          const notes = [readNote === null ? null : `moss: ${readNote}\n`, revertPlantedGitKeys(configBefore), quarantineHooks(hooksBefore, after.hooks, fence.mossHome), quarantineWin(missingFenced, fence.mossHome),
            quarantinePatternMatches(plan.denyWrite, roots, writeWalk.paths, fence.mossHome)].filter((n): n is string => n !== null);
          mark("belt");
          return notes.length === 0 ? result : { ...result, stderr: result.stderr + notes.join("") };
        } finally {
          // The per-session claims end with the last command of this process (`heldGrants`); the persistent roots stay
          // (only a token carrying a root's capability SID writes there, and only a command whose sandbox names it).
          await grantsInTurn(async () => {
            if (--heldGrants.inFlight === 0) await deps.exec(sessionRevokeArgs({ launcher: deps.launcher, sid: grantSid, holderPid: process.pid }), { timeoutMs: 120_000 });
          });
          mark("revoke");
          if (process.env.MOSS_WIN_FENCE_TIMING === "1") console.error(`[win-fence] ${lease.principal}: ${phases.join(", ")}`);
        }
      } finally {
        if (flight !== null) plansInFlight.delete(flight);
        lease.release();
        if (runHome !== null) { try { rmSync(runHome, { recursive: true, force: true }); } catch { /* best effort: it is in the command's own temp */ } }
        // Rule 9: the principal's profile and hive go now, before another command takes it (the reset task, SYSTEM).
        void deps.exec(runResetTaskArgs(deps.ownerSid!), { timeoutMs: 30_000 });
      }
    }
  }

  /** Rules 2 and 9: lease a pool member no command holds (its `.lock`, an OS lock the reset takes too) whose profile
   *  the reset remade since its last command (`isFreshGeneration`: its `.gen` isn't its `.used`). The generation is
   *  marked used BEFORE the command runs, so a command that dies half way still leaves its principal for the reset. A
   *  member not remade yet is let go and the reset task asked for; past the wait, the command is refused, never run on
   *  a profile another command wrote. The reset's own work (delete and `CreateProfile`, ~10 s a member) is off every
   *  command's path: the task is started when a command ends. */
  async function leaseFresh(leases: LeaseStore, marker: InstallMarker, ownerSid: string): Promise<{ ok: true; principal: string; release: () => void } | { ok: false; reason: string }> {
    // Up to two minutes: when more commands come at once than the pool has principals, the later ones wait for the
    // reset to remake one (~10–30 s each on the runner, one at a time) rather than being refused.
    const deadline = Date.now() + (deps.leaseTimeoutMs ?? 120_000);
    let asked = 0;
    let stale = 0;
    for (;;) {
      stale = 0;
      for (const m of marker.members) {
        const files = poolStateFiles(deps.leasesDir, m.principal);
        const guard = leases.tryLock(files.lock);
        if (guard === null) continue;
        const gen = deps.readFile(files.gen);
        if (isFreshGeneration(gen, deps.readFile(files.used)) && deps.writeFile(files.used, gen!.trim())) {
          let released = false;
          return { ok: true, principal: m.principal, release: () => { if (!released) { released = true; guard.release(); } } };
        }
        stale++;
        guard.release();
      }
      if (stale > 0 && Date.now() - asked >= 3_000) { asked = Date.now(); await deps.exec(runResetTaskArgs(ownerSid), { timeoutMs: 30_000 }); }
      if (Date.now() >= deadline) {
        return { ok: false, reason: stale > 0
          ? "no sandbox account was reset since its last command (the reset task didn't run, or couldn't remake its profile); run `moss-core sandbox setup` again"
          : `the sandbox pool is busy; all ${marker.members.length} accounts run a command` };
      }
      await Bun.sleep(deps.leasePollMs ?? 500);
    }
  }
}
