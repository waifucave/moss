// Lane XC: a bot's own file tools on `home/memory/` (the path its prompt names) and `home/<this computer>/`, through a
// real turn on the embedded runtime with its scripted test model. Without the tree (the build before lane XC) the
// runtime resolves `home/memory/…` against the bot's scratch folder: the Read finds nothing, and a Write lands in
// `<scratch>/home/memory/`, never in the memory. With the tree the same calls reach the bot's memory folder.
import { afterAll, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/moss-protocol";
import type { TurnControl, TurnInput } from "../../../src/contracts/session-host";
import type { BotSessionContext, EffectiveBot } from "../../../src/bots/service";
import { botPaths } from "../../../src/bots/paths";
import { BotSessionDriver, botFileFence, type BotDriverDeps } from "../../../src/runtime-sdk/turn-loop/driver";
import { MossFence } from "../../../src/fence/fence";
import { botSandboxSettings } from "../../../src/fence/sandbox-settings";
import { botApprovalCheck } from "../../../src/approvals/bot-check";
import type { TreeRouteDeps } from "../../../src/tree/route";
import { describeWithEmbeddedRuntime } from "../../helpers/embedded-runtime";
import { darwinTest } from "../../helpers/darwin-only";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

function control(): TurnControl {
  const ac = new AbortController();
  return { origin: "user", signal: ac.signal, onFold: () => () => {}, record: () => {} } as unknown as TurnControl;
}
const user = (text: string): TurnInput => ({ from: "user", text, device: "d_1", sentAt: Date.now(), clientMessageId: crypto.randomUUID() });
const results = (end: { text?: string }) => JSON.parse(end.text ?? "[]") as { name: string | null; isError: boolean; content: string }[];

function context(home: string): BotSessionContext & { bot: EffectiveBot } {
  const bot: EffectiveBot = { id: "luna", name: "Luna", instructions: "You are Luna.", model: "winter-test/calls", modelFrom: "user", userLayer: [] };
  return {
    bot, botId: "luna", sessionId: "b_luna", kind: "bot", computer: "Studio", paths: botPaths(home, "luna"),
    caller: { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" },
    current: () => bot, memoryBlock: () => "<memory>\nnothing yet\n</memory>",
    mayAct: () => true, whenMayAct: async () => {}, cacheCold: () => false,
  };
}

/** The tree as this computer's node gives it, for one computer, Studio: `home/Studio/` is the user's home and
 *  `home/memory/` the calling bot's memory (`CoreTree.resolve`'s rules). */
function studioTree(userHome: string, mossHome: string): TreeRouteDeps {
  const studio = { name: "Studio", aliases: [], online: true, level: "ask-risky" as never, home: userHome, os: "macos" as const };
  return {
    directory: { self: () => "Studio", get: (n) => (n.toLowerCase() === "studio" ? studio : undefined) },
    resolve: (path: string, as: Caller) => {
      const [area, name, ...rest] = path.split("/");
      if (area === "bots") {
        // The bots this computer runs: luna and sol.
        if (name !== "luna" && name !== "sol") throw new Error(`no bot ${name}`);
        return { computer: "Studio", path: join(mossHome, "bots", name, ...rest) };
      }
      if (name === "memory") {
        if (as.kind !== "session" || as.bot === undefined || (as.sessionKind !== "bot" && as.sessionKind !== "side-thread")) throw new Error("no computer memory");
        return { computer: "Studio", path: join(botPaths(mossHome, as.bot).memory, ...rest) };
      }
      return { computer: "Studio", path: join(userHome, ...rest) };
    },
    names: () => ["Studio"],
  };
}

/** The real approval check (lane C's), its broker recording each request and answering yes on a card. */
function realCheck(requests: { paths?: string[]; tool?: string }[]): BotDriverDeps["canUseTool"] {
  return (ctx, origin) => botApprovalCheck({
    request: async (req: { paths?: string[]; tool?: string }) => {
      requests.push(req);
      return { allowed: true, by: "card" };
    },
  } as never, { localComputer: "Studio" })(ctx, origin);
}

describeWithEmbeddedRuntime("a bot's file tools on home/memory/ (lane XC)", (spawn) => {
  function setup(tree: boolean, o: { canUseTool?: BotDriverDeps["canUseTool"]; caller?: Caller } = {}) {
    const userHome = realpathSync(mkdtempSync(join(tmpdir(), "moss-xc-user-")));
    temps.push(userHome);
    const mossHome = join(userHome, ".moss");
    const base = context(mossHome);
    const ctx = o.caller === undefined ? base : { ...base, caller: o.caller as BotSessionContext["caller"] };
    mkdirSync(ctx.paths.scratch, { recursive: true });
    mkdirSync(ctx.paths.memory, { recursive: true });
    writeFileSync(join(ctx.paths.memory, "MEMORY.md"), "- [People](people.md): who is who\n");
    const fence = new MossFence({ home: userHome, mossHome, temp: join(userHome, "fence-temp") });
    const sandbox = (c: BotSessionContext) => botSandboxSettings(fence.forCaller(c.caller).policy(), {
      mossHome, userHome, level: undefined, ownFolders: [c.paths.scratch, c.paths.root], pathFolders: [],
    });
    const allow: BotDriverDeps["canUseTool"] = () => async (_n, input) => ({ behavior: "allow", updatedInput: input as Record<string, unknown> });
    const driver = new BotSessionDriver(ctx, {
      home: mossHome, spawn, canUseTool: o.canUseTool ?? allow, sandbox, stopGraceMs: 5_000, log: () => {},
      fileFence: botFileFence(fence, mossHome, "macos", userHome),
      ...(tree ? { tree: studioTree(userHome, mossHome) } : {}),
    });
    return { userHome, mossHome, ctx, driver };
  }
  const calls = [
    `CALL Read ${JSON.stringify({ file_path: "home/memory/MEMORY.md" })}`,
    `CALL Write ${JSON.stringify({ file_path: "home/memory/people.md", content: "Ada runs the lab." })}`,
  ].join("\n");

  darwinTest("before lane XC (no tree): the Read misses the memory and the Write lands in scratch", async () => {
    const { ctx, driver } = setup(false);
    try {
      const r = results(await driver.turn(user(calls), control()));
      expect(r.find((x) => x.name === "Read")?.content ?? "").not.toContain("who is who");
      expect(existsSync(join(ctx.paths.memory, "people.md"))).toBe(false);
      expect(readFileSync(join(ctx.paths.scratch, "home", "memory", "people.md"), "utf8")).toBe("Ada runs the lab.");
    } finally {
      await driver.stop();
    }
  }, 60_000);

  darwinTest("with the tree: the Read reads the memory index and the Write lands in the memory folder; home/Studio/ is the home folder", async () => {
    const { userHome, ctx, driver } = setup(true);
    writeFileSync(join(userHome, "todo.txt"), "buy milk");
    try {
      const r = results(await driver.turn(user(`${calls}\nCALL Read ${JSON.stringify({ file_path: "home/Studio/todo.txt" })}`), control()));
      const reads = r.filter((x) => x.name === "Read");
      expect(reads[0]?.isError).toBe(false);
      expect(reads[0]?.content).toContain("who is who");
      expect(r.find((x) => x.name === "Write")?.isError).toBe(false);
      expect(readFileSync(join(ctx.paths.memory, "people.md"), "utf8")).toBe("Ada runs the lab.");
      expect(existsSync(join(ctx.paths.scratch, "home"))).toBe(false);
      expect(reads[1]?.content).toContain("buy milk");
    } finally {
      await driver.stop();
    }
  }, 60_000);

  darwinTest("with the tree: an Edit of an existing memory file changes it; Glob and Grep under home/memory/ search the memory folder", async () => {
    const { ctx, driver } = setup(true);
    writeFileSync(join(ctx.paths.memory, "people.md"), "Ada runs the lab.\n");
    writeFileSync(join(ctx.paths.scratch, "decoy.md"), "who is who in scratch\n");
    try {
      const r = results(await driver.turn(user([
        `CALL Read ${JSON.stringify({ file_path: "home/memory/people.md" })}`,
        `CALL Edit ${JSON.stringify({ file_path: "home/memory/people.md", old_string: "the lab", new_string: "the observatory" })}`,
        `CALL Glossary ${JSON.stringify({ load: ["Glob", "Grep"] })}`,
        `CALL Glob ${JSON.stringify({ pattern: "*.md", path: "home/memory" })}`,
        `CALL Grep ${JSON.stringify({ pattern: "who is who", path: "home/memory", output_mode: "files_with_matches" })}`,
      ].join("\n")), control()));
      expect(r.find((x) => x.name === "Edit")?.isError).toBe(false);
      expect(readFileSync(join(ctx.paths.memory, "people.md"), "utf8")).toBe("Ada runs the observatory.\n");
      const glob = r.find((x) => x.name === "Glob")?.content ?? "";
      expect(glob).toContain("MEMORY.md");
      expect(glob).toContain("people.md");
      expect(glob).not.toContain("decoy.md");
      const grep = r.find((x) => x.name === "Grep")?.content ?? "";
      expect(grep).toContain("MEMORY.md");
      expect(grep).not.toContain("decoy.md");
    } finally {
      await driver.stop();
    }
  }, 60_000);

  darwinTest("with the tree: home/<a name no computer has>/ is refused with the computers' names, never written into scratch; home/Memory/ is the memory", async () => {
    const { ctx, driver } = setup(true);
    try {
      const r = results(await driver.turn(user([
        `CALL Write ${JSON.stringify({ file_path: "home/Studoi/plan.txt", content: "x" })}`,
        `CALL Write ${JSON.stringify({ file_path: "home/Memory/cased.md", content: "cased" })}`,
      ].join("\n")), control()));
      expect(r[0]?.content).toContain("no computer is called Studoi (the computers: Studio)");
      expect(existsSync(join(ctx.paths.scratch, "home"))).toBe(false);
      expect(readFileSync(join(ctx.paths.memory, "cased.md"), "utf8")).toBe("cased");
    } finally {
      await driver.stop();
    }
  }, 60_000);

  darwinTest("a project's own bots/ folder in the start folder stays the project's; bots/<a bot here>/ is that bot's folder", async () => {
    const { ctx, mossHome, driver } = setup(true);
    mkdirSync(join(ctx.paths.scratch, "bots"), { recursive: true });
    writeFileSync(join(ctx.paths.scratch, "bots", "main.py"), "print('project')");
    mkdirSync(join(mossHome, "bots", "sol"), { recursive: true });
    writeFileSync(join(mossHome, "bots", "sol", "notes.md"), "sol's notes");
    try {
      const r = results(await driver.turn(user([
        `CALL Read ${JSON.stringify({ file_path: "bots/main.py" })}`,
        `CALL Read ${JSON.stringify({ file_path: "bots/sol/notes.md" })}`,
      ].join("\n")), control()));
      expect(r[0]?.content).toContain("project");
      expect(r[1]?.content).toContain("sol's notes");
    } finally {
      await driver.stop();
    }
  }, 60_000);

  darwinTest("with the real approval check: secret places through the tree spelling are refused; another bot's memory is judged as its real path; the card shows the real path", async () => {
    const requests: { paths?: string[]; tool?: string }[] = [];
    const { userHome, mossHome, driver } = setup(true, { canUseTool: realCheck(requests) });
    mkdirSync(join(userHome, ".ssh"), { recursive: true });
    writeFileSync(join(userHome, ".ssh", "id_ed25519"), "KEY-SECRET");
    mkdirSync(join(mossHome, "credentials"), { recursive: true });
    writeFileSync(join(mossHome, "credentials", "anthropic.json"), "CRED-SECRET");
    mkdirSync(join(mossHome, "bots", "sol", "memory"), { recursive: true });
    const solMemory = join(mossHome, "bots", "sol", "memory", "MEMORY.md");
    writeFileSync(solMemory, "sol remembers");
    mkdirSync(join(userHome, "Desktop"), { recursive: true });
    try {
      const r = results(await driver.turn(user([
        `CALL Read ${JSON.stringify({ file_path: "home/Studio/.ssh/id_ed25519" })}`,
        `CALL Read ${JSON.stringify({ file_path: "home/Studio/.moss/credentials/anthropic.json" })}`,
        `CALL Read ${JSON.stringify({ file_path: "bots/sol/memory/MEMORY.md" })}`,
        `CALL Read ${JSON.stringify({ file_path: solMemory })}`,
        `CALL Write ${JSON.stringify({ file_path: "home/Studio/Desktop/note.txt", content: "on the desk" })}`,
      ].join("\n")), control()));
      for (const x of r) {
        expect(x.content).not.toContain("KEY-SECRET");
        expect(x.content).not.toContain("CRED-SECRET");
      }
      // The tree spelling and the real path answer alike.
      expect([r[2]?.isError, r[2]?.content]).toEqual([r[3]?.isError, r[3]?.content]);
      // The Write outside the bot's roots asked, on the card, about the real path.
      const write = requests.find((q) => q.paths?.some((p) => p.endsWith("note.txt")));
      expect(write?.paths).toContain(join(userHome, "Desktop", "note.txt"));
      expect(requests.flatMap((q) => q.paths ?? []).some((p) => p.startsWith("home/"))).toBe(false);
      expect(readFileSync(join(userHome, "Desktop", "note.txt"), "utf8")).toBe("on the desk");
    } finally {
      await driver.stop();
    }
  }, 60_000);

  darwinTest("a session with no memory (not a bot's own) is refused home/memory/, with the reason", async () => {
    const { driver } = setup(true, { caller: { kind: "session", sessionId: "s_code", sessionKind: "coding" } });
    try {
      const r = results(await driver.turn(user(`CALL Write ${JSON.stringify({ file_path: "home/memory/x.md", content: "x" })}`), control()));
      expect(r[0]?.content).toContain("no computer memory");
    } finally {
      await driver.stop();
    }
  }, 60_000);

  // PostToolUse is handed the call's input as it ran (the runtime's `executedCall.input`: the real path), so the
  // search fence (`fenceSearchOutput`) judges each hit against the real memory folder. A link in it to a place bots
  // may not read (the MOSS home's credentials) yields nothing through the tree spelling, exactly as through the real
  // path; a link to a file bots may read anyway answers alike both ways.
  darwinTest("a Grep under home/memory/ with links in the memory folder that lead out: judged as the real path, credentials never come back", async () => {
    const { mossHome, ctx, driver } = setup(true);
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "moss-xc-outside-")));
    temps.push(outside);
    writeFileSync(join(outside, "readable.md"), "SECRET-ish but readable\n");
    mkdirSync(join(mossHome, "credentials"), { recursive: true });
    writeFileSync(join(mossHome, "credentials", "token.md"), "SECRET-CREDENTIAL-TEXT\n");
    symlinkSync(join(outside, "readable.md"), join(ctx.paths.memory, "leak.md"));
    symlinkSync(join(mossHome, "credentials"), join(ctx.paths.memory, "creds"));
    try {
      const r = results(await driver.turn(user([
        `CALL Glossary ${JSON.stringify({ load: ["Grep"] })}`,
        `CALL Grep ${JSON.stringify({ pattern: "SECRET", path: "home/memory", output_mode: "content" })}`,
        `CALL Grep ${JSON.stringify({ pattern: "SECRET", path: ctx.paths.memory, output_mode: "content" })}`,
      ].join("\n")), control()));
      const [viaTree, viaReal] = r.filter((x) => x.name === "Grep").map((x) => x.content);
      expect(viaTree).not.toContain("SECRET-CREDENTIAL-TEXT");
      expect(viaReal).not.toContain("SECRET-CREDENTIAL-TEXT");
      expect(viaTree).toBe(viaReal!);
    } finally {
      await driver.stop();
    }
  }, 60_000);

  darwinTest("with the tree: a dotted tree path is refused, never resolved", async () => {
    const { driver } = setup(true);
    try {
      const r = results(await driver.turn(user(`CALL Read ${JSON.stringify({ file_path: "home/memory/../../credentials/x" })}`), control()));
      expect(r[0]?.content).toContain("takes no");
    } finally {
      await driver.stop();
    }
  }, 60_000);
});
