// Lane XC: what MOSS hands the agent runtime's Linux sandbox for the held names (one `/**` pattern per name, the hooks
// deny under the roots drawn, no deny wider than the roots), the plain-words note for the roots the runtime's walk
// dropped (`droppedRootsNote`), and, live on Linux: the review's rename (`mv proj proj-old && mkdir -p
// proj/.git/hooks …`) under real bubblewrap leaves the held `.git` where it was.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fence } from "../../src/contracts/fence";
import { MossFence } from "../../src/fence/fence";
import { fencedSpawner } from "../../src/fence/fenced-process";
import { botSandboxSettings, denyRegex, heldNames, shellRunLaterDenies } from "../../src/fence/sandbox-settings";
import { droppedRootsNote } from "../../src/runtime-sdk/turn-loop/driver";
import { hostOs } from "../../src/tree/names";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
function temp(prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
}
const posixTest = process.platform === "win32" ? test.skip : test;

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

describe("droppedRootsNote: the roots the runtime's walk dropped this command, in plain words for the bot", () => {
  // The agent runtime 0.0.90's own line (sandbox/spawn.ts `notHeldNote`), added to a failed command's stderr.
  const runtimeLine = "\n[sandbox] not writable this run, too large to check for protected paths (over 200,000 entries or 16 folders deep, or past the 400,000 entries or 3 s one command reads, node_modules included): /h/Photos, /h/.cache\n";
  test("after the runtime's line, which roots and that Write and Edit still can", () => {
    const r = droppedRootsNote({ stdout: "", stderr: `bash: /h/Photos/x: Read-only file system${runtimeLine}`, code: 1 }) as { stderr: string };
    expect(r.stderr).toContain("[MOSS] This computer's sandbox couldn't finish checking /h/Photos, /h/.cache in time, so shell commands can't write there this time; Write and Edit still can.");
    expect(droppedRootsNote(`x${runtimeLine}`)).toEqual(expect.stringContaining("couldn't finish checking /h/Photos, /h/.cache"));
  });
  test("nothing on a result without that line", () => {
    expect(droppedRootsNote({ stdout: "ok", stderr: "", code: 0 })).toBeUndefined();
    expect(droppedRootsNote("Read-only file system")).toBeUndefined();
  });
});

(process.platform === "linux" ? describe : describe.skip)("on Linux: the drawn sandbox and real bubblewrap", () => {
  test("at fully automatic the home is handed as its entries, a repo in node_modules or not (the runtime holds it)", () => {
    const home = temp("xc3c-home-");
    const moss = join(home, ".moss");
    const scratch = join(moss, "scratch", "luna");
    mkdirSync(scratch, { recursive: true });
    mkdirSync(join(home, "app", "node_modules", "p", ".git"), { recursive: true });
    const fence = new MossFence({ os: "linux", home, mossHome: moss, temp: temp("xc3c-tmp-") });
    // The MOSS home is inside the user's home, so the home is drawn as its entries but the way to `.moss`
    // (`sandboxSettingsOf`'s `except`): here `app`, the folder holding the repo.
    const app = join(home, "app");
    // Every root is handed; the agent runtime walks node_modules for the held names itself and fails closed.
    const s = botSandboxSettings(fence.policy(), { mossHome: moss, userHome: home, level: "automatic", ownFolders: [scratch], pathFolders: [] });
    expect(s.filesystem?.allowWrite ?? []).toContain(app);
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
