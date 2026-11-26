// Lane XC 3c, the controller's ask on #95's review: what one Bash command costs a bot on Linux with today's write roots
// (`botSandboxSettings`: the home as one root at fully automatic, its ordinary top folders at accept edits), on the
// runtime MOSS ships now. The runtime walks every write root for its held patterns at every spawn, so each root adds
// its walk to each command. At each level, one Bash turn on a tiny home, then one on a home of 100 top folders (about
// 300,000 entries, a repo in every tenth, one pnpm tree); the difference is printed for the report (the cost a person
// already pays), and the bot's own folder must be written every time.
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

describeWithEmbeddedRuntime("a bot's Bash on Linux with today's write roots: what the held-names walk adds per command", (spawn) => {
  linuxTest("a home of 100 top folders (about 300,000 entries) against a tiny one, at fully automatic and at accept edits", async () => {
    const timeTurns = async (level: "automatic" | "accept-edits", folders: number, perFolder: number, turns = 2) => {
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
          mossHome, userHome: userDir, level, ownFolders: [c.paths.scratch, c.paths.root], pathFolders: [],
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
        for (let i = 0; i < turns; i++) {
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
      return { steady: ms[1], first: ms[0]!, roots, leftOut };
    };
    // The numbers are the point (the controller reads them): printed for each level, no bound, so both always print.
    // Fully automatic: two turns each (the second is the steady cost). Accept edits hands ~100 roots, each walked at
    // every spawn (the split measured 220 s a command), so it times one turn each, first against first, to stay inside
    // the shard's 20 minutes.
    const auto = { tiny: await timeTurns("automatic", 1, 10), big: await timeTurns("automatic", 100, 3_000) };
    console.log(`linux walk cost at automatic: tiny home ${auto.tiny.steady} ms (${auto.tiny.roots} roots), 100-folder home ${auto.big.steady} ms (${auto.big.roots} roots, ${auto.big.leftOut} left out), added per command ${auto.big.steady! - auto.tiny.steady!} ms`);
    const edits = { tiny: await timeTurns("accept-edits", 1, 10, 1), big: await timeTurns("accept-edits", 100, 3_000, 1) };
    console.log(`linux walk cost at accept-edits (first turns): tiny home ${edits.tiny.first} ms (${edits.tiny.roots} roots), 100-folder home ${edits.big.first} ms (${edits.big.roots} roots, ${edits.big.leftOut} left out), added per command ${edits.big.first - edits.tiny.first} ms`);
    expect([auto.big.leftOut, edits.big.leftOut]).toEqual([0, 0]);
  }, 1_100_000);
});
