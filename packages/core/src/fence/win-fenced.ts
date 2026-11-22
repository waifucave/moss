// The fenced process on Windows: the third leg of `fencedSpawner` (`fenced-process.ts`), beside Seatbelt on macOS and
// bubblewrap on Linux (spec §4, §9.1, item 76, §14.1 item 2). A command runs as one of the owner's pool principals
// (`moss-sb-<6hex>-<n>`, provisioned by `moss-core sandbox setup`) through the hash-pinned srt-win launcher, with a
// write-restricted token, WFP filters keyed to the principal and a kill-on-close job: never as the user, and never with
// a fallback to an unsandboxed shell. Every refusal below is a refusal of the whole run.
//
// The rules, each enforced where it says:
//  1. Who: the launcher must be the pinned build (`launcherProblem`), the install marker must name this owner, and the
//     leased principal's profile must resolve by its SID and not be a temporary profile (`profileLaunchCheck`), at every
//     launch (`run`, steps 1–3).
//  2. One principal per command: a pool member is leased exclusively for the command's whole run (an OS file lock,
//     `acquirePoolLease`), so two commands never share a principal, and the lease ends with the command.
//  3. Writes: only the run's write roots, each a persistent root with its own capability SID (`acl grant
//     --persistent`), passed to `exec --write-root`; the write-restricted token lets nothing else be written, whatever
//     BUILTIN\Users or Authenticated Users may write. The roots are the runner's sandbox's `allowWrite` (`planFor`).
//  4. Denies: every fenced path of the run's sandbox that exists is stamped `--deny-write` / `--deny-read` for this
//     command; a glob is expanded over what exists; a deny wins over every allow (an explicit deny ACE comes first).
//     A fenced path that doesn't exist yet can only be made inside a write root; the post-run belt checks the git
//     places there (rule 7).
//  5. Network: the principal's WFP filters (installed by setup, loopback closed) refuse every connection but the
//     loopback proxy range 60080–60089, as `srt-win install` sets them; no `--allow-loopback` is ever passed.
//  6. Environment: built here, whole. The broker gets a fixed system environment; the child gets the principal's own
//     profile as HOME/USERPROFILE/APPDATA (the controller's ruling 2: never the user's), its run's temp folder as
//     TEMP/TMP, a fixed PATH and MOSS's empty git template. Nothing of the daemon's environment reaches it.
//  7. Run later: a git config key a command set in a repo under its write roots is reverted after the run, and a hook
//     it planted in such a repo's `.git/hooks` is moved aside (`revertPlantedGitKeys`, `quarantineHooks`).
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, win32 } from "node:path";
import type { SandboxSettingsConfig } from "@waifucave/clover-agent-sdk";
import type { Caller } from "@waifucave/moss-protocol";
import { fenceContextFor } from "../contracts/fence";
import type { MossFence } from "./fence";
import { gitTemplateDir } from "./layout";
import { quarantinePlanted, reposUnder, revertPlantedGitKeys, snapshotFiles } from "./fenced-process";
import { runCommand, type FencedRun, type FencedRunResult, type FencedSpawner, type RunShell } from "./spawn";
import {
  acquirePoolLease, createWindowsLockStore, execArgs, installMarkerPath, launcherProblem, minimalChildEnv, parseInstallMarker,
  parseProfileImagePath, profileLaunchCheck, profileQueryArgs, sandboxLeasesDir, sessionGrantArgs, sessionGrantInput,
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

const GLOB = /[*?[\]{}]/;

/** The paths a deny list names that exist now: literal paths as they are, a glob expanded over what exists (its `*`
 *  one whole name, `**` any depth, bounded). A path that doesn't exist isn't stamped (srt-win fails an exec on one). */
export function existingDenies(paths: readonly string[], o: { exists?: (p: string) => boolean; list?: (dir: string) => readonly string[]; budget?: number } = {}): string[] {
  const exists = o.exists ?? ((p: string) => { try { lstatSync(p); return true; } catch { return false; } });
  const list = o.list ?? ((d: string) => { try { return readdirSync(d); } catch { return []; } });
  let budget = o.budget ?? 20_000;
  const out: string[] = [];
  const expand = (base: string, segs: readonly string[]): void => {
    if (budget-- <= 0) return;
    if (segs.length === 0) { if (exists(base)) out.push(base); return; }
    const [seg, ...rest] = segs as [string, ...string[]];
    if (seg === "**") {
      expand(base, rest);
      for (const n of list(base)) { const c = win32.join(base, n); try { if (statSync(c).isDirectory() && !lstatSync(c).isSymbolicLink()) expand(c, segs); } catch { /* gone */ } }
      return;
    }
    if (!GLOB.test(seg)) { expand(win32.join(base, seg), rest); return; }
    const re = new RegExp(`^${seg.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
    for (const n of list(base)) if (re.test(n)) expand(win32.join(base, n), rest);
  };
  for (const p of paths) {
    if (!GLOB.test(p)) { if (exists(p)) out.push(p); continue; }
    const norm = win32.normalize(p);
    const parts = norm.split("\\");
    const first = parts.findIndex((s) => GLOB.test(s));
    expand(parts.slice(0, first).join("\\") || "\\", parts.slice(first));
  }
  return uniq(out);
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
  readonly ownerSid: string | null;
  /** `%ProgramData%`, where `sandbox setup` writes the install marker. */
  readonly programData: string | null;
  readonly systemRoot: string;
  readonly shells: { bash: string | null; powershell: string | null };
  readonly leases: () => LeaseStore;
  readonly leasesDir: string;
  /** A short helper process (srt-win's acl and status, reg): exit code and output. */
  exec(argv: readonly string[], o?: { stdin?: string; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
  readFile(path: string): string | null;
  /** How long a command waits for a free principal before it is refused. */
  readonly leaseTimeoutMs?: number;
}

/** The real machine's deps. */
export function windowsDeps(mossHome: string, o: { ownerSid: string | null; programData: string | null }): WinFencedDeps {
  const env = minimalChildEnv();
  const leasesDir = sandboxLeasesDir(mossHome);
  let store: LeaseStore | undefined;
  return {
    launcher: srtWinPath(),
    ownerSid: o.ownerSid,
    programData: o.programData,
    systemRoot: process.env.SystemRoot ?? "C:\\Windows",
    shells: windowsShells(),
    leases: () => (store ??= createWindowsLockStore(leasesDir)),
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

/** The Windows leg of the fenced spawner. */
export function winFencedSpawner(o: { fence: MossFence; deps: WinFencedDeps; bots?: () => readonly string[] }): FencedSpawner {
  const { fence, deps } = o;
  const refuse = (reason: string): FencedRunResult => ({ kind: "refused", reason: `a fenced process can't be started here: ${reason}` });
  /** Rule 1's first half: the pinned launcher and this owner's install. */
  const install = (): { marker: InstallMarker } | { why: string } => {
    const problem = launcherProblem(deps.launcher, srtWinArch());
    if (problem !== null) return { why: setupBashRefusal(problem) };
    if (deps.ownerSid === null) return { why: "the user's SID can't be read" };
    if (deps.programData === null) return { why: "ProgramData can't be resolved" };
    const marker = parseInstallMarker(deps.readFile(installMarkerPath(deps.programData, deps.ownerSid)));
    if (marker === null || marker.ownerSid !== deps.ownerSid || marker.members.length === 0) return { why: setupBashRefusal(null) };
    if (marker.members.some((m) => m.principalSid === null)) return { why: setupBashRefusal("a principal's SID isn't recorded") };
    return { marker };
  };
  return {
    get available() { return !("why" in install()); },
    run: async (r: FencedRun): Promise<FencedRunResult> => {
      if (r.signal?.aborted) return { kind: "refused", reason: "cancelled before it started" };
      const got = install();
      if ("why" in got) return refuse(got.why);
      const shell: WinShell = r.shell ?? "bash";
      const exe = shell === "powershell" ? deps.shells.powershell : deps.shells.bash;
      if (exe === null) return refuse(shell === "powershell" ? "Windows PowerShell isn't in System32" : "Git for Windows' bash isn't installed (Program Files\\Git, or this user's Programs\\Git)");
      // Rule 2: a principal for this command alone.
      let leases: LeaseStore;
      try { leases = deps.leases(); } catch (e) { return refuse(e instanceof Error ? e.message : String(e)); }
      const lease = await acquirePoolLease({ store: leases, leasesDir: deps.leasesDir, pool: got.marker.members, timeoutMs: deps.leaseTimeoutMs ?? 30_000 });
      if (!lease.ok) return refuse(lease.reason);
      try {
        const member = got.marker.members.find((m) => m.principal === lease.principal)!;
        const sid = member.principalSid!;
        // Rule 1's second half: the profile, by SID, at every launch.
        const reg = await deps.exec(profileQueryArgs(sid), { timeoutMs: 15_000 });
        const profileRoot = reg.code === 0 ? parseProfileImagePath(reg.stdout) : null;
        const check = profileLaunchCheck(profileRoot === null ? null : { sid, path: profileRoot });
        if (!check.ok) return refuse(`${check.reason}; run \`moss-core sandbox setup\` again`);
        const plan = r.sandbox !== undefined ? planFromSettings(r.sandbox) : planFromPolicy(fence, r.who.caller, r.cwd, { ...(o.bots ? { bots: o.bots() } : {}) });
        // The caller's own folders exist before they are granted: a root must be on the disk to carry its ACE.
        for (const root of plan.writeRoots) {
          if (winUnder(root, fence.mossHome)) { try { mkdirSync(root, { recursive: true }); } catch { /* the grant below reports it */ } }
        }
        const roots = plan.writeRoots.filter((p) => existsSync(p));
        const grantPlan = { ...plan, writeRoots: roots };
        const temp = r.env.TMPDIR !== undefined && roots.some((x) => winUnder(r.env.TMPDIR!, x)) ? r.env.TMPDIR : fence.temp;
        const template = gitTemplateDir(fence.mossHome);
        try { mkdirSync(template, { recursive: true }); } catch { /* git then finds no template, and copies nothing */ }
        // Rule 3: the session's write roots, held by the daemon (`--holder-pid`), each with its capability SID.
        const grant = await deps.exec(sessionGrantArgs({ launcher: deps.launcher, sid, holderPid: process.pid }), {
          stdin: sessionGrantInput({ read: grantPlan.readGrants, write: roots }), timeoutMs: 600_000,
        });
        if (grant.code !== 0) return refuse(`srt-win acl grant exited ${grant.code}: ${(grant.stderr || grant.stdout).trim().slice(0, 400)}`);
        try {
          // Rule 4: what exists of the fenced set, stamped for this command.
          const denyRead = existingDenies(plan.denyRead);
          const denyWrite = existingDenies(plan.denyWrite);
          const gitRoot = deps.shells.bash === null ? null : win32.dirname(win32.dirname(deps.shells.bash));
          const env = winChildEnv({ profileRoot: profileRoot!, temp, systemRoot: deps.systemRoot, gitRoot, gitTemplate: template });
          const built = winExecArgv({ launcher: deps.launcher, user: lease.principal, plan: grantPlan, denyRead, denyWrite, env, shell: shellArgv(shell, exe, r.command), heldBy: process.pid });
          if ("refused" in built) return refuse(built.refused);
          // Rule 7's snapshot: the git places under the roots as they are now.
          const places = gitPlaces(roots);
          const configBefore = snapshotFiles(places.configs);
          const hooksBefore = hookFiles(places.hooks);
          const runShell: RunShell = shell === "powershell" ? "none" : "git-bash";
          const result = await runCommand({ ...r, env: minimalChildEnv() }, { shell: runShell, argv: built.argv });
          if (result.kind === "refused") return result;
          const after = gitPlaces(roots);
          for (const p of after.configs) if (!configBefore.has(p)) configBefore.set(p, null);
          const notes = [revertPlantedGitKeys(configBefore), quarantineHooks(hooksBefore, after.hooks, fence.mossHome)].filter((n): n is string => n !== null);
          return notes.length === 0 ? result : { ...result, stderr: result.stderr + notes.join("") };
        } finally {
          // The command's per-session claims end with it; the persistent roots stay (only a token carrying a root's
          // capability SID writes there, and only a command whose sandbox names the root gets it).
          await deps.exec(sessionRevokeArgs({ launcher: deps.launcher, sid, holderPid: process.pid }), { timeoutMs: 120_000 });
        }
      } finally {
        lease.release();
      }
    },
  };
}
