// Lane XC: a bot on Alpha works on Beta's files through a real turn (the embedded runtime, its scripted test model)
// with its plain tools: Read, Write, Glob and Bash on `home/Beta/…` run on Beta through the node's tree tools, and the
// driver's last PreToolUse hook answers each call (agent SDK 0.0.87's `toolResult`); the runtime's own tool never runs.
// Two computers on the fake link in one process (the host-level proof; the two-process proof is the `computers`
// acceptance unit).
import { afterEach, expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TurnControl, TurnInput } from "../../../src/contracts/session-host";
import type { BotSessionContext, EffectiveBot } from "../../../src/bots/service";
import { botPaths } from "../../../src/bots/paths";
import { BotSessionDriver, type BotDriverDeps } from "../../../src/runtime-sdk/turn-loop/driver";
import { Cluster, type TestComputer, until } from "../../tree/cluster-support";
import { answersFor, makePhone, type Phone } from "../../tree/answer-support";
import type { Level } from "@waifucave/moss-protocol";
import { NO_HOOKS, type TurnHooks } from "../../../src/runtime-sdk/turn-loop/hooks";
import { describeWithEmbeddedRuntime } from "../../helpers/embedded-runtime";
import { darwinTest } from "../../helpers/darwin-only";

let cluster: Cluster | undefined;
afterEach(() => { cluster?.close(); cluster = undefined; });

function control(): TurnControl {
  const ac = new AbortController();
  return { origin: "user", signal: ac.signal, onFold: () => () => {}, record: () => {} } as unknown as TurnControl;
}
const user = (text: string): TurnInput => ({ from: "user", text, device: "d_1", sentAt: Date.now(), clientMessageId: crypto.randomUUID() });
const results = (end: { text?: string }) => JSON.parse(end.text ?? "[]") as { name: string | null; isError: boolean; content: string }[];
const call = (tool: string, input: unknown) => `CALL ${tool} ${JSON.stringify(input)}`;

async function twoComputers(): Promise<{ alpha: TestComputer; beta: TestComputer }> {
  cluster = new Cluster();
  const alpha = await cluster.add("Alpha");
  const beta = await cluster.add("Beta");
  alpha.bots.push("luna");
  await cluster.join();
  // The user lets bots act on both without asking (each computer's own level, the holder's judging).
  await beta.node.registry.setLevel("Beta", "automatic", { via: "terminal" });
  await alpha.node.registry.setLevel("Alpha", "automatic", { via: "terminal" });
  await until(() => alpha.node.registry.get("Beta")?.level === "automatic", 5000, "Beta's level on Alpha");
  return { alpha, beta };
}

describeWithEmbeddedRuntime("a bot's tools on another computer's files (lane XC, the hand-off)", (spawn) => {
  function driverOn(c: TestComputer, o: { hooks?: TurnHooks; level?: Level; may?: { act: boolean } } = {}) {
    const bot: EffectiveBot = { id: "luna", name: "Luna", instructions: "You are Luna.", model: "winter-test/calls", modelFrom: "user", userLayer: [] };
    const ctx: BotSessionContext & { bot: EffectiveBot } = {
      bot, botId: "luna", sessionId: "b_luna", kind: "bot", computer: c.name, paths: botPaths(c.mossHome, "luna"),
      caller: { kind: "session", sessionId: "b_luna", sessionKind: "bot", bot: "luna" },
      current: () => bot, memoryBlock: () => "<memory>\nnothing yet\n</memory>",
      mayAct: () => o.may?.act ?? true, whenMayAct: async () => { if (!(o.may?.act ?? true)) throw new Error("paused"); }, cacheCold: () => false,
      ...(o.level === undefined ? {} : { level: o.level }),
    };
    mkdirSync(ctx.paths.scratch, { recursive: true });
    const allow: BotDriverDeps["canUseTool"] = () => async (_n, input) => ({ behavior: "allow", updatedInput: input as Record<string, unknown> });
    const n = c.node;
    return {
      ctx,
      driver: new BotSessionDriver(ctx, {
        home: c.mossHome, spawn, canUseTool: allow, sandbox: () => ({}), stopGraceMs: 5_000, log: () => {}, toolHoldMs: 200,
        ...(o.hooks === undefined ? {} : { hooks: o.hooks }),
        tree: { directory: n.peers.directory(), resolve: (p, as) => n.tree.resolve(p, as), names: () => n.registry.list().map((x) => x.name), tools: n.tools },
      }),
    };
  }

  darwinTest("Read, Write, Glob and Bash on Beta's files run on Beta; the runtime's own tool never touches Alpha's disk", async () => {
    const { alpha, beta } = await twoComputers();
    mkdirSync(join(beta.home, "project"), { recursive: true });
    writeFileSync(join(beta.home, "project", "notes.md"), "kept on Beta\n");
    const { ctx, driver } = driverOn(alpha);
    try {
      const r = results(await driver.turn(user([
        call("Read", { file_path: "home/Beta/project/notes.md" }),
        call("Write", { file_path: "home/Beta/project/new.md", content: "written from Alpha" }),
        call("Glossary", { load: ["Glob"] }),
        call("Glob", { pattern: "*.md", path: "home/Beta/project" }),
        call("Bash", { command: "cd home/Beta/project && pwd && ls" }),
        call("Bash", { command: "cat new.md" }),
        call("Bash", { command: "cd /tmp" }),
      ].join("\n")), control()));
      const [read, write, , glob, bashCd, bashSticky, back] = r;
      expect([read?.name, read?.isError]).toEqual(["Read", false]);
      expect(read?.content).toContain("kept on Beta");
      expect(write?.isError).toBe(false);
      expect(readFileSync(join(beta.home, "project", "new.md"), "utf8")).toBe("written from Alpha");
      expect(existsSync(join(ctx.paths.scratch, "home"))).toBe(false);
      expect(glob?.content).toContain("home/Beta/project/notes.md");
      expect(glob?.content).toContain("home/Beta/project/new.md");
      // The command ran in Beta's real folder: its output proves where.
      expect(bashCd?.content.split("\n")[0]).toBe("now on Beta: home/Beta/project");
      expect(bashCd?.content).toContain(realpathSync.native(join(beta.home, "project")));
      expect(bashSticky?.content).toContain("written from Alpha");
      expect(back?.isError).toBe(false);
    } finally {
      await driver.stop();
    }
  }, 90_000);

  darwinTest("a refusal on Beta comes back as a real error; Beta stopped answers \"computer offline\" at once", async () => {
    const { alpha, beta } = await twoComputers();
    const { driver } = driverOn(alpha);
    try {
      const first = results(await driver.turn(user([
        call("Read", { file_path: "home/Beta/.moss/credentials/key.json" }),
        call("Read", { file_path: "home/Beta/no-such-file.md" }),
      ].join("\n")), control()));
      expect(first[0]?.isError).toBe(true);
      expect(first[1]?.isError).toBe(true);
      // Beta drops off the network (its link gone, as when it is switched off).
      cluster!.net.partition(beta.device);
      await until(() => alpha.node.registry.get("Beta")?.state !== "online", 5000, "Beta offline on Alpha");
      const started = Date.now();
      const second = results(await driver.turn(user(call("Read", { file_path: "home/Beta/x.md" })), control()));
      expect(second[0]?.isError).toBe(true);
      expect(second[0]?.content).toContain("computer offline");
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      await driver.stop();
    }
  }, 90_000);

  // Step 3: approvals follow the files. Beta at its default level (ask for risky actions, no reviewer here: every
  // change asks); the card is Beta's own, shown through Alpha (askUser) and answered on the user's phone, signed; the
  // signed answer travels with the call and Beta checks it as itself.
  async function judgedComputers(phone: Phone): Promise<{ alpha: TestComputer; beta: TestComputer }> {
    cluster = new Cluster();
    const alpha = await cluster.add("Alpha", { answers: () => answersFor(phone), askUser: () => phone.ask });
    const beta = await cluster.add("Beta", { answers: () => answersFor(phone), askUser: () => phone.ask });
    alpha.bots.push("luna");
    await cluster.join();
    return { alpha, beta };
  }

  darwinTest("a write on Beta asks with Beta's own card; a yes writes it, a no keeps the file away", async () => {
    const phone = await makePhone();
    const { alpha, beta } = await judgedComputers(phone);
    const { driver } = driverOn(alpha);
    try {
      const yes = results(await driver.turn(user(call("Write", { file_path: "home/Beta/approved.md", content: "yes" })), control()));
      expect(yes[0]?.isError).toBe(false);
      expect(phone.shown.map((s) => s.computer)).toEqual(["Beta"]);
      expect(readFileSync(join(beta.home, "approved.md"), "utf8")).toBe("yes");
      phone.deny = true;
      const no = results(await driver.turn(user(call("Write", { file_path: "home/Beta/denied.md", content: "no" })), control()));
      expect(no[0]?.isError).toBe(true);
      expect(existsSync(join(beta.home, "denied.md"))).toBe(false);
    } finally {
      await driver.stop();
    }
  }, 90_000);

  darwinTest("a move between Alpha and Beta raises one card that binds both computers", async () => {
    const phone = await makePhone();
    const { alpha, beta } = await judgedComputers(phone);
    mkdirSync(join(alpha.home, "site"), { recursive: true });
    writeFileSync(join(alpha.home, "site", "index.html"), "<h1>hi</h1>");
    const { driver } = driverOn(alpha);
    try {
      const r = results(await driver.turn(user(call("Bash", { command: "mv home/Alpha/site home/Beta/" })), control()));
      expect(r[0]?.isError).toBe(false);
      expect(phone.shown).toHaveLength(1);
      expect(phone.shown[0]?.method).toBe("tree.transfer");
      expect(readFileSync(join(beta.home, "site", "index.html"), "utf8")).toBe("<h1>hi</h1>");
    } finally {
      await driver.stop();
    }
  }, 90_000);

  // The review of 1b (blockers 1 and 2, should-fixes 3 and 4).
  darwinTest("a plugin's rewrite is what runs on Beta; a plugin's ask makes Beta ask with its own card, even where Beta's level wouldn't", async () => {
    const phone = await makePhone();
    const { alpha, beta } = await judgedComputers(phone);
    await beta.node.registry.setLevel("Beta", "automatic", { via: "terminal" });
    await until(() => alpha.node.registry.get("Beta")?.level === "automatic", 5000, "Beta's level on Alpha");
    await alpha.node.registry.setLevel("Alpha", "automatic", { via: "terminal" });
    const hooks: TurnHooks = {
      ...NO_HOOKS,
      toolBefore: async (_s, tool, input) => {
        const i = input as Record<string, unknown>;
        if (tool.name === "Write" && String(i.file_path).endsWith("scrubbed.md")) return { input: { ...i, content: "SCRUBBED" } };
        if (tool.name === "Write" && String(i.file_path).endsWith("asked.md")) return { ask: "the plugin wants the user to see this", input };
        return { input };
      },
    };
    const { driver } = driverOn(alpha, { hooks });
    try {
      const r = results(await driver.turn(user([
        call("Write", { file_path: "home/Beta/scrubbed.md", content: "SECRET-TOKEN-123" }),
        call("Write", { file_path: "home/Beta/asked.md", content: "asked" }),
      ].join("\n")), control()));
      expect(r[0]?.isError).toBe(false);
      expect(readFileSync(join(beta.home, "scrubbed.md"), "utf8")).toBe("SCRUBBED");
      expect(phone.shown.map((s) => s.computer)).toEqual(["Beta"]);
      expect(r[1]?.isError).toBe(false);
      expect(readFileSync(join(beta.home, "asked.md"), "utf8")).toBe("asked");
    } finally {
      await driver.stop();
    }
  }, 90_000);

  darwinTest("a read-only session (a routine's level) writes nothing on Beta, whatever Beta's level", async () => {
    const { alpha, beta } = await twoComputers();
    const { driver } = driverOn(alpha, { level: "read-only" });
    try {
      const r = results(await driver.turn(user([
        call("Write", { file_path: "home/Beta/x.md", content: "no" }),
        call("Bash", { command: "cd home/Beta && touch made-by-bash" }),
        call("Read", { file_path: "home/Beta/x.md" }),
      ].join("\n")), control()));
      expect(r[0]?.isError).toBe(true);
      expect(r[1]?.isError).toBe(true);
      expect(existsSync(join(beta.home, "x.md"))).toBe(false);
      expect(existsSync(join(beta.home, "made-by-bash"))).toBe(false);
    } finally {
      await driver.stop();
    }
  }, 90_000);

  darwinTest("a bot whose level on Alpha is read-only writes nothing on Beta", async () => {
    const { alpha, beta } = await twoComputers();
    await alpha.node.registry.setLevel("Alpha", "read-only", { via: "terminal" });
    const { driver } = driverOn(alpha);
    try {
      const r = results(await driver.turn(user(call("Write", { file_path: "home/Beta/y.md", content: "no" })), control()));
      expect(r[0]?.isError).toBe(true);
      expect(existsSync(join(beta.home, "y.md"))).toBe(false);
    } finally {
      await driver.stop();
    }
  }, 90_000);

  darwinTest("paused while Beta's card is open: the call doesn't run after the yes", async () => {
    const phone = await makePhone();
    const { alpha, beta } = await judgedComputers(phone);
    const may = { act: true };
    // The person pauses the bots while the card is open (the phone records the card as it shows it), then answers yes.
    phone.shown.push = (...cards) => { may.act = false; return Array.prototype.push.apply(phone.shown, cards); };
    const { driver } = driverOn(alpha, { may });
    try {
      const r = results(await driver.turn(user(call("Write", { file_path: "home/Beta/paused.md", content: "no" })), control()));
      expect(phone.shown).toHaveLength(1);
      // The pause's own word for the call (the driver's, as for a local call held by the pause), and nothing written.
      expect(r[0]?.content).toContain("Stopped");
      expect(existsSync(join(beta.home, "paused.md"))).toBe(false);
    } finally {
      await driver.stop();
    }
  }, 90_000);

  darwinTest("a file tool's write on Beta to a place that runs later is refused before it goes", async () => {
    const { alpha, beta } = await twoComputers();
    mkdirSync(join(beta.home, "repo", ".git"), { recursive: true });
    const { driver } = driverOn(alpha);
    try {
      const r = results(await driver.turn(user(call("Write", { file_path: "home/Beta/repo/.git/config", content: "[core]\n" })), control()));
      expect(r[0]?.content).toContain("runs later");
      expect(existsSync(join(beta.home, "repo", ".git", "config"))).toBe(false);
    } finally {
      await driver.stop();
    }
  }, 90_000);

  darwinTest("mv of a small folder from Alpha to Beta takes the direct path", async () => {
    const { alpha, beta } = await twoComputers();
    mkdirSync(join(alpha.home, "site"), { recursive: true });
    writeFileSync(join(alpha.home, "site", "index.html"), "<h1>hi</h1>");
    const { driver } = driverOn(alpha);
    try {
      const r = results(await driver.turn(user(call("Bash", { command: "mv home/Alpha/site home/Beta/" })), control()));
      expect(r[0]?.isError).toBe(false);
      expect(readFileSync(join(beta.home, "site", "index.html"), "utf8")).toBe("<h1>hi</h1>");
      expect(existsSync(join(alpha.home, "site"))).toBe(false);
    } finally {
      await driver.stop();
    }
  }, 90_000);
});

