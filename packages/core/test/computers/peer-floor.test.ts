// Lane XC, step 2's floor (the reader's): another computer's call on this one gets never more than a bot running here.
// Its Bash runs on the real fenced process (Seatbelt here) whose one write root is the call's own fresh temp folder; its
// file calls through the tree meet the same run-later and secret-place refusals (fence/peer-floor.ts, one rule for both).
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/moss-protocol";
import { fencedExecutor } from "../../src/computers/fenced-executor";
import { MossFence } from "../../src/fence/fence";
import { fencedSpawner } from "../../src/fence/fenced-process";
import { peerFence, peerReadRefusal, peerWriteRefusal } from "../../src/fence/peer-floor";
import { LocalHolder } from "../../src/tree/holder";
import { hostOs } from "../../src/tree/names";
import { darwinDescribe } from "../helpers/darwin-only";
import { Cluster } from "../tree/cluster-support";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
function temp(prefix: string): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
}

const PEER: Caller = { kind: "peer", device: "dev_alpha", sessionId: "b_luna" };

function world() {
  const root = temp("xc-peer-floor-");
  const home = join(root, "home");
  const moss = join(home, ".moss");
  const tmp = join(root, "tmp");
  for (const d of [moss, join(home, "project", ".git"), join(home, "project", ".vscode"), join(home, ".ssh"), tmp]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, ".zshrc"), "ORIGINAL-RC\n");
  writeFileSync(join(home, "project", ".git", "config"), "ORIGINAL-GIT\n");
  writeFileSync(join(home, ".ssh", "id_ed25519"), "KEY-SECRET\n");
  writeFileSync(join(home, "project", "notes.md"), "notes\n");
  const fence = new MossFence({ os: hostOs(), home, mossHome: moss, temp: tmp });
  return { root, home, moss, tmp, fence };
}

describe("the peer floor's one rule (fence/peer-floor.ts)", () => {
  test("writes: run-later places and secret places refused; an ordinary file not", () => {
    const { home, moss } = world();
    const o = { userHome: home, mossHome: moss, os: hostOs() };
    for (const p of [join(home, ".zshrc"), join(home, "project", ".git", "config"), join(home, "project", ".vscode", "tasks.json"), join(home, ".ssh", "id_ed25519"), join(home, "project", ".mcp.json")]) {
      expect([p, peerWriteRefusal(p, o) !== undefined]).toEqual([p, true]);
    }
    expect(peerWriteRefusal(join(home, "project", "notes.md"), o)).toBeUndefined();
    expect(peerReadRefusal(join(home, ".ssh", "id_ed25519"), o)).toBeDefined();
    expect(peerReadRefusal(join(home, "project", "notes.md"), o)).toBeUndefined();
  });

  test("peerFence narrows only the policy: one write root, the secret places read-denied, the rest the fence's own", () => {
    const { home, moss, fence } = world();
    const v = peerFence(fence, "/x/peer-root", { userHome: home, mossHome: moss, os: hostOs() });
    expect(v.policy().allowWrite).toEqual(["/x/peer-root"]);
    expect(v.policy().denyRead).toEqual(expect.arrayContaining(fence.policy().denyRead));
    expect(v.policy().denyRead.length).toBeGreaterThan(fence.policy().denyRead.length);
    expect(v.fencedSet()).toEqual(fence.fencedSet());
    expect(v.home).toBe(fence.home);
    expect(v.temp).toBe(fence.temp);
  });
});

darwinDescribe("a peer's Bash on the real fenced process (Seatbelt)", () => {
  test("refused: ~/.zshrc, a .git/config, a .vscode/tasks.json, a file outside its own temp folder; its TMPDIR is its own and gone after", async () => {
    const { home, moss, tmp, fence } = world();
    const exec = fencedExecutor({
      spawner: fencedSpawner({ fence }), home, temp: tmp, mossHome: moss, os: hostOs(),
      peerSpawner: (root) => fencedSpawner({ fence: peerFence(fence, root, { userHome: home, mossHome: moss, os: hostOs() }) }),
    });
    const ctx = { as: PEER, session: "b_luna", callId: "c1", cwd: join(home, "project"), treeCwd: "home/Beta/project", signal: new AbortController().signal, output: () => {} };
    const run = async (command: string) => exec.run("Bash", { command }, ctx);
    for (const [target, original] of [[join(home, ".zshrc"), "ORIGINAL-RC\n"], [join(home, "project", ".git", "config"), "ORIGINAL-GIT\n"]] as const) {
      const r = await run(`echo planted >> ${JSON.stringify(target)}`);
      expect([target, r.isError]).toEqual([target, true]);
      expect(readFileSync(target, "utf8")).toBe(original);
    }
    const vscode = await run(`echo x > ${JSON.stringify(join(home, "project", ".vscode", "tasks.json"))}`);
    expect(vscode.isError).toBe(true);
    expect(existsSync(join(home, "project", ".vscode", "tasks.json"))).toBe(false);
    // Outside its own write root: an ordinary file in the project too (a bot here at ask for risky actions can't either).
    const outside = await run(`echo x > ${JSON.stringify(join(home, "project", "new.md"))}`);
    expect(outside.isError).toBe(true);
    expect(existsSync(join(home, "project", "new.md"))).toBe(false);
    // The secret places unread.
    const secret = await run(`cat ${JSON.stringify(join(home, ".ssh", "id_ed25519"))}`);
    expect(JSON.stringify(secret.output)).not.toContain("KEY-SECRET");
    // Its own temp folder: writable, its TMPDIR, and removed after the call; reading the project works.
    const own = await run('f="$TMPDIR/scratch.txt" && echo mine > "$f" && cat "$f" && echo "$TMPDIR" && cat notes.md');
    expect(own.isError).toBe(false);
    const out = (own.output as { stdout: string }).stdout.split("\n");
    expect(out[0]).toBe("mine");
    expect(out[1]!.startsWith(join(tmp, "peer-"))).toBe(true);
    expect(out[2]).toBe("notes");
    expect(existsSync(out[1]!)).toBe(false);
    // Two calls never share a folder.
    expect(readdirSync(tmp).filter((n) => n.startsWith("peer-"))).toEqual([]);
  }, 60_000);

  test("without a peer spawner a peer's command is refused, never run on the wider one", async () => {
    const { home, moss, tmp, fence } = world();
    const exec = fencedExecutor({ spawner: fencedSpawner({ fence }), home, temp: tmp, mossHome: moss, os: hostOs() });
    const r = await exec.run("Bash", { command: "echo hi" }, { as: PEER, session: "s", callId: "c", cwd: home, treeCwd: "home/Beta", signal: new AbortController().signal, output: () => {} });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.output)).toContain("runs no commands for other computers");
  });
});

describe("the direct path between computers: every entry judged where it lands", () => {
  test("a folder that brings a .git or a shell's start file onto the other computer is refused whole and leaves nothing; a plain one moves", async () => {
    const cluster = new Cluster();
    try {
      const studio = await cluster.add("Studio");
      const laptop = await cluster.add("Laptop1");
      for (const c of [studio, laptop]) await c.node.registry.setLevel(c.name, "automatic", { via: "terminal" });
      await cluster.join();
      const BOT = { kind: "session", sessionId: "s_alpha", sessionKind: "bot", bot: "alpha" } as const;
      const src = join(studio.home, "repo");
      mkdirSync(join(src, ".git", "hooks"), { recursive: true });
      writeFileSync(join(src, ".git", "hooks", "post-checkout"), "#!/bin/sh\necho planted\n");
      writeFileSync(join(src, "README.md"), "hi");
      const err = await studio.node.tree.copy("home/Studio/repo", "home/Laptop1/repo", { as: BOT }).then(() => undefined, (e: unknown) => e);
      expect((err as { code?: string } | undefined)?.code).toBe("fenced");
      expect(existsSync(join(laptop.home, "repo"))).toBe(false);
      expect(readdirSync(laptop.home).filter((n) => n.startsWith(".moss-receiving-"))).toEqual([]);
      const rc = join(studio.home, "dots");
      mkdirSync(rc);
      writeFileSync(join(rc, ".bashrc"), "x");
      expect(await studio.node.tree.copy("home/Studio/dots", "home/Laptop1/dots", { as: BOT }).then(() => "ok", (e: { code?: string }) => e.code)).toBe("fenced");
      // The plain folder moves.
      const plain = join(studio.home, "site");
      mkdirSync(plain);
      writeFileSync(join(plain, "index.html"), "<h1>hi</h1>");
      await studio.node.tree.move("home/Studio/site", "home/Laptop1/site", { as: BOT });
      expect(readFileSync(join(laptop.home, "site", "index.html"), "utf8")).toBe("<h1>hi</h1>");
    } finally {
      cluster.close();
    }
  }, 30_000);
});

describe("a peer's file calls through the tree (LocalHolder): the same floor", () => {
  function holder() {
    const w = world();
    const h = new LocalHolder({
      clock: { now: () => Date.now() }, name: () => "Beta", home: w.home, mossHome: w.moss, os: hostOs(),
      fence: new MossFence({ os: hostOs(), home: w.home, mossHome: w.moss, temp: w.tmp }), level: () => "automatic",
    });
    return { ...w, h };
  }
  const call = { as: PEER, level: "automatic" as const };

  test("tree.write to ~/.zshrc, a .git/config, a .vscode file or a secret place is refused; an ordinary file is written", async () => {
    const { home, h } = holder();
    for (const p of ["home/Beta/.zshrc", "home/Beta/project/.git/config", "home/Beta/project/.vscode/tasks.json", "home/Beta/.ssh/id_ed25519"]) {
      const err = await h.write(p, { encoding: "utf8", text: "planted" }, call).then(() => undefined, (e: unknown) => e);
      expect([p, (err as { code?: string } | undefined)?.code]).toEqual([p, "fenced"]);
    }
    expect(readFileSync(join(home, ".zshrc"), "utf8")).toBe("ORIGINAL-RC\n");
    expect(readFileSync(join(home, "project", ".git", "config"), "utf8")).toBe("ORIGINAL-GIT\n");
    await h.write("home/Beta/project/ok.md", { encoding: "utf8", text: "fine" }, call);
    expect(readFileSync(join(home, "project", "ok.md"), "utf8")).toBe("fine");
  });

  test("mkdir and a move's target on a run-later place are refused; a secret place isn't read", async () => {
    const { h } = holder();
    const mk = await h.mkdir("home/Beta/project/.git/hooks", call).then(() => undefined, (e: unknown) => e);
    expect((mk as { code?: string } | undefined)?.code).toBe("fenced");
    const mv = await h.move("home/Beta/project/notes.md", "home/Beta/.bashrc", call).then(() => undefined, (e: unknown) => e);
    expect((mv as { code?: string } | undefined)?.code).toBe("fenced");
    const rd = await h.read("home/Beta/.ssh/id_ed25519", { ...call, encoding: "utf8" }).then(() => undefined, (e: unknown) => e);
    expect((rd as { code?: string } | undefined)?.code).toBe("fenced");
  });
});
