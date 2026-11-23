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
//     The session's grants are revoked only when this process's last command ends (`heldGrants`).
//  4. Denies: every fenced path of the run's sandbox that exists is stamped `--deny-write` / `--deny-read` for this
//     command; a glob is expanded over what exists, one walk per folder with its own budget, and past it the folders
//     not read are denied whole (`existingDeniesOf`); a deny wins over every allow (an explicit deny ACE comes first).
//     A fenced path that doesn't exist yet can only be made inside a write root; rule 7 puts it away after the run.
//  5. Network: the principal's WFP filters (installed by setup, loopback closed) refuse every connection but the
//     loopback proxy range 60080–60089, as `srt-win install` sets them; no `--allow-loopback` is ever passed.
//  6. Environment: built here, whole. The broker gets a fixed system environment; the child gets a home folder of its
//     own, made for the command inside its temp folder and removed after it, as HOME/USERPROFILE/APPDATA (never the
//     user's: the controller's ruling 2, and the M1 floor's "HOME and TEMP in the session's own temp"), its run's temp
//     folder as TEMP/TMP, a fixed PATH and MOSS's empty git template. Nothing of the daemon's environment reaches it.
//  7. Run later: after the run, a git config key a command set in a repo under its write roots is reverted, a hook it
//     planted in such a repo's `.git/hooks` is moved aside, and a fenced path or run-later name (`.vscode`, `.envrc`,
//     `.git`…) it made under a root is moved aside and named in the result (`revertPlantedGitKeys`,
//     `quarantineHooks`, `quarantinePlanted`, `quarantinePatternMatches`): Linux's way, where the Mac refuses the write.
//  8. Reads: the user's profile through srt-win's profile read grant (`grantProfile`), less every `denyRead`.
//  9. Nothing carries over (spec §9.1): after each command the reset task (SYSTEM, `sandbox reset`) deletes the
//     principal's whole profile and hive and makes a fresh one from the default profile, then writes a new generation;
//     a command runs only as a principal whose generation isn't the one last used (`leaseFresh`), and marks it used
//     before it starts. The reset is off the command's path; checked at every launch; failing closed.
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join, win32 } from "node:path";
import type { SandboxSettingsConfig } from "@waifucave/clover-agent-sdk";
import type { Caller } from "@waifucave/moss-protocol";
import { fenceContextFor } from "../contracts/fence";
import type { MossFence } from "./fence";
import { gitTemplateDir } from "./layout";
import { ordinaryTopFolders } from "./sandbox-settings";
import { quarantinePlanted, reposUnder, revertPlantedGitKeys, snapshotFiles } from "./fenced-process";
import { runCommand, type FencedRun, type FencedRunResult, type FencedSpawner, type RunShell } from "./spawn";
import {
  createWindowsLockStore, execArgs, isFreshGeneration, poolStateDir, poolStateFiles, runResetTaskArgs, installMarkerPath, launcherProblem, minimalChildEnv, parseInstallMarker,
  sandboxLeasesDir, sessionGrantArgs, sessionGrantInput,
  sessionRevokeArgs, setupBashRefusal, srtWinArch, srtWinPath, winLaunchPlan, type InstallMarker, type LeaseStore,
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
/** Whether `child` is `dir` or sits under it, folded as NTFS compares names. */
export function winUnder(child: string, dir: string): boolean {
  const c = fold(child), d = fold(dir);
  return c === d || c.startsWith(`${d}\\`);
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
export function planFromPolicy(fence: Pick<MossFence, "policy" | "mossHome" | "temp" | "contextFor">, caller: Caller, cwd: string, o: { bots?: readonly string[]; entries?: (dir: string) => readonly string[] } = {}): WinPlan {
  const ctx = fence.contextFor?.(caller) ?? fenceContextFor(caller);
  const policy = fence.policy(ctx);
  const plan = winLaunchPlan({ policy, mossHome: fence.mossHome, caller, bots: o.bots ?? [], ...(o.entries ? { entries: o.entries } : {}) });
  const denied = (p: string) => plan.denyWrite.some((d) => winUnder(p, d) && !plan.grantWrite.some((g) => winUnder(p, g)));
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

/** A hook a command planted under its write roots is moved aside (rule 7); the report line, or null. */
function quarantineHooks(before: Map<string, boolean>, dirs: readonly string[], mossHome: string): string | null {
  const after = hookFiles(dirs);
  const planted = new Map<string, boolean>();
  for (const p of after.keys()) planted.set(p, before.has(p));
  return quarantinePlanted(planted, mossHome);
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
  return quarantinePlanted(planted, mossHome);
}

/** The profile read grant, by launcher: made once per process (`grantProfile`), again after one that failed. */
const profileGrants = new Map<string, Promise<string | null>>();

/** The session grants this process holds (`acl grant --holder-pid <this pid>`), counted across every spawner in it
 *  (the daemon has more than one: the bot shell's and the computer node's). srt-win's `acl revoke --holder-pid`
 *  releases ALL of a holder's grants and its holds on the kept roots, so a command that ended revoking while another
 *  ran would take that one's read grants from under it (the reviewer's finding 5). The revoke runs only when the last
 *  command of this process ends; until then a root granted by an ended command stays granted, as a persistent root
 *  does anyway (only a token carrying the root's capability SID writes there). */
const heldGrants = { inFlight: 0, chain: Promise.resolve() as Promise<unknown> };
/** `f` after every grant and revoke this process started before it: a revoke never lands between another command's
 *  count and its grant. */
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
  // A grant that failed is not kept: the next command tries again (the reviewer's finding 5), so one failure (a
  // command of another daemon running, srt-win's exit 24) doesn't leave the home unreadable until a restart.
  // One grant per process, whichever spawner asks first (the daemon has two).
  const grantProfile = (): Promise<string | null> => {
    const had = profileGrants.get(deps.launcher);
    if (had !== undefined) return had;
    const p = (async () => {
      const started = Date.now();
      const r = await deps.exec([deps.launcher, "profile", "grant", "--quiet", "--json"], { timeoutMs: 1_800_000 });
      const took = `${Math.round((Date.now() - started) / 1000)} s`;
      if (r.code === 0) return null;
      profileGrants.delete(deps.launcher);
      return `the read grant on your profile didn't complete (srt-win exit ${r.code}, ${took}): commands can't read your home folder yet`;
    })();
    profileGrants.set(deps.launcher, p);
    return p;
  };
  // The read grant is made when the spawner is, off any command's path (its first run walks the profile: ~18 s on the
  // runner); a command that comes before it ends waits for it, as before.
  if (o.grantAhead !== false) setTimeout(() => { if (!("why" in install())) void grantProfile(); }, 0);
  return {
    get available() { return !("why" in install()); },
    run: async (r: FencedRun): Promise<FencedRunResult> => {
      if (r.signal?.aborted) return { kind: "refused", reason: "cancelled before it started" };
      const got = install();
      if ("why" in got) return refuse(got.why);
      const readNote = await grantProfile();
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
      const lease = await leaseFresh(leases, got.marker, deps.ownerSid!);
      mark("lease");
      if (!lease.ok) return refuse(lease.reason);
      let runHome: string | null = null;
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
        const installed = await installedSandboxSid();
        if (installed === null) return refuse("the launcher reports no installed sandbox user; run `moss-core sandbox setup` again");
        const grantSid = installed;
        const grant = await grantsInTurn(() => {
          heldGrants.inFlight++;
          return deps.exec(sessionGrantArgs({ launcher: deps.launcher, sid: grantSid, holderPid: process.pid }), {
            stdin: sessionGrantInput({ read: grantPlan.readGrants.filter((g) => !roots.some((x) => winUnder(g, x))), write: roots }), timeoutMs: 600_000,
          });
        });
        try {
          mark("grant");
          if (grant.code !== 0) return refuse(`srt-win acl grant exited ${grant.code}: ${(grant.stderr || grant.stdout).trim().slice(0, 400)}`);
          // Rule 4: what exists of the fenced set, stamped for this command; past a root's walk budget, the folders it
          // didn't read are denied whole (`existingDeniesOf`).
          const denyRead = existingDeniesOf(plan.denyRead).paths;
          const writeWalk = existingDeniesOf(plan.denyWrite);
          const denyWrite = writeWalk.paths;
          mark("denies");
          // Rule 4's belt: a fenced path that doesn't exist yet but could be made inside a write root (a PowerShell
          // profile under Documents when the home's folders are written) can't carry a deny; if the command makes it,
          // it is moved aside after the run, as on Linux (`quarantinePlanted`).
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
          const result = await runCommand({ ...r, env: minimalChildEnv() }, { shell: runShell, argv: built.argv });
          mark("exec");
          if (result.kind === "refused") return result;
          const after = gitPlaces(roots);
          for (const p of after.configs) if (!configBefore.has(p)) configBefore.set(p, null);
          const notes = [readNote === null ? null : `moss: ${readNote}\n`, revertPlantedGitKeys(configBefore), quarantineHooks(hooksBefore, after.hooks, fence.mossHome), quarantinePlanted(missingFenced, fence.mossHome),
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
        lease.release();
        if (runHome !== null) { try { rmSync(runHome, { recursive: true, force: true }); } catch { /* best effort: it is in the command's own temp */ } }
        // Rule 9: the principal's profile and hive go now, before another command takes it (the reset task, SYSTEM).
        void deps.exec(runResetTaskArgs(deps.ownerSid!), { timeoutMs: 30_000 });
      }
    },
  };

  /** Rules 2 and 9: lease a pool member no command holds (its `.lock`, an OS lock the reset takes too) whose profile
   *  the reset remade since its last command (`isFreshGeneration`: its `.gen` isn't its `.used`). The generation is
   *  marked used BEFORE the command runs, so a command that dies half way still leaves its principal for the reset. A
   *  member not remade yet is let go and the reset task asked for; past the wait, the command is refused, never run on
   *  a profile another command wrote. The reset's own work (delete and `CreateProfile`, ~10 s a member) is off every
   *  command's path: the task is started when a command ends. */
  async function leaseFresh(leases: LeaseStore, marker: InstallMarker, ownerSid: string): Promise<{ ok: true; principal: string; release: () => void } | { ok: false; reason: string }> {
    const deadline = Date.now() + (deps.leaseTimeoutMs ?? 30_000);
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
