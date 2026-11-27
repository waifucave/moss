// Lane XC (owed item 5; the controller's ruling, option (a)): a Linux holder gives another computer's command its folder
// exactly as macOS does, the same rule as a local bot there, and runs it under the agent runtime's own sandbox
// (fence/peer-folder-linux.ts). On every OS: the executor hands a Linux peer call its folder with the local bot's
// denies, and the spawner turns the peer fence's policy into the runtime's settings with nothing widened (no network,
// the per-call temp root and the folder as the only write roots, the secret places and the MOSS home denied), refusing
// a working folder outside them. Live on Linux under real bubblewrap (the runtime's `./sandbox` entry, agent runtime
// 0.0.91): the reviewer's rename and a planted hook.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/moss-protocol";
import { fencedExecutor, HOLDER_NOTICE_WINDOW_MS, PEER_END_NOT_CLEAN } from "../../src/computers/fenced-executor";
import { MossFence } from "../../src/fence/fence";
import { fencedSpawner } from "../../src/fence/fenced-process";
import { peerFence, peerFolderDenies, type PeerWriteFolder } from "../../src/fence/peer-floor";
import { PEER_NEW_REPO_ADVICE, PEER_UNSWEPT_ADVICE, peerFolderSpawnerLinux, peerRuntimeSettings } from "../../src/fence/peer-folder-linux";
import type { FencedRun, FencedRunResult, FencedSpawner } from "../../src/fence/spawn";
import { secretReadPlaces } from "../../src/contracts/fence";
import { hostOs } from "../../src/tree/names";
import type { ToolRunContext } from "../../src/tree/service";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (p: string) => { const d = realpathSync.native(mkdtempSync(join(tmpdir(), p))); temps.push(d); return d; };
const PEER: Caller = { kind: "peer", device: "d_laptop", computer: "Laptop" } as Caller;

/** A home with a project holding a repository, the MOSS home and a temp folder. */
function world() {
  const home = temp("xc-peer-linux-");
  const moss = join(home, ".moss");
  const tmp = join(home, "tmp");
  const project = join(home, "work", "proj");
  for (const d of [moss, tmp, join(project, ".git", "hooks")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(project, ".git", "config"), "ORIGINAL\n");
  return { home, moss, tmp, work: join(home, "work"), project };
}

function ctx(cwd: string, write: ToolRunContext["write"]): ToolRunContext {
  return { as: PEER, session: "s_peer", callId: "c1", cwd, treeCwd: "home/Beta/work/proj", signal: new AbortController().signal, output: () => {}, write } as ToolRunContext;
}

describe("a Linux holder hands a peer's call its folder (the executor)", () => {
  test("given its folder, the call's spawner gets it with the local bot's denies; Windows still none", async () => {
    const w = world();
    const seen: (PeerWriteFolder | undefined)[] = [];
    const spawner: FencedSpawner = { available: true, run: async (): Promise<FencedRunResult> => ({ kind: "exited", code: 0, stdout: "", stderr: "", shell: "sh" }) };
    for (const os of ["linux", "windows"] as const) {
      seen.length = 0;
      const exec = fencedExecutor({
        spawner, home: w.home, temp: w.tmp, mossHome: w.moss, os,
        peerSpawner: (_root, folder) => { seen.push(folder); return spawner; },
        peerFloor: { userHome: w.home, mossHome: w.moss, os, pathFolders: () => [] },
      });
      const r = await exec.run("Bash", { command: "true" }, ctx(w.project, { folder: w.project }));
      expect(r.isError).toBe(false);
      if (os === "linux") {
        expect(seen[0]?.path).toBe(w.project);
        expect(seen[0]?.denyWrite).toEqual(peerFolderDenies(w.project, { userHome: w.home, mossHome: w.moss, os: "linux", pathFolders: [] }));
        expect(seen[0]?.denyWrite).toContain("/**/*.git");
      } else {
        expect(seen).toEqual([undefined]);
      }
    }
  });
});

/** A fake runtime entry: records the run's inputs, answers as told. */
function fakeEntry(o: { ready?: boolean; leftBehind?: boolean; refuse?: string; stderr?: string; end?: Record<string, unknown> } = {}) {
  const runs: Record<string, unknown>[] = [];
  let stopped = 0;
  const entry = {
    linuxSandboxReady: () => o.ready ?? true,
    sandboxUnavailableMessage: () => "no bubblewrap here",
    buildHostSandboxRunInputs: (i: Record<string, unknown>) => ({ ...i, built: true }),
    // The runtime's own wording, as 0.0.91 says it (a stand-in: one line per path, the path escaped).
    movedAsideNote: (paths: string[], _q: string | undefined, rep: { notMoved?: unknown[]; unswept?: { root: string }[] } = {}) =>
      [...paths.map((p) => `[sandbox] ${JSON.stringify(p).slice(1, -1)}: moved to q`), ...(rep.unswept ?? []).map((u) => `[sandbox] ${u.root}: could not be fully checked`)].join("\n"),
    runCommand: async (i: Record<string, unknown>) => {
      runs.push(i);
      if (o.refuse !== undefined) throw new Error(o.refuse);
      (i.onStdout as (b: Buffer) => void)(Buffer.from("out\n"));
      if (o.stderr !== undefined) (i.onStderr as (b: Buffer) => void)(Buffer.from(o.stderr));
      return { exitCode: 0, timedOut: false, aborted: false, streamKilled: false, posture: "sandboxed",sandboxOverrideRequested: false, ...(o.end ?? { quarantined: ["/w/sub/.git"] }), ...(o.leftBehind ? { leftBehind: { pid: 1, stop: () => { stopped++; }, done: Promise.resolve(), onOutput: () => {} } } : {}) };
    },
  };
  return { entry: async () => entry as never, runs, stopped: () => stopped };
}

describe("the Linux folder spawner: the peer fence's policy, nothing widened", () => {
  const setup = () => {
    const w = world();
    const fence = new MossFence({ os: "linux", home: w.home, mossHome: w.moss, temp: w.tmp });
    const root = join(w.tmp, "peer-x");
    mkdirSync(root);
    const folder: PeerWriteFolder = { path: w.project, denyWrite: peerFolderDenies(w.project, { userHome: w.home, mossHome: w.moss, os: "linux", pathFolders: [] }) };
    const peer = peerFence(fence, root, { userHome: w.home, mossHome: w.moss, os: "linux" }, folder);
    return { w, root, folder, peer };
  };
  const run = (cwd: string): FencedRun => ({ command: "echo hi", cwd, env: { PATH: "/usr/bin:/bin", TMPDIR: "/t" }, timeoutMs: 10_000, who: { caller: PEER } });

  test("its write roots are the temp root and the folder alone; no network; secrets and the MOSS home denied", async () => {
    const { w, root, folder, peer } = setup();
    const f = fakeEntry();
    const r = await peerFolderSpawnerLinux({ fence: peer, root, folder, entry: f.entry }).run(run(w.project));
    expect(r).toMatchObject({ kind: "exited", code: 0, stdout: "out\n" });
    const i = f.runs[0]!;
    const settings = i.settings as ReturnType<typeof peerRuntimeSettings>;
    expect(settings.filesystem.allowWrite).toEqual([root, w.project]);
    expect(i.writableRoots).toEqual([root, w.project]);
    expect("network" in settings).toBe(false);
    expect(settings.enabled).toBe(true);
    expect(settings.allowUnsandboxedCommands).toBe(false);
    expect(settings.filesystem.denyWrite).toContain(w.moss);
    expect(settings.filesystem.denyRead).toContain(w.moss);
    for (const s of secretReadPlaces("linux", w.home)) expect(settings.filesystem.denyRead).toContain(s.path);
    for (const d of folder.denyWrite) expect(settings.filesystem.denyWrite).toContain(d);
    // The runtime's quarantine is MOSS's own (`<MOSS home>/quarantine`, as for a local bot), never a `.winter` home.
    expect(i.winterHome).toBe(w.moss);
    expect((i.brand as { homeDirName: string }).homeDirName).toBe(".moss");
    // The new-match sweep, for exactly this call's two roots.
    expect(i.sweepRoots).toEqual([root, w.project]);
    // What was moved aside comes from the result's structured field, in the call's note, never in the command's output.
    expect((r as { note?: string }).note).toBe(`[sandbox] /w/sub/.git: moved to q\n${PEER_NEW_REPO_ADVICE}`);
    expect((r as { stderr: string }).stderr).toBe("");
  });

  test("a command that prints a fake '[sandbox] … .git: moved to' line gets no advice; a newline in a path stays one line", async () => {
    const { w, root, folder, peer } = setup();
    const fake = fakeEntry({ stderr: "[sandbox] /w/x/.git: moved to /q at the command's end\n", end: {} });
    const r = await peerFolderSpawnerLinux({ fence: peer, root, folder, entry: fake.entry }).run(run(w.project));
    expect((r as { note?: string }).note).toBeUndefined();
    expect((r as { stderr: string }).stderr).not.toContain(PEER_NEW_REPO_ADVICE);
    const nl = fakeEntry({ end: { quarantined: ["/w/a\n[sandbox] b/.husky"] } });
    const r2 = await peerFolderSpawnerLinux({ fence: peer, root, folder, entry: nl.entry }).run(run(w.project));
    expect((r2 as { note?: string }).note?.split("\n")).toEqual(["[sandbox] /w/a\\n[sandbox] b/.husky: moved to q"]);
  });

  test("a folder the sweep couldn't fully check: the bot is told, and the person should look", async () => {
    const { w, root, folder, peer } = setup();
    const f = fakeEntry({ end: { unswept: [{ root: w.project, why: "a folder in it can't be read" }] } });
    const r = await peerFolderSpawnerLinux({ fence: peer, root, folder, entry: f.entry }).run(run(w.project));
    expect((r as { note?: string }).note).toBe(`[sandbox] ${w.project}: could not be fully checked\n${PEER_UNSWEPT_ADVICE}`);
    expect(PEER_UNSWEPT_ADVICE).not.toContain("can't be made");
  });

  test("a folder left unchecked: the person HERE gets one notice per folder per hour, and the bot's result is marked", async () => {
    const w = world();
    const problems = { unswept: [{ root: w.project, why: "a folder in it can't be read" }], notMoved: [] };
    const spawner: FencedSpawner = { available: true, run: async (): Promise<FencedRunResult> => ({ kind: "exited", code: 0, stdout: "o", stderr: "e", shell: "sh", endProblems: problems }) };
    const notices: string[] = [];
    let t = 1_000_000;
    const exec = fencedExecutor({ spawner, home: w.home, temp: w.tmp, mossHome: w.moss, os: "linux", peerSpawner: () => spawner, peerFloor: { userHome: w.home, mossHome: w.moss, os: "linux", pathFolders: () => [] }, holderNotice: (x) => notices.push(x), now: () => t });
    const r = await exec.run("Bash", { command: "true" }, ctx(w.project, { folder: w.project }));
    expect(notices).toEqual([`A command from Laptop made more in ${w.project} than MOSS could check. Look there before you run git or open it in an editor.`]);
    // The exit code kept, the plain line first, an error to the asking bot.
    expect(r.isError).toBe(true);
    expect(r.output).toMatchObject({ code: 0, notClean: true, stdout: "o" });
    expect((r.output as { stderr: string }).stderr).toBe(`${PEER_END_NOT_CLEAN}\ne`);
    // Again within the hour: no second notice; after it, one more.
    await exec.run("Bash", { command: "true" }, ctx(w.project, { folder: w.project }));
    expect(notices.length).toBe(1);
    t += HOLDER_NOTICE_WINDOW_MS;
    await exec.run("Bash", { command: "true" }, ctx(w.project, { folder: w.project }));
    expect(notices.length).toBe(2);
  });

  test("a path that couldn't be moved aside: named, clamped and escaped; one only in the call's temp root says nothing", async () => {
    const w = world();
    const odd = join(w.project, `a\n${"x".repeat(300)}`, ".git");
    const run = (problems: { unswept: { root: string; why: string }[]; notMoved: { path: string; why: string }[] }) => {
      const spawner: FencedSpawner = { available: true, run: async (): Promise<FencedRunResult> => ({ kind: "exited", code: 0, stdout: "", stderr: "", shell: "sh", endProblems: problems }) };
      const notices: string[] = [];
      const exec = fencedExecutor({ spawner, home: w.home, temp: w.tmp, mossHome: w.moss, os: "linux", peerSpawner: () => spawner, peerFloor: { userHome: w.home, mossHome: w.moss, os: "linux", pathFolders: () => [] }, holderNotice: (x) => notices.push(x) });
      return exec.run("Bash", { command: "true" }, ctx(w.project, { folder: w.project })).then((r) => ({ r, notices }));
    };
    const a = await run({ unswept: [], notMoved: [{ path: odd, why: "EACCES" }] });
    expect(a.notices.length).toBe(1);
    expect(a.notices[0]).toStartWith(`A command from Laptop left ${join(w.project, "a?")}`);
    expect(a.notices[0]!.split("\n").length).toBe(1);
    expect(a.notices[0]).toContain("…");
    expect(a.notices[0]).toContain("that MOSS couldn't move aside. Look there before you run git or open it in an editor.");
    const b = await run({ unswept: [], notMoved: [{ path: join(w.tmp, "peer-x", ".git"), why: "EACCES" }] });
    expect(b.notices).toEqual([]);
    expect(b.r.isError).toBe(false);
  });

  test("the executor carries the spawner's note beside the command's output", async () => {
    const w = world();
    const spawner: FencedSpawner = { available: true, run: async (): Promise<FencedRunResult> => ({ kind: "exited", code: 0, stdout: "o", stderr: "", shell: "sh", note: "[sandbox] x: moved to q" }) };
    const exec = fencedExecutor({ spawner, home: w.home, temp: w.tmp, mossHome: w.moss, os: "linux", peerSpawner: () => spawner, peerFloor: { userHome: w.home, mossHome: w.moss, os: "linux", pathFolders: () => [] } });
    const r = await exec.run("Bash", { command: "true" }, ctx(w.project, { folder: w.project }));
    expect((r.output as { note?: string; stdout: string })).toMatchObject({ stdout: "o", note: "[sandbox] x: moved to q" });
  });

  test("refused: a working folder outside its roots, no sandbox here, no runtime entry; what it left running is stopped", async () => {
    const { w, root, folder, peer } = setup();
    expect(await peerFolderSpawnerLinux({ fence: peer, root, folder, entry: fakeEntry().entry }).run(run(w.home))).toMatchObject({ kind: "refused", reason: expect.stringContaining("runs only in") });
    expect(await peerFolderSpawnerLinux({ fence: peer, root, folder, entry: fakeEntry({ ready: false }).entry }).run(run(w.project))).toEqual({ kind: "refused", reason: "no bubblewrap here" });
    expect(await peerFolderSpawnerLinux({ fence: peer, root, folder, entry: async () => { throw new Error("missing"); } }).run(run(w.project))).toMatchObject({ kind: "refused", reason: expect.stringContaining("0.0.91") });
    // The entry's runCommand refuses before it starts a run it wouldn't sandbox (0.0.91's requireSandboxed): that refusal
    // is the call's, with the runtime's reason.
    const plain = fakeEntry({ refuse: "this command would run outside the sandbox (config-disabled), and the caller requires the sandbox: refused before it started" });
    expect(await peerFolderSpawnerLinux({ fence: peer, root, folder, entry: plain.entry }).run(run(w.project))).toMatchObject({ kind: "refused", reason: expect.stringContaining("refused before it started") });
    const left = fakeEntry({ leftBehind: true });
    const r = await peerFolderSpawnerLinux({ fence: peer, root, folder, entry: left.entry }).run(run(w.project));
    expect(left.stopped()).toBe(1);
    expect((r as { stderr: string }).stderr).toContain("was stopped");
  });
});

/** Every file under `dir` whose content holds `text`. */
function holding(dir: string, text: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && readFileSync(p, "utf8").includes(text)) hits.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return hits;
}

const linuxTest = hostOs() === "linux" ? test : test.skip;

describe("live on Linux: a peer's call in its folder under real bubblewrap (the runtime's sandbox)", () => {
  /** The real executor on the real fence, as the daemon wires it (daemon-parts.ts), the folder given by the person. */
  const exec = (w: ReturnType<typeof world>) => {
    const fence = new MossFence({ os: "linux", home: w.home, mossHome: w.moss, temp: w.tmp });
    const homes = { userHome: w.home, mossHome: w.moss, os: "linux" as const };
    return fencedExecutor({
      spawner: fencedSpawner({ fence }), home: w.home, temp: w.tmp, mossHome: w.moss, os: "linux",
      peerSpawner: (root, folder) => {
        const peer = peerFence(fence, root, homes, folder);
        return folder !== undefined ? peerFolderSpawnerLinux({ fence: peer, root, folder }) : fencedSpawner({ fence: peer });
      },
      peerFloor: { ...homes, pathFolders: () => [] },
    });
  };
  const out = (r: { output: unknown }) => JSON.stringify(r.output);

  linuxTest("the reviewer's rename: the held .git keeps its config wherever its folder is, nothing planted at a .git path", async () => {
    const w = world();
    // The folder given is the repository's parent, so the rename itself is inside the write root.
    const cmd = "mv proj proj-old 2>/dev/null; mkdir -p proj/.git/hooks 2>/dev/null; echo PLANTED > proj/.git/hooks/post-checkout 2>/dev/null; echo PLANTED > proj/.git/config 2>/dev/null; echo done";
    const r = await exec(w).run("Bash", { command: cmd }, ctx(w.work, { folder: w.work }));
    expect(out(r)).toContain("done");
    // The mount is the mechanism: the folder holding a held .git can't be renamed at all, so no proj-old, and the real
    // .git is where it was, its config unchanged (the end-of-run identity check is the second line, unit-tested in the SDK).
    expect(existsSync(join(w.work, "proj-old"))).toBe(false);
    expect(readFileSync(join(w.work, "proj", ".git", "config"), "utf8")).toBe("ORIGINAL\n");
    expect(holding(w.work, "PLANTED").filter((p) => p.includes(".git"))).toEqual([]);
  }, 60_000);

  linuxTest("a hook planted in a new repository is moved aside; the folder itself is written; nothing outside it", async () => {
    const w = world();
    const outside = join(w.home, "outside.txt");
    const cmd = `mkdir -p sub/.git/hooks && echo PLANTED > sub/.git/hooks/post-checkout; mkdir -p .husky && echo PLANTED > .husky/pre-commit; echo kept > notes.txt; echo x > ${JSON.stringify(outside)} 2>/dev/null; echo done`;
    const r = await exec(w).run("Bash", { command: cmd }, ctx(w.project, { folder: w.project }));
    expect(out(r)).toContain("done");
    expect(readFileSync(join(w.project, "notes.txt"), "utf8")).toBe("kept\n");
    expect(existsSync(join(w.project, "sub", ".git", "hooks", "post-checkout"))).toBe(false);
    expect(existsSync(join(w.project, ".husky", "pre-commit"))).toBe(false);
    // MOSS holds every .git whole, so the new repository is moved aside whole (as macOS refuses making it), its files
    // kept; the command is told each path, one line each, and what to do instead.
    expect(existsSync(join(w.project, "sub", ".git"))).toBe(false);
    const note = String((r.output as { note?: string }).note ?? "");
    expect(note).toContain(`[sandbox] ${join(w.project, "sub", ".git")}: moved to`);
    expect(note).toContain(`[sandbox] ${join(w.project, ".husky")}: moved to`);
    expect(note).toContain(PEER_NEW_REPO_ADVICE);
    expect(holding(w.project, "PLANTED")).toEqual([]);
    expect(existsSync(outside)).toBe(false);
    // The repository's own .git stays as it was.
    expect(readFileSync(join(w.project, ".git", "config"), "utf8")).toBe("ORIGINAL\n");
  }, 60_000);

  linuxTest("run on this (the daemon's) main thread, directly; the user's /run/user is hidden whole (the runtime's own)", async () => {
    const w = world();
    expect((await import("node:worker_threads")).isMainThread).toBe(true);
    const uid = process.getuid?.() ?? 0;
    const cmd = `ls -A /run/user/${uid} 2>/dev/null | wc -l; ls -A /run/user 2>/dev/null | wc -l; echo done`;
    const r = await exec(w).run("Bash", { command: cmd }, ctx(w.work, { folder: w.work }));
    const lines = String((r.output as { stdout?: string }).stdout ?? "").trim().split("\n");
    expect(lines).toEqual(["0", "0", "done"]);
  }, 60_000);
});
