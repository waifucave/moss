// Lane XC: a bot's own file tools on `home/memory/` (the path its prompt names) and `home/<this computer>/`, through a
// real turn on the embedded runtime with its scripted test model. Without the tree (the build before lane XC) the
// runtime resolves `home/memory/…` against the bot's scratch folder: the Read finds nothing, and a Write lands in
// `<scratch>/home/memory/`, never in the memory. With the tree the same calls reach the bot's memory folder.
import { afterAll, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/moss-protocol";
import type { TurnControl, TurnInput } from "../../../src/contracts/session-host";
import type { BotSessionContext, EffectiveBot } from "../../../src/bots/service";
import { botPaths } from "../../../src/bots/paths";
import { BotSessionDriver, botFileFence, type BotDriverDeps } from "../../../src/runtime-sdk/turn-loop/driver";
import { MossFence } from "../../../src/fence/fence";
import { botSandboxSettings } from "../../../src/fence/sandbox-settings";
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
      const [, name, ...rest] = path.split("/");
      if (name === "memory") {
        if (as.kind !== "session" || as.bot === undefined) throw new Error("no computer memory");
        return { computer: "Studio", path: join(botPaths(mossHome, as.bot).memory, ...rest) };
      }
      return { computer: "Studio", path: join(userHome, ...rest) };
    },
  };
}

describeWithEmbeddedRuntime("a bot's file tools on home/memory/ (lane XC)", (spawn) => {
  function setup(tree: boolean) {
    const userHome = realpathSync(mkdtempSync(join(tmpdir(), "moss-xc-user-")));
    temps.push(userHome);
    const mossHome = join(userHome, ".moss");
    const ctx = context(mossHome);
    mkdirSync(ctx.paths.scratch, { recursive: true });
    mkdirSync(ctx.paths.memory, { recursive: true });
    writeFileSync(join(ctx.paths.memory, "MEMORY.md"), "- [People](people.md): who is who\n");
    const fence = new MossFence({ home: userHome, mossHome, temp: join(userHome, "fence-temp") });
    const sandbox = (c: BotSessionContext) => botSandboxSettings(fence.forCaller(c.caller).policy(), {
      mossHome, userHome, level: undefined, ownFolders: [c.paths.scratch, c.paths.root], pathFolders: [],
    });
    const allow: BotDriverDeps["canUseTool"] = () => async (_n, input) => ({ behavior: "allow", updatedInput: input as Record<string, unknown> });
    const driver = new BotSessionDriver(ctx, {
      home: mossHome, spawn, canUseTool: allow, sandbox, stopGraceMs: 5_000, log: () => {},
      fileFence: botFileFence(fence, mossHome, "macos", userHome),
      ...(tree ? { tree: studioTree(userHome, mossHome) } : {}),
    });
    return { userHome, ctx, driver };
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
