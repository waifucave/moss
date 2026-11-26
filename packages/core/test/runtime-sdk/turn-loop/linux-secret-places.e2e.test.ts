// Lane XC: on Linux at fully automatic, a bot's Bash under the agent runtime's real bubblewrap can't write or read the
// secret places in the user's home (~/.ssh, ~/.aws, ~/.gnupg, ~/.config/gh), as MOSS draws the sandbox
// (`botSandboxSettings`). Dummies only: each place holds a file with a dummy value; the test reports only whether the
// value reached the bot's output and whether a written file appeared.
//
// Run only: scripts/pinned-bun test packages/core/test/runtime-sdk/turn-loop/linux-secret-places.e2e.test.ts (Linux, CI).
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
const DUMMY = "PROBE_SECRET=dummy123";
const PLACES = [".ssh", ".aws", ".gnupg", ".config/gh"] as const;

function control(into: string[]): TurnControl {
  const ac = new AbortController();
  return { origin: "user", signal: ac.signal, onFold: () => () => {}, record: (e) => { into.push(JSON.stringify(e)); } };
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

describeWithEmbeddedRuntime("a bot's Bash at fully automatic on Linux: the home's secret places stay shut", (spawn) => {
  linuxTest("no write lands in ~/.ssh, ~/.aws, ~/.gnupg or ~/.config/gh, and no dummy secret there reaches the output", async () => {
    const userDir = realpathSync(mkdtempSync(join(tmpdir(), "moss-secret-places-")));
    temps.push(userDir);
    const mossHome = join(userDir, ".moss");
    mkdirSync(mossHome, { recursive: true });
    writeFileSync(join(mossHome, "settings.json"), "{}\n");
    mkdirSync(join(userDir, "Documents"), { recursive: true });
    for (const p of PLACES) {
      mkdirSync(join(userDir, p), { recursive: true });
      writeFileSync(join(userDir, p, "id_ed25519"), `${DUMMY}\n`);
    }
    const temp = join(userDir, "tmp-moss");
    mkdirSync(temp, { recursive: true });
    const ctx = context(mossHome);
    mkdirSync(ctx.paths.scratch, { recursive: true });
    mkdirSync(ctx.paths.root, { recursive: true });
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
    const results: Record<string, { wrote: boolean; read: boolean; root: boolean }> = {};
    try {
      for (const p of PLACES) {
        const dir = join(userDir, p);
        const records: string[] = [];
        const command = `echo planted >> ${JSON.stringify(join(dir, "authorized_keys"))}; cat ${JSON.stringify(join(dir, "id_ed25519"))}; echo done`;
        const end = await driver.turn(user(`CALL Bash ${JSON.stringify({ command, description: "try a secret place" })}`), control(records));
        expect(end.reason).toBe("end_turn");
        results[p] = { wrote: existsSync(join(dir, "authorized_keys")), read: records.some((r) => r.includes(DUMMY)), root: roots.includes(dir) };
      }
      // The bot's own folder is writable in the same session (the sandbox ran, the denies are what held).
      const own = join(ctx.paths.scratch, "own.txt");
      await driver.turn(user(`CALL Bash ${JSON.stringify({ command: `echo ok > ${JSON.stringify(own)}`, description: "own folder" })}`), control([]));
      results.own = { wrote: existsSync(own) && readFileSync(own, "utf8") === "ok\n", read: false, root: true };
    } finally {
      await driver.stop();
    }
    // True/false only: never the dummy value itself.
    console.log(`linux secret places at automatic: ${JSON.stringify(results)}`);
    for (const p of PLACES) expect([p, results[p]]).toEqual([p, { wrote: false, read: false, root: false }]);
    expect(results.own?.wrote).toBe(true);
  }, 300_000);
});
