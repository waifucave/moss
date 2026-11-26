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

/** A turn's control; what the driver records (the tool's result with the runtime's note among it) goes to `into`. */
function control(into?: string[]): TurnControl {
  const ac = new AbortController();
  return { origin: "user", signal: ac.signal, onFold: () => () => {}, record: (e) => { into?.push(JSON.stringify(e).slice(0, 2_000)); } };
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
        const t = Date.now();
        const s = botSandboxSettings(fence.forCaller(c.caller).policy(), {
          mossHome, userHome: userDir, level, ownFolders: [c.paths.scratch, c.paths.root], pathFolders: [],
        });
        roots = s.filesystem?.allowWrite?.length ?? 0;
        leftOut = leftOutRoots(s).length;
        const dw = s.filesystem?.denyWrite ?? [];
        logs.push(`MOSS's sandbox drawn in ${Date.now() - t} ms: ${roots} roots, ${dw.length} write denies (${dw.filter((d) => d.includes("*")).length} globs), ${(s.filesystem?.denyRead ?? []).length} read denies`);
        return s;
      };
      const deps: BotDriverDeps = {
        home: mossHome, spawn,
        canUseTool: () => async (_name, input) => ({ behavior: "allow", updatedInput: input as Record<string, unknown> }),
        // The driver's and the runtime's own lines, printed with each turn (lane XC: the 0.0.89 run showed none).
        sandbox, stopGraceMs: 5_000, log: (l) => { logs.push(l.slice(0, 1_000)); },
      };
      const logs: string[] = [];
      const driver = new BotSessionDriver(ctx, deps);
      const out = join(ctx.paths.scratch, "written.txt");
      const ms: number[] = [];
      try {
        // Two turns: the first opens the runtime, the second is the steady cost of one command.
        for (let i = 0; i < turns; i++) {
          rmSync(out, { force: true });
          const records: string[] = [];
          logs.length = 0;
          const start = Date.now();
          const end = await driver.turn(user(`CALL Bash ${JSON.stringify({ command: `echo ok > ${JSON.stringify(out)}`, description: "time one command" })}`), control(records));
          ms.push(Date.now() - start);
          const written = existsSync(out) ? readFileSync(out, "utf8") : "";
          // Printed before any check, so a failed turn still says what the tool answered and how long it took.
          console.log(`linux walk cost turn (${level}, ${folders} folders, turn ${i + 1}): ${ms.at(-1)} ms, ${roots} roots, written ${JSON.stringify(written)}, end ${end.reason}`
            + `\n  records: ${records.filter((r) => /tool|result|sandbox/i.test(r)).join("\n  ")}\n  logs: ${logs.join("\n  ")}`);
          expect(end.reason).toBe("end_turn");
          expect(written).toBe("ok\n");
        }
      } finally {
        await driver.stop();
      }
      return { steady: ms[1], first: ms[0]!, roots, leftOut };
    };
    // The numbers are the point (the controller reads them): printed, no bound. With the MOSS home inside the user's
    // home, fully automatic already draws the home as its entries (sandboxSettingsOf's `except`), about 100 roots
    // here, each walked at every spawn: one command cost about 300 s on run 45833809470, so the 20-minute shard holds
    // one timed turn per home (first against first, each opening the runtime). Accept edits draws the home's ordinary
    // top folders: its roots are counted (on the same layout, with few files) rather than timed again; the same roots
    // cost the same walk.
    const auto = { tiny: await timeTurns("automatic", 1, 10, 1), big: await timeTurns("automatic", 100, 3_000, 1) };
    console.log(`linux walk cost at automatic: tiny home ${auto.tiny.first} ms (${auto.tiny.roots} roots), 100-folder home ${auto.big.first} ms (${auto.big.roots} roots, ${auto.big.leftOut} left out), added per command ${auto.big.first - auto.tiny.first} ms`);
    const rootsAt = (level: "automatic" | "accept-edits") => {
      const { userDir, mossHome } = homeShaped(100, 10);
      const temp = join(userDir, "tmp-moss");
      mkdirSync(temp, { recursive: true });
      const own = botPaths(mossHome, "luna");
      const fence = new MossFence({ os: "linux", home: userDir, mossHome, temp });
      const s = botSandboxSettings(fence.forCaller(context(mossHome).caller).policy(), { mossHome, userHome: userDir, level, ownFolders: [own.scratch, own.root], pathFolders: [] });
      return s.filesystem?.allowWrite?.length ?? 0;
    };
    console.log(`linux walk cost at accept-edits: the same 100-folder layout draws ${rootsAt("accept-edits")} roots (fully automatic ${rootsAt("automatic")})`);
    expect(auto.big.leftOut).toBe(0);
    // Agent runtime 0.0.89 walks the roots on one budget per command (400,000 entries, 3 s) and fails closed past it:
    // the ~300 s a command on 0.0.88 is now about a second; 10 s is the bound, the bot's own folder written either way.
    expect(auto.big.first - auto.tiny.first).toBeLessThan(10_000);
  }, 1_000_000);
});
