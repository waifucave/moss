// Lane XC, step 3b: a peer's approved command writes the folder it runs in, never more than a bot running here would
// (the controller's rulings (A)–(D)): the folder by the holder reviewer's "safe" where the level's own shell roots
// cover it, or by the person's yes (macOS, a one-call RequestAccess grant); a read-only command asks nothing at ask for
// risky actions; fully automatic never raises a card; inside the folder, exactly the local bot sandbox's denies.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller, Level, Os } from "@waifucave/moss-protocol";
import { createHash } from "node:crypto";
import { callCardRenderer } from "../../src/computers/call-cards";
import { fencedExecutor } from "../../src/computers/fenced-executor";
import { MossFence } from "../../src/fence/fence";
import { fencedSpawner } from "../../src/fence/fenced-process";
import { filterOf } from "../../src/fence/macos-profile";
import {
  peerFence, peerFolderDenies, peerFolderFor, peerFolderRefusal,
  type PeerFolderOptions, type PeerPassBy,
} from "../../src/fence/peer-floor";
import { treeResultText } from "../../src/runtime-sdk/turn-loop/driver";
import type { PeerReviewer } from "../../src/tree/judge";
import type { ToolExecutor, ToolRunContext } from "../../src/tree/service";
import { hostOs } from "../../src/tree/names";
import { darwinDescribe } from "../helpers/darwin-only";
import { answersFor, makePhone } from "../tree/answer-support";
import { Cluster } from "../tree/cluster-support";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
function temp(prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
}

const PEER: Caller = { kind: "peer", device: "dev_alpha", sessionId: "b_luna" };

/** A home with a project (a repo in it), a Documents folder and the secret and run-later places. */
function world() {
  const root = temp("xc-peer-write-");
  const home = join(root, "home");
  const moss = join(home, ".moss");
  const tmp = join(root, "tmp");
  const project = join(home, "Projects", "app");
  for (const d of [moss, join(project, ".git", "hooks"), join(home, "Documents"), join(home, ".ssh"), join(home, "Library"), tmp]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, ".zshrc"), "ORIGINAL-RC\n");
  writeFileSync(join(project, ".git", "config"), "ORIGINAL-GIT\n");
  writeFileSync(join(home, ".ssh", "id_ed25519"), "KEY-SECRET\n");
  writeFileSync(join(project, "notes.md"), "notes\n");
  return { root, home, moss, tmp, project };
}

const floorOf = (w: ReturnType<typeof world>, os: Os): PeerFolderOptions => ({ userHome: w.home, mossHome: w.moss, os, pathFolders: [] });
const decide = (w: ReturnType<typeof world>, os: Os, by: PeerPassBy, level: Level, extra: { folder?: string; readOnly?: boolean; verdict?: "safe" | "risky" | "unavailable" } = {}) =>
  peerFolderFor({ holder: "Beta", folder: extra.folder ?? w.project, by, level, readOnly: extra.readOnly ?? false, ...(extra.verdict ? { verdict: extra.verdict } : {}) }, floorOf(w, os));

describe("which folder a peer's command gets (peerFolderFor: the local rule, mirrored)", () => {
  test("the person's yes: the folder on macOS; never on Linux or Windows", () => {
    const w = world();
    expect(decide(w, "macos", "answer", "ask")).toEqual({ folder: w.project });
    expect(decide(w, "macos", "answer", "ask-risky")).toEqual({ folder: w.project });
    expect(decide(w, "linux", "answer", "ask-risky")).toEqual({ why: expect.stringContaining("On Linux") });
    expect(decide(w, "windows", "answer", "ask")).toEqual({ why: expect.stringContaining("Windows") });
  });

  test("the reviewer's safe at ask for risky actions: the card for the folder on macOS (the peer's RequestAccess)", () => {
    const w = world();
    expect(decide(w, "macos", "reviewer", "ask-risky")).toEqual({ ask: expect.stringContaining(w.project) });
  });

  test("the reviewer's safe at accept edits: the folder where an ordinary top-level folder covers it, else the card", () => {
    const w = world();
    expect(decide(w, "macos", "reviewer", "accept-edits")).toEqual({ folder: w.project });
    // A folder outside the home: no level's roots cover it.
    const outside = temp("xc-outside-");
    expect(decide(w, "macos", "reviewer", "accept-edits", { folder: outside })).toEqual({ why: expect.stringContaining("sensitive") });
  });

  test("fully automatic: never a card; the folder only on the reviewer's safe; the reason in the result otherwise", () => {
    const w = world();
    expect(decide(w, "macos", "level", "automatic", { verdict: "safe" })).toEqual({ folder: w.project });
    const unavailable = decide(w, "macos", "level", "automatic", { verdict: "unavailable" });
    expect(unavailable).toEqual({ why: `Beta's reviewer couldn't judge this command, so it ran without access to ${w.project}; at an asking level Beta would ask the person` });
    expect(decide(w, "macos", "level", "automatic", { verdict: "risky" })).toEqual({ why: expect.stringContaining("judged this command risky") });
    expect(decide(w, "macos", "level", "automatic")).toEqual({ why: expect.stringContaining("risky") });
    for (const os of ["macos", "linux", "windows"] as const) {
      for (const verdict of ["safe", "risky", "unavailable"] as const) expect("ask" in decide(w, os, "level", "automatic", { verdict })).toBe(false);
    }
  });

  test("a home reached through a link (macOS's /var): the executor judges by real paths, so its folders are in the home", () => {
    const w = world();
    const linked = join(w.root, "linked-home");
    symlinkSync(w.home, linked);
    const e = fencedExecutor({
      spawner: { run: async () => ({ kind: "refused", reason: "unused" }) } as unknown as Parameters<typeof fencedExecutor>[0]["spawner"],
      home: linked, temp: w.tmp, mossHome: join(linked, ".moss"), os: "macos",
      peerFloor: { userHome: linked, mossHome: join(linked, ".moss"), os: "macos", pathFolders: () => [] },
    });
    expect(e.peerFolder?.({ holder: "Beta", folder: w.project, by: "level", level: "automatic", readOnly: false, verdict: "safe" })).toEqual({ folder: w.project });
    expect(e.peerFolder?.({ holder: "Beta", folder: w.home, by: "answer", level: "ask", readOnly: false })).toEqual({ why: expect.stringContaining("never writes there") });
  });

  test("runs that write a folder wait per folder: one in another folder runs meanwhile; temp-only runs never wait", async () => {
    const w = world();
    const other = join(w.home, "Documents");
    const inner = join(w.project, "src");
    mkdirSync(inner);
    const started: string[] = [];
    const gates = new Map<string, () => void>();
    const spawner = (label: string) => ({
      available: true,
      run: async () => { started.push(label); await new Promise<void>((r) => gates.set(label, r)); return { kind: "exit", code: 0, stdout: "", stderr: "" }; },
    }) as unknown as Parameters<typeof fencedExecutor>[0]["spawner"];
    let n = 0;
    const e = fencedExecutor({
      spawner: spawner("local"), home: w.home, temp: w.tmp, mossHome: w.moss, os: "macos",
      peerSpawner: () => spawner(`run${++n}`),
      peerFloor: { userHome: w.home, mossHome: w.moss, os: "macos", pathFolders: () => [] },
    });
    const go = (cwd: string, write: ToolRunContext["write"]) => e.run("Bash", { command: "make" }, { as: PEER, session: "s", callId: `c${cwd}`, cwd, treeCwd: "x", signal: new AbortController().signal, output: () => {}, ...(write ? { write } : {}) });
    const tick = () => new Promise((r) => setTimeout(r, 30));
    const a = go(w.project, { folder: w.project });
    await tick();
    const b = go(other, { folder: other });
    const a2 = go(w.project, { folder: w.project });
    const nested = go(inner, { folder: inner });
    const t = go(w.project, { why: "temp-only" });
    await tick();
    // run1 (project) and run2 (Documents) and the temp-only one run; the second in project and the nested one wait.
    expect(started.sort()).toEqual(["run1", "run2", "run3"].sort());
    gates.get("run1")!();
    await a;
    await tick();
    expect(started.length).toBe(4);
    for (const g of [...gates.values()]) g();
    await tick();
    for (const g of [...gates.values()]) g();
    await tick();
    for (const g of [...gates.values()]) g();
    await Promise.all([b, a2, nested, t]);
    expect(started.length).toBe(5);
  });

  test("the holder's reason reaches the bot's text, on a result and on a refusal", () => {
    expect(treeResultText("Bash", { stdout: "", stderr: "sh: out.txt: Operation not permitted\n", code: 1, note: "no access, because" }))
      .toBe("sh: out.txt: Operation not permitted\nExit code 1\n(no access, because)");
    expect(treeResultText("Bash", { error: "refused: x", note: "why" })).toBe("Error: refused: x\n(why)");
    expect(treeResultText("Bash", { stdout: "fine\n", stderr: "", code: 0 })).toBe("fine");
  });

  test("a read-only command gets no folder and says nothing", () => {
    const w = world();
    expect(decide(w, "macos", "read-only", "ask-risky")).toEqual({});
    expect(decide(w, "macos", "level", "automatic", { readOnly: true })).toEqual({});
  });

  test("never given, whatever passed it: the home, its Library, a .git, a dot-folder, the MOSS home's holder, secrets, glob names, outside", () => {
    const w = world();
    const never = [
      w.home, join(w.home, "Library"), join(w.project, ".git"), join(w.project, ".git", "hooks"), join(w.home, ".ssh"),
      w.moss, join(w.home, "Projects", "x[ab]"), join(w.home, "Projects", "a*b"), "/", w.root,
      // Spellings that stand for another folder than they read as: refused, never mended.
      `${w.home}/Projects/..`, `${w.project}/../../.ssh`, `${w.home}/./Projects/app`, `${w.home}//Projects/app`, `${w.project}/`,
      "Projects/app",
    ];
    for (const f of never) {
      expect([f, peerFolderRefusal(f, floorOf(w, "macos")) !== undefined]).toEqual([f, true]);
      expect([f, decide(w, "macos", "answer", "ask", { folder: f })]).toEqual([f, { why: expect.stringContaining("never writes there") }]);
      expect([f, decide(w, "macos", "level", "automatic", { folder: f, verdict: "safe" })]).toEqual([f, { why: expect.stringContaining("never writes there") }]);
    }
    // A folder on the PATH, or one holding one at its top.
    const bin = join(w.home, "Projects", "tools");
    mkdirSync(join(bin, "bin"), { recursive: true });
    expect(peerFolderRefusal(join(bin, "bin"), { ...floorOf(w, "macos"), pathFolders: [join(bin, "bin")] })).toBeDefined();
    expect(peerFolderRefusal(bin, { ...floorOf(w, "macos"), pathFolders: [join(bin, "bin")] })).toBeDefined();
    expect(peerFolderRefusal(w.project, floorOf(w, "macos"))).toBeUndefined();
    expect(peerFolderRefusal(join(w.home, "Documents"), floorOf(w, "macos"))).toBeUndefined();
  });
});

describe("the denies inside the folder: the local bot sandbox's own", () => {
  test("macOS: `**` globs from `/` for every .git and run-later name, as Seatbelt regexes", () => {
    const w = world();
    const d = peerFolderDenies(w.project, floorOf(w, "macos"));
    expect(d).toContain("/**/*.[gG][iI][tT]");
    expect(d.some((x) => x.endsWith("/**/.[vV][sS][cC][oO][dD][eE]"))).toBe(true);
    expect(d).toContain(`${w.project}/**/.[mM][oO][sS][sS]`);
    expect(d).toContain(join(w.home, ".ssh"));
    expect(filterOf("/**/*.[gG][iI][tT]")).toBe(String.raw`(regex #"^/(.*/)?[^/]*\.[gG][iI][tT](/|$)")`);
    expect(filterOf(`/a b/**/x.y`)).toBe(String.raw`(regex #"^/a b/(.*/)?x\.y(/|$)")`);
    // The fence's own one-segment globs read as before.
    expect(filterOf("/h/*.json")).toBe(String.raw`(regex #"^/h/[^/]*\.json(/|$)")`);
    const re = new RegExp(filterOf("/**/*.[gG][iI][tT]").slice(9, -2));
    for (const p of ["/x/.git", "/x/a/b/.GIT/hooks/pre-commit", "/x/bare.git", "/.git"]) expect([p, re.test(p)]).toEqual([p, true]);
    for (const p of ["/x/.gitignore", "/x/agit2/y", "/x/digit"]) expect([p, re.test(p)]).toEqual([p, false]);
  });

  test("Linux and Windows: no folder for a peer's command, whatever let it through; the executor refuses one there too", async () => {
    const w = world();
    for (const os of ["linux", "windows"] as const) {
      for (const [by, level, verdict] of [["answer", "ask"], ["answer", "accept-edits"], ["reviewer", "accept-edits"], ["reviewer", "ask-risky"], ["level", "automatic", "safe"]] as const) {
        const d = decide(w, os, by, level, verdict === undefined ? {} : { verdict });
        expect([os, by, level, "why" in d]).toEqual([os, by, level, true]);
      }
    }
    expect(decide(w, "linux", "answer", "ask")).toEqual({ why: expect.stringContaining("against a rename") });
    // A service that handed a folder anyway on a Linux holder: the executor's own gate gives none, with the reason.
    let given: unknown = "unset";
    const e = fencedExecutor({
      spawner: { run: async () => ({ kind: "exit", code: 0, stdout: "", stderr: "" }) } as unknown as Parameters<typeof fencedExecutor>[0]["spawner"],
      home: w.home, temp: w.tmp, mossHome: w.moss, os: "linux",
      peerSpawner: (_root, folder) => { given = folder; return { run: async () => ({ kind: "exit", code: 0, stdout: "", stderr: "" }) } as unknown as Parameters<typeof fencedExecutor>[0]["spawner"]; },
      peerFloor: { userHome: w.home, mossHome: w.moss, os: "linux", pathFolders: () => [] },
    });
    const r = await e.run("Bash", { command: "make" }, { as: PEER, session: "s", callId: "c", cwd: w.project, treeCwd: "x", signal: new AbortController().signal, output: () => {}, write: { folder: w.project } });
    expect(given).toBeUndefined();
    expect((r.output as { note?: string }).note).toContain("no folder");
  });

  test("peerFence with a folder: two write roots, the folder's denies after the fence's own", () => {
    const w = world();
    const fence = new MossFence({ os: hostOs(), home: w.home, mossHome: w.moss, temp: w.tmp });
    const v = peerFence(fence, "/x/peer-root", { userHome: w.home, mossHome: w.moss, os: hostOs() }, { path: w.project, denyWrite: ["/**/*.[gG][iI][tT]"] });
    expect(v.policy().allowWrite).toEqual(["/x/peer-root", w.project]);
    expect(v.policy().denyWrite).toEqual(expect.arrayContaining([...fence.policy().denyWrite, "/**/*.[gG][iI][tT]"]));
  });
});

let cluster: Cluster | undefined;
afterEach(() => { cluster?.close(); cluster = undefined; });

/** Studio's bot runs commands on Beta, whose executor records what each one's folder got (and runs nothing). */
async function pair(o: { level: Level; reviewer?: PeerReviewer; deny?: boolean }) {
  const phone = await makePhone();
  if (o.deny) phone.deny = true;
  cluster = new Cluster();
  const got: (ToolRunContext["write"] | "none")[] = [];
  const reviewed: string[] = [];
  const reviewer: PeerReviewer | undefined = o.reviewer && (async (c) => { reviewed.push(JSON.stringify(c.params)); return o.reviewer!(c); });
  const studio = await cluster.add("Studio", { answers: () => answersFor(phone), askUser: () => phone.ask });
  const beta = await cluster.add("Beta", {
    answers: () => answersFor(phone), askUser: () => phone.ask, ...(reviewer ? { reviewer: () => reviewer } : {}),
    executor: (_name, home) => {
      const floor: PeerFolderOptions = { userHome: home, mossHome: join(home, ".moss"), os: "macos", pathFolders: [] };
      const e: ToolExecutor = {
        async run(_tool, _input, ctx) { got.push(ctx.write ?? "none"); return { output: { stdout: "", stderr: "", code: 0 }, isError: false }; },
        peerFolder: (x) => peerFolderFor(x, floor),
      };
      return e;
    },
  });
  await cluster.get("Beta").node.registry.setLevel("Beta", o.level, { via: "terminal" });
  await cluster.join();
  mkdirSync(join(beta.home, "Projects", "app"), { recursive: true });
  const project = realpathSync.native(join(beta.home, "Projects", "app"));
  const ctx = { session: "s_alpha", sessionKind: "bot" as const, cwd: "home/Studio" };
  let n = 0;
  const run = (command: string) => studio.node.tools.run("Bash", { command: `cd home/Beta/Projects/app && ${command}` }, { ...ctx, callId: `c${++n}` });
  return { phone, got, reviewed, run, project };
}

describe("on the tree service: the read-only rule, the card for the folder, automatic without cards", () => {
  test("ask for risky actions: ls, cat and git status ask nothing and get no folder; npm install raises Beta's card, and its yes gives the folder", async () => {
    if (process.platform === "win32") return;
    const { phone, got, reviewed, run, project } = await pair({ level: "ask-risky", reviewer: async () => "safe" });
    for (const c of ["ls", "cat notes.md", "git status"]) expect((await run(c)).isError).toBe(false);
    expect(phone.shown).toEqual([]);
    expect(reviewed).toEqual([]);
    expect(got).toEqual([{}, {}, {}]);
    const install = await run("npm install");
    expect(install.isError).toBe(false);
    expect(phone.shown.map((s) => [s.computer, s.method])).toEqual([["Beta", "tool.run"]]);
    expect(got.at(-1)).toEqual({ folder: project });
  });

  test("a read-only command asks nothing at every level, ask and read-only included, as a bot's does here", async () => {
    if (process.platform === "win32") return;
    for (const level of ["ask", "read-only", "accept-edits", "automatic"] as const) {
      const { phone, got, reviewed, run } = await pair({ level, reviewer: async () => "risky" });
      for (const c of ["ls", "cat notes.md", "git status"]) expect([level, c, (await run(c)).isError]).toEqual([level, c, false]);
      expect([level, phone.shown]).toEqual([level, []]);
      expect([level, reviewed]).toEqual([level, []]);
      expect([level, got]).toEqual([level, [{}, {}, {}]]);
      cluster?.close();
      cluster = undefined;
    }
  });

  test("the card for a command says what a yes does now", () => {
    const render = callCardRenderer((t) => createHash("sha256").update(t).digest("hex"));
    const card = render({ computer: "Beta", method: "tool.run", params: { tool: "Bash", input: { command: "npm install", cwd: "home/Beta/Projects/app" } } });
    expect(JSON.stringify(card?.fields.what)).toContain("Run this command? It can change files in the folder below, but never its .git or settings that run later.");
  });

  test("ask for risky actions: the person's no to the folder's card runs nothing", async () => {
    if (process.platform === "win32") return;
    const { phone, got, run } = await pair({ level: "ask-risky", reviewer: async () => "safe", deny: true });
    const r = await run("echo hi > out.txt").then((x) => x, (e: unknown) => e);
    expect(phone.shown.map((s) => s.method)).toEqual(["tool.run"]);
    expect(got).toEqual([]);
    expect(r).toBeDefined();
  });

  test("fully automatic: a safe command writes the folder; a risky or unjudged one runs temp-only with the reason; no card ever", async () => {
    if (process.platform === "win32") return;
    const verdicts: Record<string, "safe" | "risky" | "unavailable"> = { "echo ok > a.txt": "safe", "rm -rf build": "risky", "make": "unavailable" };
    const { phone, got, reviewed, run, project } = await pair({
      level: "automatic",
      reviewer: async (c) => verdicts[(c.params as { input: { command: string } }).input.command] ?? "unavailable",
    });
    for (const c of Object.keys(verdicts)) expect((await run(c)).isError).toBe(false);
    expect(phone.shown).toEqual([]);
    expect(reviewed.length).toBe(3);
    expect(got[0]).toEqual({ folder: project });
    expect(got[1]).toEqual({ why: expect.stringContaining("judged this command risky") });
    expect(got[2]).toEqual({ why: `Beta's reviewer couldn't judge this command, so it ran without access to ${project}; at an asking level Beta would ask the person` });
  });

  test("fully automatic with no reviewer at all: unjudged, temp-only, no card", async () => {
    if (process.platform === "win32") return;
    const { phone, got, run } = await pair({ level: "automatic" });
    await run("echo hi > out.txt");
    expect(phone.shown).toEqual([]);
    expect(got).toEqual([{ why: expect.stringContaining("couldn't judge") }]);
  });
});

darwinDescribe("a peer's command writing its folder on the real fenced process (Seatbelt)", () => {
  function exec(w: ReturnType<typeof world>) {
    const fence = new MossFence({ os: hostOs(), home: w.home, mossHome: w.moss, temp: w.tmp });
    const homes = { userHome: w.home, mossHome: w.moss, os: hostOs() };
    return fencedExecutor({
      spawner: fencedSpawner({ fence }), home: w.home, temp: w.tmp, mossHome: w.moss, os: hostOs(),
      peerSpawner: (root, folder) => fencedSpawner({ fence: peerFence(fence, root, homes, folder) }),
      peerFloor: { ...homes, pathFolders: () => [] },
    });
  }
  const ctxOf = (cwd: string, write: ToolRunContext["write"]): ToolRunContext => ({ as: PEER, session: "b_luna", callId: "c1", cwd, treeCwd: "home/Beta/Projects/app", signal: new AbortController().signal, output: () => {}, ...(write ? { write } : {}) });

  test("writes ordinary files there; never a .git at any depth or case, a run-later name, an app, outside, or through a link", async () => {
    const w = world();
    const e = exec(w);
    const run = async (command: string) => e.run("Bash", { command }, ctxOf(w.project, { folder: w.project }));
    const ok = await run("echo built > out.txt && mkdir -p src/deep && echo x > src/deep/y.txt");
    expect(ok.isError).toBe(false);
    expect(readFileSync(join(w.project, "out.txt"), "utf8")).toBe("built\n");
    expect(readFileSync(join(w.project, "src", "deep", "y.txt"), "utf8")).toBe("x\n");
    symlinkSync(join(w.home, ".zshrc"), join(w.project, "rc-link"));
    const refused: [string, string][] = [
      ["echo planted >> .git/config", join(w.project, ".git", "config")],
      ["echo planted > .git/hooks/pre-commit", join(w.project, ".git", "hooks", "pre-commit")],
      ["mkdir -p sub/.git/hooks && echo x > sub/.git/hooks/post-checkout", join(w.project, "sub", ".git")],
      ["mkdir -p a/b/.GIT", join(w.project, "a", "b", ".GIT")],
      ["mkdir staged && mv staged .git2 && mv .git2 bare.git", join(w.project, "bare.git")],
      ["mkdir -p .vscode && echo '{}' > .vscode/tasks.json", join(w.project, ".vscode", "tasks.json")],
      ["echo 'x' > .envrc", join(w.project, ".envrc")],
      ["mkdir -p Tool.app/Contents", join(w.project, "Tool.app")],
      ["mkdir -p inner/.moss && echo x > inner/.moss/settings.json", join(w.project, "inner", ".moss", "settings.json")],
      [`echo planted > ${JSON.stringify(join(w.home, "Documents", "outside.txt"))}`, join(w.home, "Documents", "outside.txt")],
      [`echo planted >> rc-link`, join(w.home, ".zshrc")],
      [`ln ${JSON.stringify(join(w.home, ".zshrc"))} hard-rc && echo planted >> hard-rc`, join(w.project, "hard-rc")],
    ];
    for (const [command, place] of refused) {
      await run(command);
      const changed = place === join(w.home, ".zshrc") ? readFileSync(place, "utf8") !== "ORIGINAL-RC\n"
        : place.endsWith("config") ? readFileSync(place, "utf8") !== "ORIGINAL-GIT\n" : existsSync(place);
      expect([command, changed]).toEqual([command, false]);
    }
    expect(readFileSync(join(w.home, ".zshrc"), "utf8")).toBe("ORIGINAL-RC\n");
    // A planted .git made by a rename into place is refused too: `staged` stays as it was.
    expect(existsSync(join(w.project, "bare.git"))).toBe(false);
  });

  test("the folder itself can't be renamed away, and a secret isn't read; a folder that moved meanwhile gives no access", async () => {
    const w = world();
    const e = exec(w);
    const r = await e.run("Bash", { command: `mv ${JSON.stringify(w.project)} ${JSON.stringify(join(w.home, "Projects", "moved"))}` }, ctxOf(w.project, { folder: w.project }));
    expect(r.isError).toBe(true);
    expect(existsSync(w.project)).toBe(true);
    const cat = await e.run("Bash", { command: `cat ${JSON.stringify(join(w.home, ".ssh", "id_ed25519"))}` }, ctxOf(w.project, { folder: w.project }));
    expect(JSON.stringify(cat.output).includes("KEY-SECRET")).toBe(false);
    // The folder the service checked is a link now: no access, with the reason.
    const other = join(w.home, "Projects", "other");
    mkdirSync(other);
    const swapped = join(w.home, "Projects", "swapped");
    symlinkSync(other, swapped);
    const s = await e.run("Bash", { command: "echo x > f.txt" }, ctxOf(swapped, { folder: swapped }));
    expect((s.output as { note?: string }).note).toContain("changed before the command started");
    expect(existsSync(join(other, "f.txt"))).toBe(false);
  });

  test("temp-only (no folder given): the folder isn't written, and the reason is in the result", async () => {
    const w = world();
    const e = exec(w);
    const why = "Beta's reviewer couldn't judge this command, so it ran without access to it";
    const r = await e.run("Bash", { command: "echo x > out.txt" }, ctxOf(w.project, { why }));
    expect(existsSync(join(w.project, "out.txt"))).toBe(false);
    expect((r.output as { note?: string }).note).toBe(why);
  });
});
