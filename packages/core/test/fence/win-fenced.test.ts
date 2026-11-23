// The Windows leg of the fenced spawner, its pure half and its refusals, on every OS (lane WS). The real launches run
// in win-fenced.e2e.test.ts on windows-latest.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/moss-protocol";
import { MossFence } from "../../src/fence/fence";
import { escapedSandbox, windowsShellTools } from "../../src/fence/win-shell-tools";
import {
  existingDenies, existingDeniesOf, planFromSettings, shellArgv, winChildEnv, winExecArgv, winFencedSpawner, windowsRoots, windowsShells, WIN_ARGV_LIMIT,
  type WinFencedDeps,
} from "../../src/fence/win-fenced";
import { formatInstallMarker, poolLockPath, type LeaseStore } from "../../src/fence/win-sandbox";
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

/** Fake machine: a launcher that is (or isn't) pinned, a marker, a profile per principal and an in-memory lease store. */
function machine(o: { pinned?: boolean; marker?: string | null; profile?: (sid: string) => string | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "moss-winfenced-"));
  const home = join(root, "home");
  mkdirSync(join(home, ".moss"), { recursive: true });
  const held = new Set<string>();
  const leases: LeaseStore = { tryLock: (p) => (held.has(p) ? null : (held.add(p), { release: () => { held.delete(p); } })) };
  const execs: (readonly string[])[] = [];
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
    leasesDir: join(root, "leases"),
    async exec(argv) {
      execs.push(argv);
      if (argv[0] === "reg" && argv[2] === "HKLM\\SOFTWARE\\sandbox-runtime") return { code: 0, stdout: "    SandboxUserSid    REG_SZ    S-1-5-21-1002\r\n", stderr: "" };
      if (argv[0] === "reg") {
        const sid = /ProfileList\\(S-[0-9-]+)/.exec(argv[2]!)?.[1] ?? "";
        const p = (o.profile ?? (() => null))(sid);
        return p === null ? { code: 1, stdout: "", stderr: "not found" } : { code: 0, stdout: `    ProfileImagePath    REG_EXPAND_SZ    ${p}\r\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
    readFile: (p) => (p.endsWith("S-1-5-21-1.json") ? marker : null),
    leaseTimeoutMs: 0,
  };
  const fence = new MossFence({ home, mossHome: join(home, ".moss"), os: "windows" });
  return { deps, fence, execs, home };
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

  test("a principal whose profile wasn't reset since its last command is never used: the reset task is asked, then refused", async () => {
    const m = machine({ profile: (sid) => `C:\\Users\\p-${sid}` });
    const s = winFencedSpawner({ fence: m.fence, deps: m.deps });
    const r = await s.run(runOf(m.home));
    expect(r).toMatchObject({ kind: "refused" });
    expect((r as { reason: string }).reason).toContain("reset since its last command");
    // Both members were looked at, the reset task was asked for, and nothing was granted or launched.
    expect(m.execs.filter((a) => a[0] === "reg").map((a) => a[2]!.slice(-4))).toEqual(["1001", "1002"]);
    expect(m.execs.some((a) => a[0] === "schtasks" && a.includes("/run") && a.includes("MOSS Sandbox Reset S-1-5-21-1"))).toBe(true);
    expect(m.execs.some((a) => a.includes("acl") || a.includes("exec"))).toBe(false);
  });

  test("a reset principal is taken first, and an unreset one is skipped", async () => {
    const m = machine({ profile: (sid) => (sid.endsWith("1001") ? "C:\\Users\\moss-sb-aaaaaa-1" : null) });
    const s = winFencedSpawner({ fence: m.fence, deps: { ...m.deps, exec: async (argv, x) => {
      if (argv.includes("exec")) return { code: 0, stdout: "", stderr: "" };
      return m.deps.exec(argv, x);
    } } });
    await s.run(runOf(m.home)).catch(() => undefined);
    const grant = m.execs.find((a) => a.includes("grant") && a.includes("--persistent"));
    expect(grant).toBeDefined();
    expect(grant).toContain("S-1-5-21-1002");
  });

  test("every principal busy: refused rather than shared", async () => {
    const m = machine({ marker: formatInstallMarker({ version: 2, ownerSid: "S-1-5-21-1", members: [{ principal: "moss-sb-aaaaaa-1", principalSid: "S-1-5-21-1001", sublayer: "x" }] }) });
    const held = m.deps.leases().tryLock(poolLockPath(m.deps.leasesDir, "moss-sb-aaaaaa-1"));
    expect(held).not.toBeNull();
    const r = await winFencedSpawner({ fence: m.fence, deps: m.deps }).run(runOf(m.home));
    expect(r).toMatchObject({ kind: "refused" });
    expect((r as { reason: string }).reason).toContain("busy");
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

