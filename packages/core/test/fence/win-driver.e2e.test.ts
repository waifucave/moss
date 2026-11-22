// The runtime seam on Windows (lane WS): a bot's session opened by the real driver on the real embedded runtime, with
// the runtime's scripted test model, is offered the core's Bash and PowerShell (`fence/win-shell-tools.ts`) under their
// plain names in place of the runtime's own (`BOT_BUILTIN_TOOLS` leaves them out on Windows; `shadowBuiltins`). A call
// reaches the fenced spawner with the session's sandbox; a call asking to leave the sandbox reaches the permission
// check (`canUseTool`, where bot-check raises its escape card) under the plain name, with the flag, before it runs.
//
// Windows only (the windows-fence workflow's unit job); the spawner is a recording fake, the fence itself is proven by
// win-fenced.e2e.test.ts.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnControl, TurnInput } from "../../src/contracts/session-host";
import type { BotSessionContext, EffectiveBot } from "../../src/bots/service";
import { botPaths } from "../../src/bots/paths";
import { BotSessionDriver, type BotDriverDeps } from "../../src/runtime-sdk/turn-loop/driver";
import { windowsShellTools } from "../../src/fence/win-shell-tools";
import type { FencedRun, FencedSpawner } from "../../src/fence/spawn";
import { describeWithEmbeddedRuntime } from "../helpers/embedded-runtime";

const onWindows = process.platform === "win32";
const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });

function control(): TurnControl {
  const ac = new AbortController();
  return { origin: "user", signal: ac.signal, onFold: () => () => {}, record: () => {} } as unknown as TurnControl;
}
const user = (text: string): TurnInput => ({ from: "user", text, device: "d_1", sentAt: Date.now(), clientMessageId: crypto.randomUUID() });
const results = (end: { text?: string }) => JSON.parse(end.text ?? "[]") as { name: string | null; isError: boolean; content: string }[];

(onWindows ? describeWithEmbeddedRuntime : (name: string, fn: (spawn: never) => void) => describe.skip(name, () => fn(undefined as never)))("the Windows shell tools through the bot driver (windows-latest)", (spawn) => {
  test("the session is offered the core's Bash and PowerShell; a call runs fenced; an escape reaches the permission check first", async () => {
    const home = mkdtempSync(join(tmpdir(), "moss-ws-drv-"));
    temps.push(home);
    const paths = botPaths(home, "luna");
    mkdirSync(paths.scratch, { recursive: true });
    const bot: EffectiveBot = { id: "luna", name: "Luna", instructions: "You are Luna.", model: "winter-test/calls", modelFrom: "user", userLayer: [] };
    const ctx: BotSessionContext & { bot: EffectiveBot } = {
      bot, botId: "luna", sessionId: "b_luna", kind: "bot", computer: "Studio", paths,
      caller: { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" },
      current: () => bot, memoryBlock: () => "<memory>\nnothing yet\n</memory>",
      mayAct: () => true, whenMayAct: async () => {}, cacheCold: () => false,
    };
    const runs: FencedRun[] = [];
    const spawner: FencedSpawner = { available: true, run: async (r) => { runs.push(r); return { kind: "exited", code: 0, stdout: `fenced ${r.shell}\n`, stderr: "", shell: "git-bash" }; } };
    const SANDBOX = { filesystem: { allowWrite: [paths.scratch], denyWrite: [join(home, "settings.json")], denyRead: [join(home, "run")] } };
    const core = windowsShellTools({ spawner, caller: ctx.caller, kind: "bot", cwd: () => paths.scratch, sandbox: () => SANDBOX, userHome: home, temp: tmpdir(), mossHome: home });
    const asked: { name: string; input: Record<string, unknown> }[] = [];
    const deps: BotDriverDeps = {
      home, spawn,
      canUseTool: () => async (name, input) => { asked.push({ name, input: input as Record<string, unknown> }); return { behavior: "allow", updatedInput: input as Record<string, unknown> }; },
      sandbox: () => ({ enabled: false }),
      stopGraceMs: 5_000,
      coreTools: () => core,
      log: (l) => { if (process.env.WS_DEBUG) console.error(l); },
    };
    const driver = new BotSessionDriver(ctx, deps);
    try {
      const end = await driver.turn(user([
        'CALL Bash {"command":"echo hi"}',
        'CALL PowerShell {"command":"Get-Date"}',
        'CALL Bash {"command":"echo out > ~/x","dangerouslyDisableSandbox":true}',
      ].join("\n")), control());
      const r = results(end);
      console.log(`[driver] results: ${JSON.stringify(r)}; asked: ${JSON.stringify(asked.map((a) => [a.name, a.input.dangerouslyDisableSandbox ?? false]))}`);
      expect(r.map((x) => [x.name, x.isError])).toEqual([["Bash", false], ["PowerShell", false], ["Bash", false]]);
      expect(r[0]!.content).toContain("fenced bash");
      expect(r[1]!.content).toContain("fenced powershell");
      // Every call ran through the core's tool, with the session's sandbox (the escape's widened one for the last).
      expect(runs.map((x) => x.shell)).toEqual(["bash", "powershell", "bash"]);
      expect(runs[0]!.sandbox).toEqual(SANDBOX);
      expect(runs[2]!.sandbox!.filesystem!.allowWrite).toContain(home);
      // The escape was asked about under the plain name, with the flag, before it ran.
      const escape = asked.find((a) => a.input.dangerouslyDisableSandbox === true);
      expect(escape?.name).toBe("Bash");
    } finally {
      await driver.stop();
    }
  }, 240_000);
});
