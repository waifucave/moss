// Lane XC (the controller's ruling on #98: parity by the simplest rule): on Linux a bot's sandboxed `git init` at fully
// automatic ends as on macOS. MOSS holds every `.git` whole, so the agent runtime (0.0.91) moves the new `.git` aside at
// the command's end and says so; MOSS adds what to do (`NEW_REPO_ADVICE`: run it outside the sandbox). Then the route
// outside the sandbox (Bash with dangerouslyDisableSandbox, allowed here as the person's yes would) makes a repository
// that works.
//
// Run only: scripts/pinned-bun test packages/core/test/runtime-sdk/turn-loop/linux-new-repo.e2e.test.ts (Linux, CI).
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnControl, TurnInput } from "../../../src/contracts/session-host";
import type { BotSessionContext, EffectiveBot } from "../../../src/bots/service";
import { botPaths } from "../../../src/bots/paths";
import { BotSessionDriver, NEW_REPO_ADVICE, newRepoNote, type BotDriverDeps } from "../../../src/runtime-sdk/turn-loop/driver";
import { MossFence } from "../../../src/fence/fence";
import { botSandboxSettings } from "../../../src/fence/sandbox-settings";
import { describeWithEmbeddedRuntime } from "../../helpers/embedded-runtime";

const temps: string[] = [];
afterAll(() => { for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true }); });
const linuxTest = process.platform === "linux" ? test : test.skip;

function control(into: string[]): TurnControl {
  const ac = new AbortController();
  return { origin: "user", signal: ac.signal, onFold: () => () => {}, record: (e) => { into.push(JSON.stringify(e).slice(0, 4_000)); } };
}
const user = (text: string): TurnInput => ({ from: "user", text, device: "d_1", sentAt: Date.now(), clientMessageId: crypto.randomUUID() });

test("newRepoNote: after the runtime's line for a moved .git, the advice; nothing on other lines", () => {
  const r = newRepoNote({ stdout: "done\n", stderr: "\n[sandbox] /w/p/.git: moved to /h/.moss/quarantine at the command's end (a repository can't be made at a protected path inside the sandbox); writing it again is moved aside again\n" }) as { stderr: string };
  expect(r.stderr.endsWith(NEW_REPO_ADVICE)).toBe(true);
  expect(newRepoNote({ stdout: "", stderr: "[sandbox] /w/.husky: moved to /q at the command's end (it runs later, outside the sandbox)" })).toBeUndefined();
  expect(newRepoNote("ok")).toBeUndefined();
});

describeWithEmbeddedRuntime("a bot's git init on Linux at fully automatic", (spawn) => {
  linuxTest("sandboxed: the new .git is moved aside and the bot is told to run it outside; outside the sandbox: a working repository", async () => {
    const userDir = realpathSync(mkdtempSync(join(tmpdir(), "moss-new-repo-")));
    temps.push(userDir);
    const mossHome = join(userDir, ".moss");
    const temp = join(userDir, "tmp-moss");
    const work = join(userDir, "work");
    for (const d of [mossHome, temp, work]) mkdirSync(d, { recursive: true });
    writeFileSync(join(mossHome, "settings.json"), "{}\n");
    const bot: EffectiveBot = { id: "luna", name: "Luna", instructions: "You are Luna.", model: "winter-test/calls", modelFrom: "user", userLayer: [] };
    const ctx: BotSessionContext & { bot: EffectiveBot } = {
      bot, botId: "luna", sessionId: "b_luna", kind: "bot", computer: "Studio", paths: botPaths(mossHome, "luna"),
      caller: { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" },
      current: () => bot, memoryBlock: () => "<memory>\nnothing yet\n</memory>",
      mayAct: () => true, whenMayAct: async () => {}, cacheCold: () => false,
    };
    mkdirSync(ctx.paths.scratch, { recursive: true });
    mkdirSync(ctx.paths.root, { recursive: true });
    const fence = new MossFence({ os: "linux", home: userDir, mossHome, temp });
    const deps: BotDriverDeps = {
      home: mossHome, spawn,
      // The person's yes to the outside-the-sandbox card, as fully automatic's reviewer or the card gives it.
      canUseTool: () => async (_name, input) => ({ behavior: "allow", updatedInput: input as Record<string, unknown> }),
      sandbox: (c) => botSandboxSettings(fence.forCaller(c.caller).policy(), { mossHome, userHome: userDir, level: "automatic", ownFolders: [c.paths.scratch, c.paths.root], pathFolders: [] }),
      stopGraceMs: 5_000, log: () => {},
    };
    const driver = new BotSessionDriver(ctx, deps);
    const git = "git -c user.email=t@example.invalid -c user.name=t";
    try {
      const inside: string[] = [];
      const cmd = `cd ${JSON.stringify(work)} && mkdir p && cd p && git init -q && echo a > f && echo done`;
      expect((await driver.turn(user(`CALL Bash ${JSON.stringify({ command: cmd, description: "make a repo" })}`), control(inside))).reason).toBe("end_turn");
      expect(existsSync(join(work, "p", ".git"))).toBe(false);
      expect(existsSync(join(work, "p", "f"))).toBe(true);
      const told = inside.join("\n");
      expect(told).toContain(`${join(work, "p", ".git")}: moved to`);
      expect(told).toContain(JSON.stringify(NEW_REPO_ADVICE).slice(1, 60));
      // The route outside the sandbox: the same command, out of it.
      const outside: string[] = [];
      const out = `cd ${JSON.stringify(join(work, "p"))} && git init -q && git add f && ${git} commit -qm one && echo done`;
      expect((await driver.turn(user(`CALL Bash ${JSON.stringify({ command: out, description: "make a repo outside the sandbox", dangerouslyDisableSandbox: true })}`), control(outside))).reason).toBe("end_turn");
      expect(existsSync(join(work, "p", ".git", "HEAD"))).toBe(true);
      const log = spawnSync("git", ["-C", join(work, "p"), "log", "--oneline"], { encoding: "utf8" });
      expect(log.status).toBe(0);
      expect(log.stdout.trim().split("\n").length).toBe(1);
    } finally {
      await driver.stop();
    }
  }, 300_000);
});
