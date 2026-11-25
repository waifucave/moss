// The Windows leg of the fenced spawner, its pure half and its refusals, on every OS (lane WS). The real launches run
// in win-fenced.e2e.test.ts on windows-latest.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import type { Caller, Level } from "@waifucave/moss-protocol";
import { MossFence } from "../../src/fence/fence";
import { endWindowsBackgroundOf, endWindowsBackgroundOn, escapedSandbox, stopWindowsBackground, windowsBackgroundOf, windowsShellTools, WIN_SHELL_BACKGROUND_ENGINE, WIN_SHELL_BACKGROUND_PER_SESSION } from "../../src/fence/win-shell-tools";
import {
  existingDenies, existingDeniesOf, grantsConflict, parsePersistentRoots, parseProfileExclusions, strayRoots, treeWithin, planFromPolicy, planFromSettings, profileExcludeCandidates, quarantineWin, shellArgv, winChainIsClean, winChildEnv, winExecArgv, lateFenceStep, watchedReadDenies, winFencedSpawner, windowsRoots, windowsShells, WIN_ARGV_LIMIT,
  type WinFencedDeps,
} from "../../src/fence/win-fenced";
import { formatInstallMarker, poolStateFiles, type LeaseStore } from "../../src/fence/win-sandbox";
import type { FencedRun, FencedSpawner } from "../../src/fence/spawn";

const BOT: Extract<Caller, { kind: "session" }> = { kind: "session", sessionId: "s1", sessionKind: "bot", bot: "luna" } as Extract<Caller, { kind: "session" }>;

describe("the shells", () => {
  test("Git Bash and PowerShell come from their standard places only, never from PATH", () => {
    const present = new Set(["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"]);
    const s = windowsShells({ ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows", PATH: "C:\\evil" }, (p) => present.has(p));
    expect(s).toEqual({ bash: "C:\\Program Files\\Git\\bin\\bash.exe", powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" });
    expect(windowsShells({ PATH: "C:\\Program Files\\Git\\bin" }, () => true)).toEqual({ bash: null, powershell: null });
    const user = windowsShells({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, (p) => p.endsWith("Programs\\Git\\bin\\bash.exe"));
    expect(user.bash).toBe("C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe");
  });

  test("PowerShell starts without profiles and never interactively; bash takes the command whole", () => {
    expect(shellArgv("powershell", "ps.exe", "Get-Date; whoami")).toEqual(["ps.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "Get-Date; whoami"]);
    expect(shellArgv("bash", "bash.exe", "echo a && echo b")).toEqual(["bash.exe", "-c", "echo a && echo b"]);
  });
});

describe("the plan", () => {
  test("the runtime's settings: allowWrite are the write roots, the denies are stamped, the roots spared from the read deny", () => {
    const plan = planFromSettings({ filesystem: { allowWrite: ["C:\\h\\.moss\\scratch\\luna", "C:\\h\\.moss\\scratch\\LUNA\\"], denyWrite: ["C:\\h\\.moss"], denyRead: ["C:\\h\\.moss\\run"] } });
    expect(plan.writeRoots).toEqual(["C:\\h\\.moss\\scratch\\luna"]);
    expect(plan.denyWrite).toEqual(["C:\\h\\.moss"]);
    expect(plan.denyRead).toEqual(["C:\\h\\.moss\\run"]);
    expect(plan.denyReadExcept).toEqual(plan.writeRoots);
  });

  test("roots srt-win can hold: the temp folder becomes the session's own folder in it, the home its ordinary folders", () => {
    const o = { home: "C:\\Users\\me", temp: "C:\\Users\\me\\AppData\\Local\\Temp", sessionTemp: "C:\\Users\\me\\AppData\\Local\\Temp\\moss-s1", homeFolders: () => ["C:\\Users\\me\\Documents", "C:\\Users\\me\\src"] };
    expect(windowsRoots(["C:\\Users\\me\\.moss\\scratch\\luna", "C:\\Users\\me\\AppData\\Local\\TEMP"], o)).toEqual(["C:\\Users\\me\\.moss\\scratch\\luna", o.sessionTemp]);
    expect(windowsRoots(["C:\\Users\\me"], o)).toEqual(["C:\\Users\\me\\Documents", "C:\\Users\\me\\src", o.sessionTemp]);
    // Above the temp folder but not the home (AppData, AppData\Local): never a root.
    expect(windowsRoots(["C:\\Users\\me\\AppData", "C:\\Users\\me\\AppData\\Local"], o)).toEqual([]);
    expect(windowsRoots(["C:\\Users\\me\\AppData\\Local\\Temp\\mine"], o)).toEqual(["C:\\Users\\me\\AppData\\Local\\Temp\\mine"]);
  });

  test("another computer's call (lane XC): its one write root is its own folder, never the shared temp folder or its working folder", () => {
    const temp = "C:\\Users\\me\\AppData\\Local\\Temp\\moss";
    const peerRoot = `${temp}\\peer-abc`;
    const fence = {
      mossHome: "C:\\Users\\me\\.moss", temp,
      policy: () => ({ allowWrite: [peerRoot], denyWrite: ["C:\\Users\\me\\.moss"], denyRead: ["C:\\Users\\me\\.moss\\run"] }),
      contextFor: undefined,
    } as unknown as Parameters<typeof planFromPolicy>[0];
    const peer = planFromPolicy(fence, { kind: "peer", device: "d_alpha" } as Caller, "C:\\Users\\me\\project");
    expect(peer.writeRoots).toEqual([peerRoot]);
    expect(peer.writeRoots.some((r) => r.toLowerCase() === temp.toLowerCase())).toBe(false);
    // Mapped for srt-win, the peer's folder stays itself (a folder in the temp folder, not the session's shared one).
    expect(windowsRoots(peer.writeRoots, { home: "C:\\Users\\me", temp, sessionTemp: `${temp}\\moss-shared`, homeFolders: () => [] })).toEqual([peerRoot]);
    // Another caller still gets the fence's temp folder, as before.
    const bot = planFromPolicy(fence, { kind: "session", sessionId: "s", sessionKind: "coding" }, "C:\\Users\\me\\project");
    expect(bot.writeRoots).toContain(temp);
  });

  test("a deny is stamped only where something exists; a glob is expanded over what exists, case-insensitively", () => {
    const disk = new Set(["C:\\h\\.moss\\run", "C:\\h\\.moss\\projects\\a\\x.provider-state.jsonl", "C:\\h\\.moss\\projects\\a\\b\\Y.PROVIDER-STATE.JSONL"]);
    const dirs: Record<string, string[]> = { "C:\\h\\.moss\\projects": ["a"], "C:\\h\\.moss\\projects\\a": ["x.provider-state.jsonl", "b", "z.txt"], "C:\\h\\.moss\\projects\\a\\b": ["Y.PROVIDER-STATE.JSONL"] };
    const got = existingDenies(["C:\\h\\.moss\\run", "C:\\h\\.moss\\secrets.enc", "C:\\h\\.moss\\projects\\**\\*.provider-state.jsonl"], {
      exists: (p) => disk.has(p), list: (d) => dirs[d] ?? [], isDir: (p) => dirs[p] !== undefined,
    });
    expect(got).toEqual(["C:\\h\\.moss\\run", "C:\\h\\.moss\\projects\\a\\x.provider-state.jsonl", "C:\\h\\.moss\\projects\\a\\b\\Y.PROVIDER-STATE.JSONL"]);
  });

  // A synthetic home: `roots` write roots, each `width` folders wide and `depth` deep, a `.vscode` and an `.envrc` in
  // some of them. Listed from a map (no disk), so a test sees the walk's own bounds.
  function bigTree(o: { roots: number; width: number; depth: number }) {
    const dirs = new Map<string, string[]>();
    const files = new Set<string>();
    const make = (dir: string, d: number) => {
      const names: string[] = [];
      if (d < o.depth) for (let i = 0; i < o.width; i++) { const n = `d${i}`; names.push(n); make(`${dir}\\${n}`, d + 1); }
      if (d === o.depth) { names.push(".vscode", ".envrc"); dirs.set(`${dir}\\.vscode`, ["tasks.json"]); files.add(`${dir}\\.envrc`); files.add(`${dir}\\.vscode\\tasks.json`); }
      dirs.set(dir, names);
    };
    const roots = Array.from({ length: o.roots }, (_, i) => `C:\\h\\r${i}`);
    for (const r of roots) make(r, 0);
    const exists = (p: string) => dirs.has(p) || files.has(p);
    return { roots, dirs, exists, list: (d: string) => dirs.get(d) ?? [], isDir: (p: string) => dirs.has(p) };
  }
  const PATTERNS = (roots: readonly string[]) => roots.flatMap((r) => [`${r}\\**\\.[vV][sS][cC][oO][dD][eE]`, `${r}\\**\\.[eE][nN][vV][rR][cC]`, `${r}\\**\\*.[gG][iI][tT]\\hooks`]);

  test("every ** pattern of a root shares one walk with a budget of its own: a big root never starves another", () => {
    // Two roots of ~41 000 entries each (10^4 deep folders, each with a `.vscode` and an `.envrc`). A 45 000-entry
    // budget holds one root, not both: shared by every glob (before), the second root's patterns were never walked
    // and that root was denied whole, so nothing could be written there.
    const t = bigTree({ roots: 2, width: 10, depth: 4 });
    const got = existingDeniesOf(PATTERNS(t.roots), { exists: t.exists, list: t.list, isDir: t.isDir, budget: 45_000 });
    expect(got.exhausted).toBe(false);
    expect(got.paths.filter((p) => p.startsWith("C:\\h\\r1\\")).length).toBe(2 * 10 ** 4);
    expect(got.paths).not.toContain("C:\\h\\r1");
    expect(got.paths).not.toContain("C:\\h\\r0");
  });

  test("past a root's budget, only the folders the walk didn't read are denied whole; the root stays writable", () => {
    const t = bigTree({ roots: 1, width: 12, depth: 4 }); // 22 620 folders, more than the budget below
    const got = existingDeniesOf(PATTERNS(t.roots), { exists: t.exists, list: t.list, isDir: t.isDir, budget: 2_000 });
    expect(got.exhausted).toBe(true);
    expect(got.paths).not.toContain("C:\\h\\r0");
    expect(got.unwalked.length).toBeGreaterThan(0);
    expect(got.unwalked.length).toBeLessThanOrEqual(256);
    // Every deep match is covered: stamped itself, or under a folder denied whole.
    const deep = [...t.dirs.keys()].filter((d) => d.endsWith("\\.vscode"));
    for (const d of deep) expect(got.paths.some((p) => d === p || d.startsWith(`${p}\\`))).toBe(true);
  });

  test("the real budget walks a home of 200 000 entries in one pass per root, every match found", () => {
    const t = bigTree({ roots: 3, width: 8, depth: 4 }); // 3 × (4 681 folders + 2 × 4 096 matches)
    const started = performance.now();
    const got = existingDeniesOf(PATTERNS(t.roots), { exists: t.exists, list: t.list, isDir: t.isDir });
    const ms = performance.now() - started;
    expect(got.exhausted).toBe(false);
    expect(got.paths.length).toBe(3 * 2 * 8 ** 4);
    console.log(`[walk] ${t.dirs.size} folders, ${got.paths.length} matches, ${ms.toFixed(0)} ms (in memory)`);
  });

  test("the broker's argv: the principal, the write-restricted token, the roots and denies, then `--` and the shell; too long is refused", () => {
    const plan = { writeRoots: ["C:\\r"], readGrants: [], denyRead: [], denyWrite: [], denyReadExcept: ["C:\\r"] };
    const built = winExecArgv({ launcher: "srt-win.exe", user: "moss-sb-abcdef-1", plan, denyRead: ["C:\\d"], denyWrite: ["C:\\w"], env: { HOME: "C:\\p" }, shell: ["bash.exe", "-c", "echo hi"], heldBy: 42 });
    expect("argv" in built).toBe(true);
    const argv = (built as { argv: string[] }).argv;
    expect(argv.slice(0, 6)).toEqual(["srt-win.exe", "exec", "--quiet", "--user", "moss-sb-abcdef-1", "--write-restricted-token"]);
    const dash = argv.indexOf("--");
    expect(argv.slice(dash)).toEqual(["--", "bash.exe", "-c", "echo hi"]);
    for (const flag of [["--deny-read", "C:\\d"], ["--deny-write", "C:\\w"], ["--write-root", "C:\\r"], ["--held-by", "42"], ["--env", "HOME=C:\\p"], ["--deny-read-except", "C:\\r"]]) {
      const at = argv.indexOf(flag[0]!);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(dash);
      expect(argv[at + 1]).toBe(flag[1]!);
    }
    expect(argv).not.toContain("--allow-loopback");
    const long = winExecArgv({ launcher: "s", user: "u", plan, denyRead: Array.from({ length: 700 }, (_, i) => `C:\\a\\very\\long\\path\\to\\a\\fenced\\item\\number\\${i}`), denyWrite: [], env: {}, shell: ["b", "-c", "x"], heldBy: 1 });
    expect("refused" in long).toBe(true);
    expect((long as { refused: string }).refused).toContain(`${WIN_ARGV_LIMIT}`);
  });

  test("the child's environment is built whole: the principal's profile as its home, the run's temp, a fixed PATH", () => {
    const env = winChildEnv({ profileRoot: "C:\\Users\\moss-sb-a", temp: "C:\\h\\.moss\\scratch\\luna", systemRoot: "C:\\Windows", gitRoot: "C:\\Program Files\\Git", gitTemplate: "C:\\h\\.moss\\git-template" });
    expect(env.HOME).toBe("C:\\Users\\moss-sb-a");
    expect(env.USERPROFILE).toBe("C:\\Users\\moss-sb-a");
    expect(env.TEMP).toBe("C:\\h\\.moss\\scratch\\luna");
    expect(env.PATH!.split(";")[0]).toBe("C:\\Program Files\\Git\\cmd");
    expect(Object.keys(env).some((k) => /token|key|secret|proxy/i.test(k))).toBe(false);
  });
});

const GEN1 = "1".repeat(32), GEN2 = "2".repeat(32);

/** Fake machine: a launcher that is (or isn't) pinned, a marker, the pool's state files (each principal's generation
 *  and used record; by default both remade since their last command) and an in-memory lease store. */
function machine(o: { pinned?: boolean; marker?: string | null; files?: Record<string, string>; roots?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "moss-winfenced-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".moss"), { recursive: true });
  const held = new Set<string>();
  const leases: LeaseStore = { tryLock: (p) => (held.has(p) ? null : (held.add(p), { release: () => { held.delete(p); } })) };
  const execs: (readonly string[])[] = [];
  const writes: string[] = [];
  const files: Record<string, string> = o.files ?? { "moss-sb-aaaaaa-1.gen": GEN1, "moss-sb-aaaaaa-1.used": "", "moss-sb-aaaaaa-2.gen": GEN2, "moss-sb-aaaaaa-2.used": "" };
  const marker = o.marker === undefined ? formatInstallMarker({ version: 2, ownerSid: "S-1-5-21-1", members: [
    { principal: "moss-sb-aaaaaa-1", principalSid: "S-1-5-21-1001", sublayer: "x" }, { principal: "moss-sb-aaaaaa-2", principalSid: "S-1-5-21-1002", sublayer: "y" },
  ] }) : o.marker;
  const deps: WinFencedDeps = {
    launcher: "C:\\srt-win.exe",
    launcherProblem: () => (o.pinned === false ? "the launcher isn't installed" : null),
    ownerSid: "S-1-5-21-1",
    programData: "C:\\ProgramData",
    systemRoot: "C:\\Windows",
    shells: { bash: "C:\\Program Files\\Git\\bin\\bash.exe", powershell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" },
    leases: () => leases,
    leasesDir: "C:\\ProgramData\\MOSS Sandbox\\pool\\S-1-5-21-1",
    async exec(argv) {
      execs.push(argv);
      if (argv[0] === "reg" && argv[2] === "HKLM\\SOFTWARE\\sandbox-runtime") return { code: 0, stdout: "    SandboxUserSid    REG_SZ    S-1-5-21-1002\r\n", stderr: "" };
      if (argv[1] === "user" && argv[2] === "status") return { code: 0, stdout: JSON.stringify({ persistent_grants: { state: "none", roots: o.roots ?? [], pending: [] } }), stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    readFile: (p) => (p.endsWith("S-1-5-21-1.json") ? marker : files[win32.basename(p)] ?? null),
    writeFile: (p, text) => { const k = win32.basename(p); if (!(k in files)) return false; files[k] = text; writes.push(`${k}=${text}`); return true; },
    leaseTimeoutMs: 0,
  };
  const fence = new MossFence({ home, mossHome: join(home, ".moss"), os: "windows" });
  return { deps, fence, execs, home, files, writes };
}

const runOf = (cwd: string): FencedRun => ({ command: "echo hi", cwd, env: {}, timeoutMs: 1000, who: { caller: BOT } });

describe("the Windows leg refuses, whole, before anything runs", () => {
  test("a launcher that isn't the pinned build: refused with the way to set Bash up, and nothing is spawned", async () => {
    const m = machine({ pinned: false });
    const s = winFencedSpawner({ fence: m.fence, deps: m.deps });
    expect(s.available).toBe(false);
    const r = await s.run(runOf(m.home));
    expect(r).toMatchObject({ kind: "refused" });
    expect((r as { reason: string }).reason).toContain("moss-core sandbox setup");
    expect(m.execs).toHaveLength(0);
  });

  test("no install marker for this user (setup never ran, or another user's): refused", async () => {
    for (const marker of [null, formatInstallMarker({ version: 2, ownerSid: "S-1-5-21-OTHER", members: [{ principal: "moss-sb-bbbbbb-1", principalSid: "S-1-5-21-9", sublayer: "z" }] })]) {
      const m = machine({ marker });
      const r = await winFencedSpawner({ fence: m.fence, deps: m.deps }).run(runOf(m.home));
      expect(r).toMatchObject({ kind: "refused" });
      expect(m.execs).toHaveLength(0);
    }
  });

  test("a principal whose profile wasn't remade since its last command is never used: the reset task is asked, then refused", async () => {
    const m = machine({ files: { "moss-sb-aaaaaa-1.gen": GEN1, "moss-sb-aaaaaa-1.used": GEN1, "moss-sb-aaaaaa-2.gen": GEN2, "moss-sb-aaaaaa-2.used": GEN2 } });
    const r = await winFencedSpawner({ fence: m.fence, deps: m.deps }).run(runOf(m.home));
    expect(r).toMatchObject({ kind: "refused" });
    expect((r as { reason: string }).reason).toContain("reset since its last command");
    expect(m.execs.some((a) => a[0] === "schtasks" && a.includes("/run") && a.includes("MOSS Sandbox Reset S-1-5-21-1"))).toBe(true);
    expect(m.execs.some((a) => a.includes("acl") || a.includes("exec"))).toBe(false);
    expect(m.writes).toEqual([]);
  });

  test("no generation, or one that isn't the reset's (an empty or odd .gen), is never fresh", async () => {
    for (const gen of ["", "not-a-generation", "  "]) {
      const m = machine({ files: { "moss-sb-aaaaaa-1.gen": gen, "moss-sb-aaaaaa-1.used": "", "moss-sb-aaaaaa-2.gen": gen, "moss-sb-aaaaaa-2.used": "" } });
      expect(await winFencedSpawner({ fence: m.fence, deps: m.deps }).run(runOf(m.home))).toMatchObject({ kind: "refused" });
    }
  });

  test("a remade principal is taken, its generation marked used before anything is granted; it isn't taken again until remade", async () => {
    const m = machine({ files: { "moss-sb-aaaaaa-1.gen": GEN1, "moss-sb-aaaaaa-1.used": GEN1, "moss-sb-aaaaaa-2.gen": GEN2, "moss-sb-aaaaaa-2.used": "" } });
    const s = winFencedSpawner({ fence: m.fence, deps: { ...m.deps, exec: async (argv, x) => {
      if (argv.includes("exec")) return { code: 0, stdout: "", stderr: "" };
      return m.deps.exec(argv, x);
    } } });
    await s.run(runOf(m.home)).catch(() => undefined);
    expect(m.writes[0]).toBe(`moss-sb-aaaaaa-2.used=${GEN2}`);
    const grantAt = m.execs.findIndex((a) => a.includes("grant") && a.includes("--persistent"));
    expect(grantAt).toBeGreaterThanOrEqual(0);
    // The next command finds both used: refused until the reset remakes one.
    const again = await s.run(runOf(m.home));
    expect(again).toMatchObject({ kind: "refused" });
  });

  test("a used record that can't be written refuses the principal (it would be taken again unremade)", async () => {
    const m = machine({ files: { "moss-sb-aaaaaa-1.gen": GEN1, "moss-sb-aaaaaa-2.gen": GEN2 } }); // no .used files to write
    expect(await winFencedSpawner({ fence: m.fence, deps: m.deps }).run(runOf(m.home))).toMatchObject({ kind: "refused" });
    expect(m.execs.some((a) => a.includes("acl"))).toBe(false);
  });

  test("every principal busy: refused rather than shared", async () => {
    const m = machine({ marker: formatInstallMarker({ version: 2, ownerSid: "S-1-5-21-1", members: [{ principal: "moss-sb-aaaaaa-1", principalSid: "S-1-5-21-1001", sublayer: "x" }] }) });
    const held = m.deps.leases().tryLock(poolStateFiles(m.deps.leasesDir, "moss-sb-aaaaaa-1").lock);
    expect(held).not.toBeNull();
    const r = await winFencedSpawner({ fence: m.fence, deps: m.deps }).run(runOf(m.home));
    expect(r).toMatchObject({ kind: "refused" });
    expect((r as { reason: string }).reason).toContain("busy");
  });

  test("the escape account: only an approved escape runs as it, and only it runs an approved escape", async () => {
    const withEscape = formatInstallMarker({ version: 2, ownerSid: "S-1-5-21-1", members: [
      { principal: "moss-sb-aaaaaa-1", principalSid: "S-1-5-21-1001", sublayer: "x" }, { principal: "moss-sb-aaaaaa-e", principalSid: "S-1-5-21-1009", sublayer: "e", network: true },
    ] });
    const files = () => ({ "moss-sb-aaaaaa-1.gen": GEN1, "moss-sb-aaaaaa-1.used": "", "moss-sb-aaaaaa-e.gen": GEN2, "moss-sb-aaaaaa-e.used": "" });
    // Which account was leased: the one whose used record was written (the launch itself can't start off Windows).
    const leased = async (network: boolean) => {
      const m = machine({ marker: withEscape, files: files() });
      await winFencedSpawner({ fence: m.fence, deps: m.deps, grantAhead: false }).run({ ...runOf(m.home), ...(network ? { network: true } : {}) });
      return m.writes.map((w) => w.split(".used=")[0]);
    };
    expect(await leased(false)).toEqual(["moss-sb-aaaaaa-1"]);
    expect(await leased(true)).toEqual(["moss-sb-aaaaaa-e"]);
    // An install made before the escape account existed: the escape is refused, never run as a pool account.
    const old = machine();
    const r = await winFencedSpawner({ fence: old.fence, deps: old.deps, grantAhead: false }).run({ ...runOf(old.home), network: true });
    expect(r).toMatchObject({ kind: "refused" });
    expect((r as { reason: string }).reason).toContain("escape account");
  });

  test("the profile read grant adds this home's exclusions to the ones in force, never replacing another home's", async () => {
    const m = machine();
    await winFencedSpawner({ fence: m.fence, deps: m.deps, grantAhead: false }).run(runOf(m.home));
    const grants = m.execs.filter((a) => a[1] === "profile" && a[2] === "grant");
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) expect(g).not.toContain("--replace-excludes");
  });

  test("a shell that isn't installed: refused, never another shell", async () => {
    const m = machine();
    const s = winFencedSpawner({ fence: m.fence, deps: { ...m.deps, shells: { bash: null, powershell: null } } });
    expect(await s.run(runOf(m.home))).toMatchObject({ kind: "refused" });
    expect(await s.run({ ...runOf(m.home), shell: "powershell" })).toMatchObject({ kind: "refused" });
  });
});

describe("a bot's Bash and PowerShell on Windows (the core's tools)", () => {
  const spy = () => {
    const runs: FencedRun[] = [];
    const spawner: FencedSpawner = { available: true, run: async (r) => { runs.push(r); return { kind: "exited", code: 0, stdout: "ok\n", stderr: "", shell: "git-bash" }; } };
    return { runs, spawner };
  };
  const SANDBOX = { filesystem: { allowWrite: ["C:\\h\\.moss\\scratch\\luna"], denyWrite: ["C:\\h\\.moss\\settings.json"], denyRead: ["C:\\h\\.moss\\run"] } };
  const tools = (kind: "bot" | "side-thread", spawner: FencedSpawner) => Object.fromEntries(windowsShellTools({
    spawner, caller: BOT, kind, cwd: () => "C:\\h\\.moss\\scratch\\luna", sandbox: () => SANDBOX, userHome: "C:\\h", temp: "C:\\h\\AppData\\Local\\Temp", mossHome: "C:\\h\\.moss",
  }).map((t) => [t.name, t]));

  test("each description names every parameter, and says what this session may do (lane WS8: from agent SDK 0.0.85 it is all the model reads)", () => {
    const { spawner } = spy();
    const wake = async () => {};
    for (const [kind, withWake] of [["bot", true], ["bot", false], ["side-thread", false]] as const) {
      const ts = windowsShellTools({ spawner, caller: BOT, kind, cwd: () => "C:\\x", sandbox: () => SANDBOX, userHome: "C:\\h", temp: "C:\\t", mossHome: "C:\\h\\.moss", ...(withWake ? { wake } : {}) });
      for (const t of ts) {
        const props = Object.keys((t.inputSchema as { properties: Record<string, unknown> }).properties);
        expect(props.sort()).toEqual(["command", "dangerouslyDisableSandbox", "description", "run_in_background", "timeout"]);
        for (const p of props) expect([t.name, kind, p, t.description.includes(`\`${p}\``)]).toEqual([t.name, kind, p, true]);
        expect(t.description).toContain("Read");
        expect(t.description).toContain("Grep");
        expect(t.description).toContain(kind === "bot" ? "asks the user, on a card" : "never leave the sandbox");
        expect(t.description).toContain(withWake ? "TaskStop" : "not available in this session");
        expect(t.description).toContain(t.name === "Bash" ? "cmd's built-ins" : "-LiteralPath");
      }
    }
  });
  test("each runs its shell under the session's sandbox, in the session's folder, its time limit capped", async () => {
    const { runs, spawner } = spy();
    const t = tools("bot", spawner);
    expect((await t.Bash!.run({ command: "ls", timeout: 9_999_999 })).text).toBe("ok");
    expect((await t.PowerShell!.run({ command: "Get-ChildItem" })).isError).toBe(false);
    expect(runs.map((r) => [r.shell, r.cwd, r.timeoutMs])).toEqual([["bash", "C:\\h\\.moss\\scratch\\luna", 600_000], ["powershell", "C:\\h\\.moss\\scratch\\luna", 120_000]]);
    expect(runs[0]!.sandbox).toEqual(SANDBOX);
  });

  test("a background command is refused with the reason; a side thread's command never leaves the sandbox", async () => {
    const { runs, spawner } = spy();
    expect((await tools("bot", spawner).Bash!.run({ command: "sleep 9", run_in_background: true })).isError).toBe(true);
    const side = await tools("side-thread", spawner).Bash!.run({ command: "echo hi", dangerouslyDisableSandbox: true });
    expect(side.isError).toBe(true);
    expect(runs).toHaveLength(0);
  });

  test("a bot's own conversation's approved escape: the home and temp written, every deny kept, the MOSS home denied", async () => {
    const { runs, spawner } = spy();
    await tools("bot", spawner).Bash!.run({ command: "echo hi > ~/x", dangerouslyDisableSandbox: true });
    const s = runs[0]!.sandbox!.filesystem!;
    expect(s.allowWrite).toEqual(["C:\\h\\.moss\\scratch\\luna", "C:\\h", "C:\\h\\AppData\\Local\\Temp"]);
    expect(s.denyWrite).toEqual(["C:\\h\\.moss\\settings.json", "C:\\h\\.moss"]);
    expect(s.denyRead).toEqual(["C:\\h\\.moss\\run"]);
    expect(escapedSandbox(SANDBOX, { userHome: "C:\\h", temp: "C:\\t", mossHome: "C:\\h\\.moss" }).filesystem!.denyRead).toEqual(["C:\\h\\.moss\\run"]);
    // The approved escape asks for the escape account (the network); a command in the sandbox never does.
    expect(runs[0]!.network).toBe(true);
    await tools("bot", spawner).Bash!.run({ command: "echo hi" });
    expect(runs[1]!.network).toBeUndefined();
  });

  test("a refusal and a failed command reach the model as errors", async () => {
    const refused: FencedSpawner = { available: false, run: async () => ({ kind: "refused", reason: "Bash isn't set up" }) };
    const r = await tools("bot", refused).Bash!.run({ command: "ls" });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toContain("Bash isn't set up");
    const failing: FencedSpawner = { available: true, run: async () => ({ kind: "exited", code: 2, stdout: "", stderr: "Access is denied.\n", shell: "git-bash" }) };
    const f = await tools("bot", failing).Bash!.run({ command: "ls" });
    expect(f).toEqual({ text: "Access is denied.\nExit code 2", isError: true });
  });
});


describe("the profile read grant's exclusions (rule 8's floor)", () => {
  test("are a subset of a bot's shell read denies: excluding them takes no read a bot has, from any caller", async () => {
    const { botSandboxSettings } = await import("../../src/fence/sandbox-settings");
    const { botSandbox, withBotKeyReads, withSecretReads } = await import("../../src/runtime-sdk/turn-loop/driver");
    const home = "C:\\Users\\u", moss = "C:\\Users\\u\\.moss";
    const fence = new MossFence({ os: "windows", home, mossHome: moss, temp: "C:\\Users\\u\\AppData\\Local\\Temp" });
    const caller = { kind: "session", sessionId: "x", sessionKind: "bot", bot: "alpha" } as Caller;
    // The fence's own home and MOSS home (as it resolved them: off Windows a drive path resolves under the cwd).
    const h = fence.home, m = fence.mossHome;
    const shell = botSandbox(withBotKeyReads(withSecretReads(botSandboxSettings(fence.forCaller(caller).policy(), {
      mossHome: m, userHome: h, level: undefined, windows: true, ownFolders: [], pathFolders: [], list: () => [],
    }), { userHome: h, os: "windows" }), { home: m }), { userHome: h, os: "windows" }).filesystem!.denyRead!;
    const fold = (p: string) => win32.normalize(p).toLowerCase();
    const candidates = profileExcludeCandidates(fence);
    expect(candidates.length).toBeGreaterThan(10);
    const missing = candidates.filter((c) => !shell.some((d) => fold(d) === fold(c) || fold(c).startsWith(`${fold(d)}\\`)));
    expect(missing).toEqual([]);
    // Never the MOSS home, a folder above it, or a session's own folders.
    for (const c of candidates) {
      expect(fold(m) === fold(c) || fold(m).startsWith(`${fold(c)}\\`)).toBe(false);
      for (const d of ["bots", "scratch", "outputs"]) expect(fold(c).startsWith(fold(win32.join(m, d)))).toBe(false);
    }
  });
});

describe("the grant in force, read back (the reviewer's WS2 finding 1)", () => {
  test("the literal exclusions of `profile status`; none while a grant is half-written or unreadable", () => {
    const st = JSON.stringify({ state: "granted", exclusions: ["\\\\?\\C:\\Users\\u\\.ssh", "C:\\Users\\u\\.moss\\run", "C:\\Users\\u\\*.pem"] });
    expect(parseProfileExclusions(st)).toEqual(["C:\\Users\\u\\.ssh", "C:\\Users\\u\\.moss\\run"]);
    expect(parseProfileExclusions(JSON.stringify({ state: "in_progress", exclusions: ["C:\\x"] }))).toEqual([]);
    expect(parseProfileExclusions("not json")).toEqual([]);
    expect(parseProfileExclusions(JSON.stringify({ state: "absent" }))).toEqual([]);
  });
});

describe("read grants of two commands at once (rule 3b, the reviewer's WS2 finding 6)", () => {
  const moss = "C:\\h\\.moss";
  const node = (id: string, others: string[]) => ({ caller: `session:${id}`, opens: [`${moss}\\outputs\\${id}`], denyRead: [moss, ...others.map((o) => `${moss}\\outputs\\${o}`)] });
  test("a session's folder made after the other started (not denied by name) is a conflict; one denied by name is not", () => {
    expect(grantsConflict(node("a", []), node("b", []))).toBe(true);
    expect(grantsConflict(node("a", ["b"]), node("b", ["a"]))).toBe(false);
    expect(grantsConflict(node("a", ["b"]), node("b", []))).toBe(true);
  });
  test("a bot's grant on the MOSS home beside a coding session's deny of the same folder is not; the same caller never is", () => {
    const bot = { caller: "session:bot", opens: [moss], denyRead: [`${moss}\\run`] };
    expect(grantsConflict(bot, { caller: "session:c", opens: [], denyRead: [moss] })).toBe(false);
    expect(grantsConflict(node("a", []), { ...node("a", []) })).toBe(false);
  });
  test("a bot's grant on its memory beside a coding session's plan (which denies that memory folder by name) is not", async () => {
    const { winLaunchPlan } = await import("../../src/fence/win-sandbox");
    const { MossFence } = await import("../../src/fence/fence");
    const fence = new MossFence({ os: "windows", home: "C:\\h", mossHome: moss, canonical: (p: string) => p });
    const coding = { kind: "session", sessionId: "c", sessionKind: "coding" } as Caller;
    const plan = winLaunchPlan({ policy: fence.forCaller(coding).policy(), mossHome: fence.mossHome, caller: coding, bots: ["alpha"], entries: () => [] });
    const bot = { caller: "session:bot", opens: [fence.mossHome, win32.join(fence.mossHome, "bots", "alpha", "memory")], denyRead: [] };
    expect(grantsConflict(bot, { caller: "session:c", opens: plan.grantRead, denyRead: plan.denyRead })).toBe(false);
  });
});

describe("rule 7's move aside on Windows (the reviewer's WS2 finding 4)", () => {
  test("a folder on the way that is a link stops the move", () => {
    const st = (link: boolean) => ({ isDirectory: () => !link, isSymbolicLink: () => link });
    expect(winChainIsClean("C:\\a\\b\\f", () => st(false))).toBe(true);
    expect(winChainIsClean("C:\\a\\b\\f", (p) => st(p === "C:\\a\\b"))).toBe(false);
    expect(winChainIsClean("C:\\a\\b\\f", (p) => { if (p === "C:\\a") throw new Error("gone"); return st(false); })).toBe(false);
  });
  test("nothing made: no line", () => {
    expect(quarantineWin(new Map([["C:\\nowhere\\x", false]]), "C:\\h\\.moss")).toBeNull();
  });
});

describe("write roots in the wait and after it (rule 3c, the WS3 reviewer's finding 1)", () => {
  const moss = "C:\\h\\.moss";
  test("a coding session's new outputs root (a write root, read included) beside another's command is a conflict", () => {
    const a = { caller: "session:a", opens: [`${moss}\\outputs\\a`, "C:\\h\\AppData\\Local\\Temp\\moss-a"], denyRead: [moss] };
    const b = { caller: "session:b", opens: [`${moss}\\outputs\\b`], denyRead: [moss] };
    expect(grantsConflict(a, b)).toBe(true);
    expect(grantsConflict(a, { ...b, denyRead: [moss, `${moss}\\outputs\\a`] })).toBe(true); // b's own folder is still open to a
    expect(grantsConflict(a, { ...b, opens: [], denyRead: [moss, `${moss}\\outputs\\a`] })).toBe(false);
  });
  test("a root granted earlier under a later command's read deny is denied by name for it, never its own nor one denied already", () => {
    const granted = [`${moss}\\outputs\\a`, `${moss}\\outputs\\b`, `${moss}\\outputs\\c`, "D:\\proj"];
    expect(strayRoots(granted, [moss, `${moss}\\outputs\\c`], [`${moss}\\outputs\\b`])).toEqual([`${moss}\\outputs\\a`]);
    expect(strayRoots(granted, [], [])).toEqual([]);
  });
});

describe("the move across drives is capped (the WS3 reviewer's finding 4)", () => {
  const exdev = () => { const e = new Error("cross-device") as NodeJS.ErrnoException; e.code = "EXDEV"; throw e; };
  test("a tree over the entries or bytes cap stays where it is and is named; one within it is copied and removed", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ws4-q-")));
    try {
      const mossHome = join(root, "moss");
      const big = join(root, "big");
      mkdirSync(join(big, "deep"), { recursive: true });
      for (let i = 0; i < 300; i++) writeFileSync(join(big, "deep", `f${i}`), "x");
      const heavy = join(root, "heavy");
      writeFileSync(heavy, Buffer.alloc(4096));
      const small = join(root, "small");
      mkdirSync(small);
      writeFileSync(join(small, "a"), "x");
      const limits = { entries: 100, bytes: 2048 };
      expect(treeWithin(big, limits)).toBe(false);
      expect(treeWithin(heavy, limits)).toBe(false);
      expect(treeWithin(small, limits)).toBe(true);
      const line = quarantineWin(new Map([[big, false], [heavy, false], [small, false]]), mossHome, { rename: exdev, limits });
      expect(line).toContain(`${big} (more than 100 entries or 0 MB to copy across drives)`);
      expect(line).toContain(heavy);
      expect(line).toContain("could NOT be moved aside");
      expect(existsSync(join(big, "deep", "f299"))).toBe(true);
      expect(existsSync(heavy)).toBe(true);
      expect(existsSync(small)).toBe(false);
      expect(readdirSync(join(mossHome, "quarantine")).some((n) => n.startsWith("small.quarantined-"))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("rule 3c across an engine restart (the WS4 reviewer's item 2)", () => {
  test("srt-win's own list of this user's persistent roots, long-path prefix off, pending ones too; nothing from bad JSON", () => {
    const st = JSON.stringify({ persistent_grants: { state: "present", roots: ["\\\\?\\C:\\h\\.moss\\outputs\\a", "C:\\proj"], pending: ["E:\\x"] } });
    expect(parsePersistentRoots(st)).toEqual(["C:\\h\\.moss\\outputs\\a", "C:\\proj", "E:\\x"]);
    // Any other shape is a failed read (the WS5 reviewer's should-fix 2), never an empty list.
    expect(parsePersistentRoots("nope")).toBeNull();
    expect(parsePersistentRoots(JSON.stringify({ persistent_grants: { state: "none" } }))).toBeNull();
    expect(parsePersistentRoots(JSON.stringify({ persistent_grants: { roots: "C:\\x" } }))).toBeNull();
    expect(parsePersistentRoots(JSON.stringify({ persistent_grants: { roots: [1] } }))).toBeNull();
    expect(parsePersistentRoots(JSON.stringify({ persistent_grants: { roots: [], pending: {} } }))).toBeNull();
    expect(parsePersistentRoots(JSON.stringify({ persistent_grants_v2: { roots: [] } }))).toBeNull();
    expect(parsePersistentRoots(JSON.stringify({ persistent_grants: { state: "none", roots: [], pending: [] } }))).toEqual([]);
  });
  test("a new engine reads that list before its first command draws a plan, once; a read that failed is tried again", async () => {
    const m = machine();
    let fails = 1;
    const exec = m.deps.exec;
    const deps: WinFencedDeps = { ...m.deps, launcher: "C:\\seed-test\\srt-win.exe", async exec(argv, o) {
      if (argv[1] === "user" && argv[2] === "status") {
        m.execs.push(argv);
        if (fails-- > 0) return { code: 1, stdout: "", stderr: "busy" };
        return { code: 0, stdout: JSON.stringify({ persistent_grants: { state: "present", roots: [] } }), stderr: "" };
      }
      return exec(argv, o);
    } };
    const s = winFencedSpawner({ fence: m.fence, deps, grantAhead: false });
    const statusCalls = () => m.execs.filter((a) => a[1] === "user" && a[2] === "status").length;
    m.files["moss-sb-aaaaaa-1.used"] = ""; m.files["moss-sb-aaaaaa-2.used"] = "";
    await s.run(runOf(m.home));
    expect(statusCalls()).toBe(1);
    const firstGrant = m.execs.findIndex((a) => a[1] === "acl" && a[2] === "grant");
    const firstStatus = m.execs.findIndex((a) => a[1] === "user" && a[2] === "status");
    expect(firstStatus).toBeGreaterThanOrEqual(0);
    if (firstGrant >= 0) expect(firstStatus).toBeLessThan(firstGrant);
    m.files["moss-sb-aaaaaa-1.used"] = ""; m.files["moss-sb-aaaaaa-2.used"] = "";
    await s.run(runOf(m.home));
    expect(statusCalls()).toBe(2); // the first failed, so it is read again
    m.files["moss-sb-aaaaaa-1.used"] = ""; m.files["moss-sb-aaaaaa-2.used"] = "";
    await s.run(runOf(m.home));
    expect(statusCalls()).toBe(2); // read once it succeeded
  });
});

describe("the roots seed gates every command (the WS5 reviewer's should-fix 2)", () => {
  /** A launcher that records its argv, one argument a line, and exits 0: what the command was launched with. */
  const recorder = (dir: string) => {
    const file = join(dir, "argv.txt");
    const launcher = join(dir, "fake-srt.sh");
    writeFileSync(launcher, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${file}'\nexit 0\n`);
    chmodSync(launcher, 0o755);
    return { launcher, argv: () => (existsSync(file) ? readFileSync(file, "utf8").split("\n") : null) };
  };
  const coding = (cwd: string): FencedRun => ({ command: "echo hi", cwd, env: {}, timeoutMs: 10_000, who: { caller: { kind: "session", sessionId: "c1", sessionKind: "coding" } as Caller } });
  // The recording launcher is a shell script, which only a POSIX host launches: the lane's macOS and Linux suites run
  // this; the windows-fence unit job skips it (the e2e launches the real srt-win there).
  test.skipIf(process.platform === "win32")("a root from srt-win's list under the plan's denied folder is stamped as a by-name read deny", async () => {
    const m = machine();
    const moss = join(m.home, ".moss");
    mkdirSync(join(moss, "elsewhere", "root1"), { recursive: true });
    const root = realpathSync(join(moss, "elsewhere", "root1")); // a folder the plan doesn't name: only the seed can
    const cwd = join(moss, "outputs", "c1");
    mkdirSync(cwd, { recursive: true });
    const rec = recorder(mkdtempSync(join(tmpdir(), "ws6-rec-")));
    const exec = m.deps.exec;
    const deps: WinFencedDeps = { ...m.deps, launcher: rec.launcher, async exec(argv, o) {
      if (argv[1] === "user" && argv[2] === "status") return { code: 0, stdout: JSON.stringify({ persistent_grants: { state: "present", roots: [`\\\\?\\${root}`], pending: [] } }), stderr: "" };
      return exec(argv, o);
    } };
    const r = await winFencedSpawner({ fence: m.fence, deps, grantAhead: false }).run(coding(cwd));
    const argv = rec.argv();
    expect(r).not.toMatchObject({ kind: "refused" });
    expect(argv).not.toBeNull();
    const same = (a: string | undefined) => a !== undefined && win32.normalize(a).toLowerCase() === win32.normalize(root).toLowerCase();
    const at = argv!.findIndex((a, i) => a === "--deny-read" && same(argv![i + 1]));
    expect(at).toBeGreaterThanOrEqual(0);
  });
  test("a seed that fails or has another shape refuses the command, which never launches", async () => {
    for (const answer of [{ code: 1, stdout: "" }, { code: 0, stdout: "not json" }, { code: 0, stdout: JSON.stringify({ persistent_grants: { roots: "x" } }) }]) {
      const m = machine();
      const cwd = join(m.home, ".moss", "outputs", "c1");
      mkdirSync(cwd, { recursive: true });
      const rec = recorder(mkdtempSync(join(tmpdir(), "ws6-rec-")));
      const exec = m.deps.exec;
      const deps: WinFencedDeps = { ...m.deps, launcher: rec.launcher, async exec(argv, o) {
        if (argv[1] === "user" && argv[2] === "status") return { ...answer, stderr: "" };
        return exec(argv, o);
      } };
      const r = await winFencedSpawner({ fence: m.fence, deps, grantAhead: false }).run(coding(cwd));
      expect(r.kind).toBe("refused");
      const reason = r.kind === "refused" ? r.reason : "";
      expect(reason).toContain("couldn't be read");
      // It says what to do when it keeps failing, and the refusal uses no account up: nothing was leased, so no generation was marked used.
      expect(reason).toContain("if it keeps failing run `moss-core sandbox setup` again, or restart MOSS");
      expect(m.writes).toEqual([]);
      expect(rec.argv()).toBeNull();
    }
  });
});

describe("a background command on Windows (rule B, lane WS7)", () => {
  /** A spawner whose commands stream two lines, then run until stopped or released. */
  const slow = () => {
    const runs: FencedRun[] = [];
    const release: (() => void)[] = [];
    const spawner: FencedSpawner = { available: true, run: (r) => new Promise((res) => {
      runs.push(r);
      r.onOutput?.("line one\n", "stdout");
      r.onOutput?.("line two\n", "stderr");
      const done = (code: number) => res({ kind: "exited", code, stdout: "line one\n", stderr: "line two\n", shell: "git-bash" });
      r.signal?.addEventListener("abort", () => done(1), { once: true });
      release.push(() => done(0));
    }) };
    return { runs, release, spawner };
  };
  const make = (spawner: FencedSpawner, session: string, wakes: unknown[], allowWrite?: (moss: string, cwd: string) => string[],
    more: { bot?: string; sessionKind?: string; level?: () => Level | undefined } = {}) => {
    const cwd = mkdtempSync(join(tmpdir(), "ws7-bg-"));
    const moss = mkdtempSync(join(tmpdir(), "ws7-moss-"));
    const caller = { kind: "session", sessionId: session, sessionKind: more.sessionKind ?? "bot", bot: more.bot ?? "luna" } as Extract<Caller, { kind: "session" }>;
    const t = Object.fromEntries(windowsShellTools({
      spawner, caller, kind: "bot", cwd: () => cwd, userHome: "C:\\h", temp: "C:\\t", mossHome: moss,
      sandbox: () => (allowWrite === undefined ? {} : { filesystem: { allowWrite: allowWrite(moss, cwd) } }),
      wake: async (w) => { wakes.push(w); },
      ...(more.level === undefined ? {} : { level: more.level }),
    }).map((x) => [x.name, x]));
    return { t, cwd, moss };
  };
  const idOf = (text: string) => /win_bg_[0-9a-f]{8}/.exec(text)![0];
  const told = async (wakes: { task: string }[], id: string) => { for (let i = 0; i < 200 && !wakes.some((w) => w.task === id); i++) await Bun.sleep(10); return wakes.find((w) => w.task === id) as { status: string; text: string } | undefined; };
  test("it answers at once with its id and log; output is logged as it comes; its end is told; the lease is the run's", async () => {
    const s = slow();
    const wakes: { task: string; status: string; text: string }[] = [];
    const { t, moss } = make(s.spawner, "bg-a", wakes);
    const r = await t.Bash!.run({ command: "long", run_in_background: true });
    expect(r.isError).toBe(false);
    const id = /win_bg_[0-9a-f]{8}/.exec(r.text)![0];
    const log = /written to (\S+\.log)/.exec(r.text)![1]!;
    // The daemon's own folder, never the command's (which it could swap for a link to a file of the user's).
    expect(log).toBe(join(moss, "logs", "background", "bg-a", `${id}.log`));
    expect(windowsBackgroundOf("bg-a")).toEqual([id]);
    expect(readFileSync(log, "utf8")).toBe("line one\nline two\n");
    expect(s.runs[0]!.timeoutMs).toBe(24 * 3_600_000);
    expect(wakes).toHaveLength(0);
    s.release[0]!();
    for (let i = 0; i < 50 && wakes.length === 0; i++) await Bun.sleep(10);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({ task: id, status: "completed" });
    expect(wakes[0]!.text).toContain("exited with code 0");
    expect(readFileSync(log, "utf8")).toContain("[moss: the command exited with code 0]");
    expect(windowsBackgroundOf("bg-a")).toEqual([]);
  }, 30_000);
  test("TaskStop's stop ends it (its session's only) and it is told as stopped; at most two run per session", async () => {
    const s = slow();
    const wakes: { task: string; status: string }[] = [];
    const { t } = make(s.spawner, "bg-b", wakes);
    const ids: string[] = [];
    for (let i = 0; i < WIN_SHELL_BACKGROUND_PER_SESSION; i++) ids.push(/win_bg_[0-9a-f]{8}/.exec((await t.Bash!.run({ command: `c${i}`, run_in_background: true })).text)![0]);
    const third = await t.PowerShell!.run({ command: "c3", run_in_background: true });
    expect(third.isError).toBe(true);
    expect(third.text).toContain("running on this computer already");
    expect(await stopWindowsBackground("someone-else", ids[0]!)).toBeNull();
    const stopped = await stopWindowsBackground("bg-b", ids[0]!);
    expect(stopped).toMatchObject({ isError: false });
    expect(s.runs[0]!.signal!.aborted).toBe(true);
    for (let i = 0; i < 50 && wakes.length === 0; i++) await Bun.sleep(10);
    expect(wakes[0]).toMatchObject({ task: ids[0], status: "stopped" });
    expect(windowsBackgroundOf("bg-b")).toEqual([ids[1]!]);
    await stopWindowsBackground("bg-b", ids[1]!);
  }, 30_000);
  test("a refusal that comes at once is the call's answer; never with the escape flag; never without a way to tell its end", async () => {
    const refusing: FencedSpawner = { available: true, run: async () => ({ kind: "refused", reason: "Bash isn't set up" }) };
    const wakes: unknown[] = [];
    const { t } = make(refusing, "bg-c", wakes);
    const r = await t.Bash!.run({ command: "x", run_in_background: true });
    expect(r).toMatchObject({ isError: true, text: expect.stringContaining("Bash isn't set up") });
    const esc = await t.Bash!.run({ command: "x", run_in_background: true, dangerouslyDisableSandbox: true });
    expect(esc).toMatchObject({ isError: true, text: expect.stringContaining("runs in the foreground") });
  });
  test("never where the command may write: a write root that holds the log's folder refuses the start, and nothing runs", async () => {
    for (const roots of [(moss: string) => [moss], (moss: string) => [join(moss, "logs")], (moss: string, cwd: string) => [cwd, join(moss, "logs", "background")]]) {
      const s = slow();
      const { t, moss } = make(s.spawner, "bg-d", [], roots);
      const r = await t.Bash!.run({ command: "x", run_in_background: true });
      expect(r).toMatchObject({ isError: true, text: expect.stringContaining("can't be kept where this command may write") });
      expect(s.runs).toHaveLength(0);
      expect(existsSync(join(moss, "logs", "background"))).toBe(false);
    }
    // The command's own folder as a root is fine: the log is not there.
    const s = slow();
    const { t } = make(s.spawner, "bg-e", [], (_m, cwd) => [cwd]);
    const ok = await t.Bash!.run({ command: "x", run_in_background: true });
    expect(ok.isError).toBe(false);
    await stopWindowsBackground("bg-e", /win_bg_[0-9a-f]{8}/.exec(ok.text)![0]);
  }, 30_000);
  test("the whole engine runs at most two (the pool's four accounts less two kept for ordinary commands), across sessions", async () => {
    expect(WIN_SHELL_BACKGROUND_ENGINE).toBe(2);
    const s = slow();
    const a = make(s.spawner, "bg-f1", []), b = make(s.spawner, "bg-f2", []), c = make(s.spawner, "bg-f3", []);
    const ids = [idOf((await a.t.Bash!.run({ command: "x", run_in_background: true })).text), idOf((await b.t.Bash!.run({ command: "x", run_in_background: true })).text)];
    const third = await c.t.Bash!.run({ command: "x", run_in_background: true });
    expect(third.isError).toBe(true);
    expect(third.text).toContain("running on this computer already");
    expect(third.text).toContain("kept for ordinary commands");
    expect(s.runs).toHaveLength(2);
    // A foreground command of the third session still runs.
    const fg = c.t.Bash!.run({ command: "y" });
    expect(s.runs).toHaveLength(3);
    s.release[2]!();
    expect((await fg).isError).toBe(false);
    await stopWindowsBackground("bg-f1", ids[0]!);
    await stopWindowsBackground("bg-f2", ids[1]!);
  }, 30_000);
  test("rule 8c: when the fenced set grows, it is ended and the bot is told to run it again", async () => {
    const s = slow();
    const wakes: { task: string; status: string; text: string }[] = [];
    const { t } = make(s.spawner, "bg-g", wakes);
    const id = idOf((await t.Bash!.run({ command: "x", run_in_background: true })).text);
    s.runs[0]!.onFenceGrew!();
    const end = await told(wakes, id);
    expect(end).toMatchObject({ status: "stopped" });
    expect(end!.text).toContain("something the sandbox protects appeared");
    expect(end!.text).toContain("run it again");
    expect(windowsBackgroundOf("bg-g")).toEqual([]);
  }, 30_000);
  test("ended from outside, each told why: the pause, this computer no longer running the bots, a removed bot, a lowered level, a conversation ended", async () => {
    let paused = false, runs = true;
    const gateFns: (() => void)[] = [], botFns: ((e: { type: string; id?: unknown }) => void)[] = [], levelFns: (() => void)[] = [];
    const off = endWindowsBackgroundOn({
      gate: { watch: (fn) => { gateFns.push(fn); return () => {}; }, mayAct: (v) => v.kind === "coding" || (!paused && (v.kind !== "bot" || runs)), get paused() { return paused; } },
      bots: { onEvent: (fn) => { botFns.push(fn); return () => {}; } },
      levels: { watch: (fn) => { levelFns.push(fn); return () => {}; } },
    });
    const s = slow();
    const wakes: { task: string; status: string; text: string }[] = [];
    const start = async (session: string, more: Parameters<typeof make>[4] = {}) => idOf((await make(s.spawner, session, wakes, undefined, more).t.Bash!.run({ command: "x", run_in_background: true })).text);
    const cases: [string, () => void, string, Parameters<typeof make>[4]?][] = [
      ["bg-h1", () => { paused = true; gateFns.forEach((f) => f()); }, "the user paused the bots"],
      ["bg-h2", () => { paused = false; runs = false; gateFns.forEach((f) => f()); }, "this computer stopped running the bots"],
      ["bg-h3", () => { runs = true; botFns.forEach((f) => f({ type: "bot_removed", id: "nova" })); }, "its bot was removed or archived", { bot: "nova" }],
      ["bg-h5", () => void endWindowsBackgroundOf("bg-h5", "its conversation was deleted"), "its conversation was deleted"],
    ];
    for (const [session, act, why, more] of cases) {
      const id = await start(session, more);
      // Another session's command, not picked by the event, keeps running.
      const other = await start(`${session}-other`, { bot: "sol", sessionKind: "coding" });
      act();
      const end = await told(wakes, id);
      expect([session, end?.status, end?.text.includes(why)]).toEqual([session, "stopped", true]);
      expect(windowsBackgroundOf(`${session}-other`)).toEqual([other]);
      await stopWindowsBackground(`${session}-other`, other);
    }
    // The level: lowered below the one it started under ends it; raised, or the same, doesn't.
    let level: Level | undefined = "accept-edits";
    const id = await start("bg-h4", { level: () => level });
    level = "automatic"; levelFns.forEach((f) => f());
    level = "accept-edits"; levelFns.forEach((f) => f());
    await Bun.sleep(50);
    expect(windowsBackgroundOf("bg-h4")).toEqual([id]);
    level = "ask"; levelFns.forEach((f) => f());
    const end = await told(wakes, id);
    expect(end).toMatchObject({ status: "stopped", text: expect.stringContaining("the approval level was lowered") });
    off();
  }, 30_000);
});

describe("the exclusions follow the fenced set (rule 8b, lane WS7)", () => {
  test("a fenced path made after the grant is excluded by a fresh grant before the next command; nothing changes when none is", async () => {
    const m = machine();
    const s = winFencedSpawner({ fence: m.fence, deps: m.deps, grantAhead: false });
    const grants = () => m.execs.filter((a) => a[1] === "profile" && a[2] === "grant");
    const fresh = () => { m.files["moss-sb-aaaaaa-1.used"] = ""; m.files["moss-sb-aaaaaa-2.used"] = ""; };
    fresh();
    await s.run(runOf(m.home));
    const first = grants().length;
    expect(first).toBeGreaterThan(0);
    fresh();
    await s.run(runOf(m.home));
    expect(grants().length).toBe(first); // nothing new: no grant
    // A place the fence names, made now (say a new key store in the home).
    const candidate = profileExcludeCandidates(m.fence).find((p) => !existsSync(p))!;
    expect(candidate).toBeDefined();
    mkdirSync(candidate, { recursive: true });
    fresh();
    await s.run(runOf(m.home));
    const again = grants();
    expect(again.length).toBe(first + 1);
    expect(again[again.length - 1]).toContain(candidate);
  });
  // A launcher that sleeps, so the command is running while the fence changes: a shell script, which only a POSIX host
  // launches (the windows-fence unit job skips it; the e2e runs the real srt-win).
  test.skipIf(process.platform === "win32")("rule 8c: a long command is told once when a protected path appears while it runs; one with nothing new is not", async () => {
    for (const appears of [true, false]) {
      const m = machine();
      const dir = mkdtempSync(join(tmpdir(), "ws7-8c-"));
      const launcher = join(dir, "sleepy-srt.sh");
      writeFileSync(launcher, "#!/bin/sh\n/bin/sleep 2\nexit 0\n");
      chmodSync(launcher, 0o755);
      const exec = m.deps.exec;
      const deps: WinFencedDeps = { ...m.deps, launcher, fenceWatchMs: 50, exec: (argv, o) => exec(argv[0] === launcher ? [m.deps.launcher, ...argv.slice(1)] : argv, o) };
      const s = winFencedSpawner({ fence: m.fence, deps, grantAhead: false });
      const candidate = profileExcludeCandidates(m.fence).find((p) => !existsSync(p))!;
      let grew = 0;
      const run = s.run({ ...runOf(m.home), timeoutMs: 10_000, onFenceGrew: () => { grew++; } });
      if (appears) { await Bun.sleep(700); mkdirSync(candidate, { recursive: true }); }
      const r = await run;
      expect(r).not.toMatchObject({ kind: "refused" });
      expect([appears, grew]).toEqual([appears, appears ? 1 : 0]);
    }
  }, 30_000);
  test.skipIf(process.platform === "win32")("rule 8c's baseline is the grant in force: a place that appeared before the command but that the grant doesn't hold yet (its refresh failed) ends it", async () => {
    const m = machine();
    const dir = mkdtempSync(join(tmpdir(), "ws7-8c-"));
    const launcher = join(dir, "sleepy-srt.sh");
    writeFileSync(launcher, "#!/bin/sh\n/bin/sleep 2\nexit 0\n");
    chmodSync(launcher, 0o755);
    let grants = 0;
    const exec = m.deps.exec;
    const deps: WinFencedDeps = { ...m.deps, launcher, fenceWatchMs: 50, exec: (argv, o) => {
      if (argv[1] === "profile" && argv[2] === "grant" && ++grants > 1) return Promise.resolve({ code: 24, stdout: "", stderr: "" }); // the refresh fails
      return exec(argv[0] === launcher ? [m.deps.launcher, ...argv.slice(1)] : argv, o);
    } };
    const s = winFencedSpawner({ fence: m.fence, deps, grantAhead: false });
    await s.run({ ...runOf(m.home), timeoutMs: 10_000 }); // the grant, made with what exists now
    mkdirSync(profileExcludeCandidates(m.fence).find((p) => !existsSync(p))!, { recursive: true });
    m.files["moss-sb-aaaaaa-1.used"] = ""; m.files["moss-sb-aaaaaa-2.used"] = "";
    let grew = 0;
    const r = await s.run({ ...runOf(m.home), timeoutMs: 10_000, onFenceGrew: () => { grew++; } });
    expect(r).not.toMatchObject({ kind: "refused" });
    expect(grants).toBeGreaterThan(1); // the refresh was tried, and failed
    expect(grew).toBe(1);
  }, 30_000);
  test("rule 8c's decision (lane WS8): a new protected root ends the command; a new match of a protected pattern is stamped for its account, live", () => {
    const sidecar = "C:\\h\\.moss\\projects\\p\\s9.provider-state.jsonl";
    expect(lateFenceStep({ freshReads: [], excludesGrew: false, sid: "S-1-5-21-9" })).toEqual({ kind: "none" });
    expect(lateFenceStep({ freshReads: [sidecar], excludesGrew: false, sid: "S-1-5-21-9" })).toEqual({ kind: "stamp", paths: [sidecar] });
    expect(lateFenceStep({ freshReads: [sidecar], excludesGrew: true, sid: "S-1-5-21-9" })).toEqual({ kind: "end" });
    expect(lateFenceStep({ freshReads: [], excludesGrew: true, sid: "S-1-5-21-9" })).toEqual({ kind: "end" });
    expect(lateFenceStep({ freshReads: [sidecar], excludesGrew: false, sid: null })).toEqual({ kind: "end" }); // no account to stamp for
  });
  test("rule 8c watches the literal denies and the fixed-depth globs, never a `**` walk", () => {
    const tree = new Map<string, string[]>([["C:\\m", ["projects", "deep"]], ["C:\\m\\projects", ["p1"]], ["C:\\m\\projects\\p1", ["s.provider-state.jsonl"]], ["C:\\m\\deep", ["a"]], ["C:\\m\\deep\\a", ["k.pem"]]]);
    const all = new Set(["C:\\m\\secret.txt", ...[...tree].flatMap(([d, ns]) => [d, ...ns.map((n) => `${d}\\${n}`)])]);
    const listed: string[] = [];
    const got = watchedReadDenies(["C:\\m\\secret.txt", "C:\\m\\absent", "C:\\m\\projects\\*\\*.provider-state.jsonl", "C:\\m\\deep\\**\\*.pem"], {
      exists: (p) => all.has(p), list: (d) => { listed.push(d); return tree.get(d) ?? []; }, isDir: (p) => tree.has(p),
    });
    expect(got.sort()).toEqual(["C:\\m\\projects\\p1\\s.provider-state.jsonl", "C:\\m\\secret.txt"]);
    expect(listed.some((d) => d.startsWith("C:\\m\\deep"))).toBe(false);
  });
});
