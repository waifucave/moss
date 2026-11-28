// Lane XC, agent runtime 0.0.92 (found by lane MQ's diagnostic on the per-call e2e: a bot's write in its own working
// folder refused as a read-only file system, the command exiting 0, nothing said): on Linux a working folder inside a
// write root whose walk can't finish stays writable when its own walk covered it, and the roots the command couldn't
// write are said on EVERY command, exit 0 too. A bot at fully automatic, its working folder inside a home folder the
// walk can't finish (a folder 18 deep in it): the write in the working folder lands, a write beside it is refused, the
// command exits 0, and the bot's result carries MOSS's plain line (driver.ts `droppedRootsNote`).
//
// Run only: scripts/pinned-bun test packages/core/test/runtime-sdk/turn-loop/linux-inner-root.e2e.test.ts (Linux, CI).
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnControl, TurnInput } from "../../../src/contracts/session-host";
import type { BotSessionContext, EffectiveBot } from "../../../src/bots/service";
import { botPaths } from "../../../src/bots/paths";
import { BotSessionDriver, type BotDriverDeps } from "../../../src/runtime-sdk/turn-loop/driver";
import { MossFence } from "../../../src/fence/fence";
import { botSandboxSettings } from "../../../src/fence/sandbox-settings";
import { describeWithEmbeddedRuntime } from "../../helpers/embedded-runtime";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const linuxTest = process.platform === "linux" ? test : test.skip;

function control(into: string[]): TurnControl {
  const ac = new AbortController();
  return { origin: "user", signal: ac.signal, onFold: () => () => {}, record: (e) => { into.push(JSON.stringify(e)); } };
}

const user = (text: string): TurnInput => ({ from: "user", text, device: "d_1", sentAt: Date.now(), clientMessageId: crypto.randomUUID() });

describeWithEmbeddedRuntime("a bot's working folder inside a home folder its walk can't finish (Linux, agent runtime 0.0.92)", (spawn) => {
  linuxTest("the write in the working folder lands, the one beside it doesn't, and the bot is told though the command exited 0", async () => {
    const userDir = realpathSync(mkdtempSync(join(tmpdir(), "moss-inner-root-")));
    temps.push(userDir);
    const mossHome = join(userDir, ".moss");
    mkdirSync(mossHome, { recursive: true });
    writeFileSync(join(mossHome, "settings.json"), "{}\n");
    const projects = join(userDir, "Projects");
    // What stops the walk of the home's Projects folder: a folder past its 16 levels.
    mkdirSync(join(projects, ...Array.from({ length: 18 }, (_, i) => `d${i}`)), { recursive: true });
    const temp = join(userDir, "tmp-moss");
    mkdirSync(temp, { recursive: true });
    // The bot's working folder (its shell's cwd) inside Projects, as a person's project under ~/Projects.
    const work = join(projects, "app");
    mkdirSync(work, { recursive: true });
    const bot: EffectiveBot = { id: "luna", name: "Luna", instructions: "You are Luna.", model: "winter-test/calls", modelFrom: "user", userLayer: [] };
    const paths = { ...botPaths(mossHome, "luna"), scratch: work };
    mkdirSync(paths.root, { recursive: true });
    const ctx: BotSessionContext & { bot: EffectiveBot } = {
      bot, botId: "luna", sessionId: "b_luna", kind: "bot", computer: "Studio", paths,
      caller: { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" },
      current: () => bot, memoryBlock: () => "<memory>\nnothing yet\n</memory>",
      mayAct: () => true, whenMayAct: async () => {}, cacheCold: () => false,
    };
    const fence = new MossFence({ os: "linux", home: userDir, mossHome, temp });
    let roots: string[] = [];
    const deps: BotDriverDeps = {
      home: mossHome, spawn,
      canUseTool: () => async (_name, input) => ({ behavior: "allow", updatedInput: input as Record<string, unknown> }),
      sandbox: (c) => {
        const s = botSandboxSettings(fence.forCaller(c.caller).policy(), { mossHome, userHome: userDir, level: "automatic", ownFolders: [c.paths.scratch, c.paths.root], pathFolders: [] });
        roots = s.filesystem?.allowWrite ?? [];
        return s;
      },
      stopGraceMs: 5_000, log: () => {},
    };
    const driver = new BotSessionDriver(ctx, deps);
    const records: string[] = [];
    try {
      const command = "echo ok > in.txt; echo no > ../beside.txt 2>/dev/null; echo done";
      const end = await driver.turn(user(`CALL Bash ${JSON.stringify({ command, description: "write here and beside" })}`), control(records));
      const all = records.join("\n");
      console.log(`linux inner root: roots ${roots.length} (Projects ${roots.includes(projects) ? "handed" : "not handed"}), end ${end.reason}\n  ${records.filter((r) => /exit|sandbox|MOSS/.test(r)).map((r) => r.slice(0, 1_500)).join("\n  ")}`);
      expect(end.reason).toBe("end_turn");
      expect(roots).toContain(projects);
      // The working folder is written; the folder around it isn't this run.
      expect(readFileSync(join(work, "in.txt"), "utf8")).toBe("ok\n");
      expect(existsSync(join(projects, "beside.txt"))).toBe(false);
      // The command exited 0, and the bot still reads why it couldn't write beside it: the runtime's line and MOSS's.
      expect(all).toContain("[exit 0]");
      expect(all).toContain("not writable this run");
      expect(all).toContain("[MOSS] This computer's sandbox couldn't finish checking");
    } finally {
      await driver.stop();
    }
  }, 300_000);
});
