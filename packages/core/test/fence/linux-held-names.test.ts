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
import { botSandboxSettings, leftOutRoots, linuxHoldProblem } from "../../src/fence/sandbox-settings";
import { leftOutNote } from "../../src/runtime-sdk/turn-loop/driver";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
function temp(prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
}
const posixTest = process.platform === "win32" ? test.skip : test;
const small = { maxVisited: 40, maxDepth: 4, nodeModules: 40 };

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
    const s = botSandboxSettings(fence.policy(), { mossHome: moss, userHome: home, level: "automatic", ownFolders: [scratch], pathFolders: [] });
    expect(s.filesystem?.allowWrite ?? []).not.toContain(home);
    expect(leftOutRoots(s).map((l) => l.root)).toEqual([home]);
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
