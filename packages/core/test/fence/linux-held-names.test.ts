// Lane XC 3c: on Linux the runtime holds a run-later pattern's matches only as far as its walk reaches (50,000 entries,
// 16 levels, node_modules skipped). A root of the user's that the walk can't finish, or that holds a repository inside
// node_modules, isn't handed to the runtime (`linuxHoldProblem`, `botSandboxSettings`), and a refused write says why
// (`leftOutNote`). And, live on Linux: the review's rename (`mv proj proj-old && mkdir -p proj/.git/hooks …`) under
// real bubblewrap leaves the held `.git` where it was.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fence } from "../../src/contracts/fence";
import { MossFence } from "../../src/fence/fence";
import { fencedSpawner } from "../../src/fence/fenced-process";
import { botSandboxSettings, denyRegex, heldNames, leftOutRoots, LINUX_LEAVE_OUT_UNHELD, linuxHoldProblem, shellRunLaterDenies } from "../../src/fence/sandbox-settings";
import { leftOutNote } from "../../src/runtime-sdk/turn-loop/driver";
import { hostOs } from "../../src/tree/names";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
function temp(prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
}
const posixTest = process.platform === "win32" ? test.skip : test;
const small = { maxVisited: 40, maxDepth: 4, nodeModules: 40 };

/** The deny globs whose fixed part (before the first `*`) is the user's home or holds a drawn root: on Linux the runtime
 *  walks a glob's fixed part at each command, and from 0.0.89 a walk it can't finish leaves every root that overlaps it
 *  unwritable, so a fixed part wider than the roots can drop the bot's own folders (lane XC, the 0.0.89 e2e). */
function widerThanTheRoots(globs: readonly string[], roots: readonly string[], home: string): string[] {
  const under = (a: string, b: string) => a.startsWith(`${b}/`);
  return globs.filter((g) => g.includes("*")).filter((g) => {
    const fixed = g.slice(0, g.indexOf("*")).replace(/\/+$/, "");
    return fixed === home || under(home, fixed) || roots.some((r) => under(r, fixed));
  });
}

describe("no deny glob MOSS hands the runtime is wider than the roots drawn", () => {
  posixTest("the hooks deny goes under the home's entries, never the home, when the home is drawn as its entries", () => {
    const home = temp("xc-wide-");
    const moss = join(home, ".moss");
    mkdirSync(join(moss, "scratch", "luna"), { recursive: true });
    for (const f of ["Documents", "Projects", "app"]) mkdirSync(join(home, f), { recursive: true });
    const fence = new MossFence({ os: hostOs(), home, mossHome: moss, temp: temp("xc-wide-tmp-") });
    for (const level of ["automatic", "accept-edits"] as const) {
      const s = botSandboxSettings(fence.policy(), { mossHome: moss, userHome: home, level, ownFolders: [join(moss, "scratch", "luna")], pathFolders: [] });
      const roots = s.filesystem?.allowWrite ?? [];
      // The home is drawn as its entries here (the MOSS home is inside it).
      expect([level, roots.includes(home)]).toEqual([level, false]);
      const denies = [...(s.filesystem?.denyWrite ?? []), ...(s.filesystem?.denyRead ?? [])];
      // The held names go from `/` on purpose: on macOS Seatbelt matches as each path opens; on Linux the runtime never
      // makes `/` a prefix of its own and walks such a pattern under the roots only (the next describe).
      const walked = denies.filter((d) => !d.startsWith("/**"));
      expect([level, widerThanTheRoots(walked, roots, home)]).toEqual([level, []]);
    }
  });
});

describe("on Linux the held names go once each from `/`, held under every root as before", () => {
  test("every held name under every root is still matched; the globs are one per name (plus each root's .moss), not one per root per name", () => {
    const roots = Array.from({ length: 100 }, (_, i) => `/h/top${i}`).concat(["/h/.moss/scratch/luna", "/t/tmp-moss"]);
    const denies = shellRunLaterDenies(roots, { userHome: "/h", mossHome: "/h/.moss", os: "linux", pathFolders: [] });
    const globs = denies.filter((d) => d.includes("*"));
    const res = globs.map((g) => denyRegex(g, "linux"));
    for (const root of roots) {
      for (const name of heldNames()) {
        const at = `${root}/a/b/${name}`;
        expect([at, res.some((r) => r.test(at))]).toEqual([at, true]);
      }
    }
    // One per name from `/`, and each root's `.moss` (as before: every root that doesn't hold the MOSS home).
    expect(globs.length).toBe(heldNames().length + roots.length);
    expect(globs.length).toBeLessThan(heldNames().length * roots.length / 10);
    // No root, nothing to hold (the walk has nowhere to go).
    expect(shellRunLaterDenies([], { userHome: "/h", mossHome: "/h/.moss", os: "linux", pathFolders: [] })).toEqual([]);
  });
});

describe("linuxHoldProblem: the runtime's walk, as it runs", () => {
  posixTest("a tree the walk finishes, with its repos held by name: nothing to say", () => {
    const root = temp("xc3c-ok-");
    mkdirSync(join(root, "app", ".git", "hooks"), { recursive: true });
    mkdirSync(join(root, "app", "src"), { recursive: true });
    // A held name isn't walked into, however much it holds.
    for (let i = 0; i < 80; i++) writeFileSync(join(root, "app", ".git", `obj${i}`), "x");
    expect(linuxHoldProblem(root, { list: undefined, now: 0, limits: small })).toBeUndefined();
  });

  posixTest("past the entries or the depth: the root isn't handed over, with the reason", () => {
    const wide = temp("xc3c-wide-");
    for (let i = 0; i < 50; i++) writeFileSync(join(wide, `f${i}`), "x");
    expect(linuxHoldProblem(wide, { now: 1, limits: small })).toContain("more than the sandbox can check");
    const deep = temp("xc3c-deep-");
    mkdirSync(join(deep, "a", "b", "c", "d", "e", "f"), { recursive: true });
    expect(linuxHoldProblem(deep, { now: 2, limits: small })).toContain("4 folders deep");
    // Exactly at the depth: still within the walk.
    const edge = temp("xc3c-edge-");
    mkdirSync(join(edge, "a", "b", "c", "d"), { recursive: true });
    expect(linuxHoldProblem(edge, { now: 3, limits: small })).toBeUndefined();
  });

  posixTest("a repository inside node_modules (a package from git): not handed over; a plain node_modules is fine", () => {
    const root = temp("xc3c-nm-");
    mkdirSync(join(root, "app", "node_modules", "left-pad", "lib"), { recursive: true });
    expect(linuxHoldProblem(root, { now: 4, limits: small })).toBeUndefined();
    const withRepo = temp("xc3c-nm-git-");
    mkdirSync(join(withRepo, "app", "node_modules", "@scope", "pkg", ".git", "hooks"), { recursive: true });
    expect(linuxHoldProblem(withRepo, { now: 5, limits: small })).toContain("inside node_modules");
    // A name with control characters is folded out of the reason, and a long path clamped.
    const odd = temp("xc3c-nm-odd-");
    mkdirSync(join(odd, "node_modules", "a\u001b[31m‮b", ".git"), { recursive: true });
    const oddWhy = linuxHoldProblem(odd, { now: 8, limits: small })!;
    expect(oddWhy).toContain("inside node_modules");
    expect(/[\u0000-\u001f‮]/.test(oddWhy)).toBe(false);
    const long = temp("xc3c-nm-long-");
    mkdirSync(join(long, "node_modules", "x".repeat(240), ".git"), { recursive: true });
    expect(linuxHoldProblem(long, { now: 9, limits: small })!.length).toBeLessThan(200 + long.length + 120);
    const bare = temp("xc3c-nm-bare-");
    mkdirSync(join(bare, "node_modules", "x", "cache.git"), { recursive: true });
    expect(linuxHoldProblem(bare, { now: 6, limits: small })).toContain("inside node_modules");
  });

  posixTest("names held as the runtime holds them on Linux: case as written, so a `.GIT` folder is walked into", () => {
    const root = temp("xc3c-case-");
    mkdirSync(join(root, ".GIT"), { recursive: true });
    for (let i = 0; i < 50; i++) writeFileSync(join(root, ".GIT", `o${i}`), "x");
    expect(linuxHoldProblem(root, { now: 7, limits: small })).toContain("more than the sandbox can check");
  });
});

describe("leftOutNote: a refused write says which roots were left out and why", () => {
  const leftOut = [{ root: "/home/u", why: "/home/u holds a repository inside node_modules (/home/u/app/node_modules/p/.git), where the sandbox doesn't hold a .git" }];
  test("on a refused write, after its stderr", () => {
    const r = leftOutNote({ stdout: "", stderr: "touch: cannot touch 'x': Read-only file system\n", interrupted: false }, leftOut) as { stderr: string; stdout: string };
    expect(r.stderr).toBe("touch: cannot touch 'x': Read-only file system\n[MOSS] Shell commands can't write /home/u (/home/u holds a repository inside node_modules (/home/u/app/node_modules/p/.git), where the sandbox doesn't hold a .git). Use Write or Edit there, which ask when they need to.");
    expect(r.stdout).toBe("");
    expect(String(leftOutNote("sh: x: Permission denied", leftOut))).toContain("[MOSS] Shell commands can't write /home/u");
  });
  test("nothing on a command that didn't hit a refusal, or with nothing left out", () => {
    expect(leftOutNote({ stdout: "ok\n", stderr: "" }, leftOut)).toBeUndefined();
    expect(leftOutNote({ stdout: "", stderr: "Read-only file system" }, [])).toBeUndefined();
  });
});

(process.platform === "linux" ? describe : describe.skip)("on Linux: the drawn sandbox and real bubblewrap", () => {
  test("at fully automatic a home holding a repo in node_modules isn't a write root; the bot's own folders stay", () => {
    const home = temp("xc3c-home-");
    const moss = join(home, ".moss");
    const scratch = join(moss, "scratch", "luna");
    mkdirSync(scratch, { recursive: true });
    mkdirSync(join(home, "app", "node_modules", "p", ".git"), { recursive: true });
    const fence = new MossFence({ os: "linux", home, mossHome: moss, temp: temp("xc3c-tmp-") });
    // The MOSS home is inside the user's home, so the home is drawn as its entries but the way to `.moss`
    // (`sandboxSettingsOf`'s `except`): here `app`, the folder holding the repo.
    const app = join(home, "app");
    // The leaving out is off for now (LINUX_LEAVE_OUT_UNHELD): every root is handed, as before 3c.
    const off = botSandboxSettings(fence.policy(), { mossHome: moss, userHome: home, level: "automatic", ownFolders: [scratch], pathFolders: [] });
    expect(LINUX_LEAVE_OUT_UNHELD).toBe(false);
    expect(off.filesystem?.allowWrite ?? []).toContain(app);
    expect(leftOutRoots(off)).toEqual([]);
    // Turned on, that root is left out with its reason.
    const s = botSandboxSettings(fence.policy(), { mossHome: moss, userHome: home, level: "automatic", ownFolders: [scratch], pathFolders: [], linuxLeaveOut: true });
    expect(s.filesystem?.allowWrite ?? []).not.toContain(app);
    expect(leftOutRoots(s).map((l) => l.root)).toEqual([app]);
    expect(leftOutRoots(s)[0]!.why).toContain("inside node_modules");
  });

  test("the review's rename under real bubblewrap: the held .git stays, nothing is planted at its path", async () => {
    const home = temp("xc3c-bwrap-");
    for (const d of ["work/proj/.git/hooks", "tmp", ".moss"]) mkdirSync(join(home, d), { recursive: true });
    writeFileSync(join(home, "work", "proj", ".git", "config"), "ORIGINAL\n");
    const base = new MossFence({ os: "linux", home, mossHome: join(home, ".moss"), temp: join(home, "tmp") });
    const held = join(home, "work", "proj", ".git");
    // The write root and the held place as the runtime and the peer floor draw them: the matches there at the start.
    const fence = new Proxy(base, {
      get(t, k) {
        if (k === "policy") return (ctx?: Parameters<Fence["policy"]>[0]) => { const p = t.policy(ctx); return { ...p, allowWrite: [join(home, "work")], denyWrite: [...p.denyWrite, held] }; };
        const v = Reflect.get(t, k, t) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    }) as MossFence;
    const spawner = fencedSpawner({ fence });
    if (!spawner.available) return;
    const r = await spawner.run({
      command: "mv proj proj-old && mkdir -p proj/.git/hooks && printf 'planted' > proj/.git/hooks/post-checkout && echo done",
      cwd: join(home, "work"), env: { PATH: "/usr/bin:/bin", HOME: home }, timeoutMs: 30_000,
      who: { caller: { kind: "session", sessionId: "c1", sessionKind: "coding" } },
    });
    expect(r.kind === "exited" ? r.stdout : r.kind).not.toContain("done");
    expect(existsSync(join(home, "work", "proj-old"))).toBe(false);
    expect(readFileSync(join(held, "config"), "utf8")).toBe("ORIGINAL\n");
    expect(existsSync(join(held, "hooks", "post-checkout"))).toBe(false);
  }, 120_000);
});
