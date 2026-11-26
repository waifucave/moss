// Lane XC 3c, the controller's ask on #95's review: what one Bash command costs a bot at fully automatic on Linux when
// MOSS hands the runtime its home as top folders (`botSandboxSettings`, `homeTopFolders`), on the runtime MOSS ships
// now. The runtime walks every write root for its held patterns at every spawn, so a home of many top folders adds that
// walk to each command. One Bash turn on a tiny home, then one on a home of 100 top folders (about 300,000 entries, a
// repo in every tenth, one pnpm tree); the difference is printed for the report, and the bot's own folder must be
// written in both.
//
// Run only: scripts/pinned-bun test packages/core/test/runtime-sdk/turn-loop/linux-walk-cost.e2e.test.ts (Linux, CI).
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnControl, TurnInput } from "../../../src/contracts/session-host";
import type { BotSessionContext, EffectiveBot } from "../../../src/bots/service";
import { botPaths } from "../../../src/bots/paths";
import { BotSessionDriver, type BotDriverDeps } from "../../../src/runtime-sdk/turn-loop/driver";
import { MossFence } from "../../../src/fence/fence";
import { botSandboxSettings, leftOutRoots } from "../../../src/fence/sandbox-settings";
import { describeWithEmbeddedRuntime } from "../../helpers/embedded-runtime";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const linuxTest = process.platform === "linux" ? test : test.skip;

function control(): TurnControl {
  const ac = new AbortController();
  return { origin: "user", signal: ac.signal, onFold: () => () => {}, record: () => {} };
}

function context(home: string): BotSessionContext & { bot: EffectiveBot } {
  const bot: EffectiveBot = { id: "luna", name: "Luna", instructions: "You are Luna.", model: "winter-test/calls", modelFrom: "user", userLayer: [] };
  return {
    bot, botId: "luna", sessionId: "b_luna", kind: "bot", computer: "Studio", paths: botPaths(home, "luna"),
    caller: { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" },
    current: () => bot, memoryBlock: () => "<memory>\nnothing yet\n</memory>",
    mayAct: () => true, whenMayAct: async () => {}, cacheCold: () => false,
  };
}

const user = (text: string): TurnInput => ({ from: "user", text, device: "d_1", sentAt: Date.now(), clientMessageId: crypto.randomUUID() });

/** A user's home with `folders` top folders of `perFolder` entries, a repo in every tenth, one pnpm tree; the MOSS home
 *  inside it (`.moss`), as on a real computer. */
function homeShaped(folders: number, perFolder: number): { userDir: string; mossHome: string } {
  const userDir = realpathSync(mkdtempSync(join(tmpdir(), "moss-walk-cost-")));
  temps.push(userDir);
  for (let f = 0; f < folders; f++) {
    const top = join(userDir, `top${f}`);
    const sub = join(top, "a", "b");
    mkdirSync(sub, { recursive: true });
    for (let i = 0; i < perFolder; i++) writeFileSync(join(i % 2 === 0 ? top : sub, `f${i}`), "");
    if (f % 10 === 0) mkdirSync(join(top, "repo", ".git", "hooks"), { recursive: true });
  }
  if (folders > 1) {
    let at = join(userDir, "top1", "app", "node_modules", ".pnpm", "pkg@1.0.0", "node_modules", "pkg");
    for (let d = 0; d < 30; d++) at = join(at, "node_modules", `dep${d}`);
    mkdirSync(at, { recursive: true });
  }
  const mossHome = join(userDir, ".moss");
  mkdirSync(mossHome, { recursive: true });
  writeFileSync(join(mossHome, "settings.json"), "{}\n");
  return { userDir, mossHome };
}

describeWithEmbeddedRuntime("a bot's Bash at fully automatic on Linux: what the held-names walk adds per command", (spawn) => {
  linuxTest("a home of 100 top folders (about 300,000 entries) against a tiny one: the added time per command", async () => {
    const timeTurns = async (folders: number, perFolder: number) => {
      const { userDir, mossHome } = homeShaped(folders, perFolder);
      const temp = join(userDir, "tmp-moss");
      mkdirSync(temp, { recursive: true });
      const ctx = context(mossHome);
      mkdirSync(ctx.paths.scratch, { recursive: true });
      mkdirSync(ctx.paths.root, { recursive: true });
      const fence = new MossFence({ os: "linux", home: userDir, mossHome, temp });
      let roots = 0;
      let leftOut = 0;
      const sandbox = (c: BotSessionContext) => {
        const s = botSandboxSettings(fence.forCaller(c.caller).policy(), {
          mossHome, userHome: userDir, level: "automatic", ownFolders: [c.paths.scratch, c.paths.root], pathFolders: [],
        });
        roots = s.filesystem?.allowWrite?.length ?? 0;
        leftOut = leftOutRoots(s).length;
        return s;
      };
      const deps: BotDriverDeps = {
        home: mossHome, spawn,
        canUseTool: () => async (_name, input) => ({ behavior: "allow", updatedInput: input as Record<string, unknown> }),
        sandbox, stopGraceMs: 5_000, log: () => {},
      };
      const driver = new BotSessionDriver(ctx, deps);
      const out = join(ctx.paths.scratch, "written.txt");
      const ms: number[] = [];
      try {
        // Two turns: the first opens the runtime, the second is the steady cost of one command.
        for (let i = 0; i < 2; i++) {
          rmSync(out, { force: true });
          const start = Date.now();
          const end = await driver.turn(user(`CALL Bash ${JSON.stringify({ command: `echo ok > ${JSON.stringify(out)}`, description: "time one command" })}`), control());
          ms.push(Date.now() - start);
          expect(end.reason).toBe("end_turn");
          expect(existsSync(out) ? readFileSync(out, "utf8") : "").toBe("ok\n");
        }
      } finally {
        await driver.stop();
      }
      return { steady: ms[1]!, first: ms[0]!, roots, leftOut };
    };
    const tiny = await timeTurns(1, 10);
    const big = await timeTurns(100, 3_000);
    const added = big.steady - tiny.steady;
    console.log(`linux walk cost: tiny home ${tiny.steady} ms (${tiny.roots} roots), 100-folder home ${big.steady} ms (${big.roots} roots, ${big.leftOut} left out), added per command ${added} ms`);
    // The number is the point (the controller reads it); a bound so a runaway walk shows red.
    expect(added).toBeLessThan(60_000);
  }, 600_000);
});
