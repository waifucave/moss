// Lane XC, step 1: where a session's own tool call runs (`tree/route.ts`). Two computers on the fake link: a call that
// names no tree path is untouched (local behaviour unchanged by construction), one on this computer's part of the tree
// is rewritten to its real path, and one on the other computer goes there.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Caller } from "@waifucave/moss-protocol";
import { TreeRouter, shellQuote, type TreeRoute } from "../../src/tree/route";
import { Cluster, type TestComputer } from "./cluster-support";

const LUNA: Caller = { kind: "session", sessionId: "s_luna", sessionKind: "bot", bot: "luna" };
const CODING: Caller = { kind: "session", sessionId: "s_code", sessionKind: "coding" };

let cluster: Cluster | undefined;
afterEach(() => {
  cluster?.close();
  cluster = undefined;
});

async function two(join_ = true): Promise<{ a: TestComputer; b: TestComputer }> {
  cluster = new Cluster();
  const a = await cluster.add("Alpha");
  const b = await cluster.add("Beta");
  a.bots.push("luna");
  if (join_) await cluster.join();
  return { a, b };
}

function routerOn(c: TestComputer, as: Caller = LUNA): TreeRouter {
  return new TreeRouter({ directory: c.node.peers.directory(), resolve: (p, who) => c.node.tree.resolve(p, who), names: () => c.node.registry.list().map((x) => x.name) }, as);
}

describe("tree routes: local calls are untouched", () => {
  test("every call that names no tree path is local, the input as given", async () => {
    const { a } = await two();
    const r = routerOn(a);
    const local: [string, Record<string, unknown>][] = [
      ["Read", { file_path: "/etc/hosts" }],
      ["Read", { file_path: "notes.md" }],
      ["Read", { file_path: "homes/Beta/x.txt" }],
      ["Read", { file_path: "bots/main.py" }],
      ["Write", { file_path: "bots/helper/x.py", content: "x" }],
      ["Glob", { pattern: "src/**/*.ts" }],
      ["Glob", { pattern: "home*/x" }],
      ["Grep", { pattern: "x", glob: "*.md" }],
      ["Write", { file_path: "out/a.txt", content: "x" }],
      ["Edit", { file_path: "/tmp/a", old_string: "a", new_string: "b" }],
      ["Glob", { pattern: "**/*.ts" }],
      ["Glob", { pattern: "*.md", path: "/tmp" }],
      ["Grep", { pattern: "x" }],
      ["Bash", { command: "ls -la" }],
      ["Bash", { command: "cd /tmp && ls" }],
      ["Bash", { command: "cd sub && ls" }],
      ["Bash", { command: "cat home/Beta/x.txt" }],
      ["Bash", { command: "mv a b" }],
      ["TaskList", {}],
      ["mcp__x__y", { file_path: "home/Beta/x" }],
    ];
    for (const [tool, input] of local) expect([tool, r.route(tool, input)]).toEqual([tool, { kind: "local" }]);
    expect(r.route("Read", null)).toEqual({ kind: "local" });
    expect(r.route("Read", "home/Beta/x")).toEqual({ kind: "local" });
  });
});

describe("tree routes: this computer's part of the tree", () => {
  test("home/<this computer>/ is the real home folder; the rest of the input is kept", async () => {
    const { a } = await two();
    const r = routerOn(a);
    expect(r.route("Read", { file_path: "home/Alpha/notes/a.md", offset: 3 })).toEqual({ kind: "here", input: { file_path: join(a.home, "notes", "a.md"), offset: 3 } });
    expect(r.route("Glob", { pattern: "*.md", path: "home/Alpha/notes" })).toEqual({ kind: "here", input: { pattern: "*.md", path: join(a.home, "notes") } });
  });

  test("home/memory/ is the calling bot's own memory; a session with no memory is refused", async () => {
    const { a } = await two();
    const route = routerOn(a).route("Read", { file_path: "home/memory/MEMORY.md" }) as Extract<TreeRoute, { kind: "here" }>;
    expect(route.kind).toBe("here");
    expect(route.input.file_path).toBe(join(a.mossHome, "bots", "luna", "memory", "MEMORY.md"));
    const write = routerOn(a).route("Write", { file_path: "home/memory/people.md", content: "x" }) as Extract<TreeRoute, { kind: "here" }>;
    expect(write.input).toEqual({ file_path: join(a.mossHome, "bots", "luna", "memory", "people.md"), content: "x" });
    expect(routerOn(a, CODING).route("Read", { file_path: "home/memory/MEMORY.md" }).kind).toBe("refused");
  });

  test("home/Memory/ in any case is the memory, never a scratch folder of that name", async () => {
    const { a } = await two();
    for (const p of ["home/Memory/x.md", "home/MEMORY/x.md", "home/mEmOrY/x.md"]) {
      const r = routerOn(a).route("Write", { file_path: p, content: "x" }) as Extract<TreeRoute, { kind: "here" }>;
      expect([p, r.kind, r.input?.file_path]).toEqual([p, "here", join(a.mossHome, "bots", "luna", "memory", "x.md")]);
    }
  });

  test("a name under home/ that no computer has is refused, naming the computers", async () => {
    const { a } = await two();
    const r = routerOn(a).route("Write", { file_path: "home/Studoi/x.md", content: "x" });
    expect(r.kind).toBe("refused");
    expect((r as { reason: string }).reason).toContain("no computer is called Studoi");
    expect((r as { reason: string }).reason).toContain("Alpha");
    expect((r as { reason: string }).reason).toContain("Beta");
  });

  test("bots/<bot>/ is the tree only for a bot the tree knows; a project's own bots/ folder stays local", async () => {
    const { a } = await two();
    const r = routerOn(a);
    expect(r.route("Read", { file_path: "bots/luna/notes.md" })).toEqual({ kind: "here", input: { file_path: join(a.mossHome, "bots", "luna", "notes.md") } });
    expect(r.route("Read", { file_path: "bots/helper/main.py" })).toEqual({ kind: "local" });
  });

  test("Glob with no path and a pattern that begins with a tree path searches that folder; Grep's glob too", async () => {
    const { a } = await two();
    const r = routerOn(a);
    const mem = join(a.mossHome, "bots", "luna", "memory");
    expect(r.route("Glob", { pattern: "home/memory/**/*.md" })).toEqual({ kind: "here", input: { pattern: "**/*.md", path: mem } });
    expect(r.route("Glob", { pattern: "home/Memory/MEMORY.md" })).toEqual({ kind: "here", input: { pattern: "MEMORY.md", path: mem } });
    expect(r.route("Grep", { pattern: "Ada", glob: "home/memory/*.md" })).toEqual({ kind: "here", input: { pattern: "Ada", glob: "*.md", path: mem } });
    expect(r.route("Glob", { pattern: "home/Beta/src/*.ts" })).toEqual({ kind: "other", computer: "Beta", online: true });
    expect(r.route("Glob", { pattern: "home/Studoi/*" }).kind).toBe("refused");
  });

  test("a plain mv or cp with both ends here runs on their real paths", async () => {
    const { a } = await two();
    const mem = join(a.mossHome, "bots", "luna", "memory");
    expect(routerOn(a).route("Bash", { command: "mv home/memory/a.md home/memory/b.md" })).toEqual({ kind: "here", input: { command: `mv ${shellQuote(join(mem, "a.md"))} ${shellQuote(join(mem, "b.md"))}` } });
    expect(routerOn(a).route("Bash", { command: "cp -r home/Alpha/site home/memory/site" })).toEqual({ kind: "here", input: { command: `cp -R ${shellQuote(join(a.home, "site"))} ${shellQuote(join(mem, "site"))}` } });
  });

  test("once a command has moved the shell's folder, its relative paths are that folder's, not the tree's (but another computer's cd still goes there)", async () => {
    const { a } = await two();
    const r = routerOn(a);
    r.settled({ kind: "local" }, undefined, "cd /work/project && ls");
    expect(r.route("Bash", { command: "cd bots/luna && ls" })).toEqual({ kind: "local" });
    expect(r.route("Bash", { command: "mv home/memory/a home/memory/b" })).toEqual({ kind: "local" });
    expect(r.route("Bash", { command: "cd home/Studoi && ls" })).toEqual({ kind: "local" });
    expect(r.route("Bash", { command: "cd home/Beta/x && ls" })).toEqual({ kind: "other", computer: "Beta", online: true });
    // The file tools' relative paths are always the start folder's.
    expect(r.route("Read", { file_path: "home/memory/MEMORY.md" }).kind).toBe("here");
  });

  test("a tree path with . or .. or an empty part is refused, never resolved", async () => {
    const { a } = await two();
    const r = routerOn(a);
    for (const p of ["home/Alpha/../x", "home/memory/../../credentials", "home/Beta/./x", "home/Alpha//x", "home/memory/a\\..\\b"]) {
      expect([p, r.route("Read", { file_path: p }).kind]).toEqual([p, "refused"]);
    }
  });

  test("Bash's leading cd into this computer's tree is the real folder", async () => {
    const { a } = await two();
    const r = routerOn(a);
    expect(r.route("Bash", { command: "cd home/Alpha/project && git status", timeout: 5 })).toEqual({
      kind: "here", input: { command: `cd ${shellQuote(join(a.home, "project"))} && git status`, timeout: 5 },
    });
    expect(r.route("Bash", { command: "cd 'home/Alpha/my project'" })).toEqual({ kind: "here", input: { command: `cd ${shellQuote(join(a.home, "my project"))}` } });
  });

  test("shellQuote keeps a quote in a folder's name", () => {
    expect(shellQuote("/a/it's")).toBe(`'/a/it'\\''s'`);
  });
});

describe("tree routes: another computer", () => {
  test("a file tool's path on Beta goes to Beta", async () => {
    const { a } = await two();
    const r = routerOn(a);
    for (const [tool, input] of [["Read", { file_path: "home/Beta/x.txt" }], ["Write", { file_path: "home/Beta/x.txt", content: "" }], ["Edit", { file_path: "home/beta/x.txt", old_string: "a", new_string: "b" }], ["Glob", { pattern: "*", path: "home/Beta" }], ["Grep", { pattern: "a", path: "home/Beta/src" }]] as const) {
      expect([tool, r.route(tool, input)]).toEqual([tool, { kind: "other", computer: "Beta", online: true }]);
    }
  });

  test("a computer that never said hello is offline at once", async () => {
    const { a } = await two(false);
    expect(routerOn(a).route("Read", { file_path: "home/Beta/x.txt" })).toEqual({ kind: "other", computer: "Beta", online: false });
  });

  test("Bash keeps its folder on Beta until a cd leaves it", async () => {
    const { a } = await two();
    const r = routerOn(a);
    const first = r.route("Bash", { command: "cd home/Beta/project && git status" });
    expect(first).toEqual({ kind: "other", computer: "Beta", online: true });
    r.settled(first, "home/Beta/project");
    expect(r.treeCwd).toBe("home/Beta/project");
    expect(r.route("Bash", { command: "ls" })).toEqual({ kind: "other", computer: "Beta", online: true, cwd: "home/Beta/project" });
    // Relative to the folder on Beta, as in a shell.
    expect(r.route("Bash", { command: "cd src && ls" })).toEqual({ kind: "other", computer: "Beta", online: true, cwd: "home/Beta/project" });
    // Back to this computer: the runtime's own Bash again.
    const back = r.route("Bash", { command: "cd /tmp && ls" });
    expect(back).toEqual({ kind: "local" });
    r.settled(back);
    expect(r.treeCwd).toBeUndefined();
    expect(r.route("Bash", { command: "ls" })).toEqual({ kind: "local" });
  });

  test("a cd into this computer's tree clears the folder on Beta", async () => {
    const { a } = await two();
    const r = routerOn(a);
    r.settled(r.route("Bash", { command: "cd home/Beta" }), "home/Beta");
    const here = r.route("Bash", { command: "cd home/Alpha && ls" });
    expect(here.kind).toBe("here");
    r.settled(here);
    expect(r.treeCwd).toBeUndefined();
  });

  test("a plain mv or cp between computers takes the direct path; both ends here stay local", async () => {
    const { a } = await two();
    const r = routerOn(a);
    expect(r.route("Bash", { command: "mv home/Alpha/report home/Beta/" })).toEqual({ kind: "other", computer: "Beta", online: true, cwd: "home/Alpha" });
    expect(r.route("Bash", { command: "cp -r home/Beta/site home/Alpha/site" })).toEqual({ kind: "other", computer: "Beta", online: true, cwd: "home/Alpha" });
    expect(r.route("Bash", { command: "mv home/Alpha/a home/Alpha/b" })).toEqual({ kind: "here", input: { command: `mv ${shellQuote(join(a.home, "a"))} ${shellQuote(join(a.home, "b"))}` } });
    // An end that isn't written as a tree path is this computer's own: the runtime's Bash runs it, as before.
    expect(r.route("Bash", { command: "mv home/Alpha/../a home/Beta/" })).toEqual({ kind: "local" });
    expect(r.route("Bash", { command: "mv notes home/Beta/" })).toEqual({ kind: "local" });
  });
});
