// A bot's agent's `SendMessage` at each approval level (lane CM3; spec §9.2: a message to the bot's own sessions, or to a session whose
// level is no wider than the bot's, runs without asking at ask for risky actions; read only is absolute; ask asks; a wider target's a
// card every time). The bridge applies it as the same call in its bot's own session (`BridgeToolSource.judge`, the bots' approval
// check), at the target the rule resolved. A session the person drives is not asked (the spec gives nothing for it).
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { LEVELS, type Level } from "@waifucave/moss-protocol";
import { MossApprovalBroker } from "../../approvals/broker";
import { botApprovalCheck } from "../../approvals/bot-check";
import { FakeClock } from "../../contracts/fakes/clock";
import { agentToolJudge } from "../plugin-reach";
import { NO_PLUGIN_TOOLS, type AgentSessionFacts, type BridgeToolSource } from "../bridge/tools";
import { ExchangeDepths, EXCHANGE_DEPTH_LIMIT } from "../../sessions/exchange-depth";
import { waitFor, World } from "./world";

setDefaultTimeout(60_000);
let world: World | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

const FACTS: AgentSessionFacts = { id: "agent_x", kind: "agent", backend: "fake", bot: "alpha", computer: "Studio", root: "/tmp/x" };
const CTX = { computer: "Studio", origin: "user", bot: "alpha", session: FACTS } as const;

/** The judge over the real broker and the real approval check, with the levels given by computer and where `to` lands. */
function judgeAt(levels: Record<string, Level>, target: { own: boolean; computer: string }) {
  const broker = new MossApprovalBroker({ clock: new FakeClock(), levels: (c) => levels[c] ?? "read-only" });
  const check = botApprovalCheck(broker, {
    hostTools: () => ["SendMessage"], levelOf: (c) => levels[c],
    messageTarget: (_ctx, to) => ({ session: to, own: target.own, computer: target.computer, label: "the session" }),
  });
  const judge = agentToolJudge(check);
  const asked = (): Promise<"card" | "none"> => new Promise((resolve) => { const off = broker.watch((e) => { if (e.type === "requested") { off(); resolve("card"); } }); setTimeout(() => { off?.(); resolve("none"); }, 150); });
  return { broker, send: () => judge(FACTS, CTX, { served: "SendMessage", input: { to: "s_alpha", message: "hi" }, callId: "c1" }), asked };
}

describe("a bot's agent's SendMessage by the computer's level", () => {
  for (const [level, expected] of [["read-only", "refused"], ["ask", "card"], ["ask-risky", "allowed"], ["accept-edits", "allowed"], ["automatic", "allowed"]] as const) {
    test(`to the bot's own session at ${level}: ${expected}`, async () => {
      expect(LEVELS).toContain(level);
      const j = judgeAt({ Studio: level }, { own: true, computer: "Studio" });
      const asked = j.asked();
      const verdict = j.send();
      if (expected === "card") {
        expect(await asked).toBe("card");
        j.broker.cancelSession("agent_x");
        expect((await verdict).allowed).toBe(false);
      } else {
        const v = await verdict;
        expect(v.allowed).toBe(expected === "allowed");
        expect(await asked).toBe("none");
      }
    });
  }

  test("to a session on a computer of a wider level a card every time (ask for risky actions), to one of no wider level none", async () => {
    const wider = judgeAt({ Studio: "ask-risky", Big: "automatic" }, { own: false, computer: "Big" });
    const asked = wider.asked();
    const verdict = wider.send();
    expect(await asked).toBe("card");
    wider.broker.cancelSession("agent_x");
    expect((await verdict).allowed).toBe(false);
    const same = judgeAt({ Studio: "ask-risky", Same: "ask-risky" }, { own: false, computer: "Same" });
    expect((await same.send()).allowed).toBe(true);
  });
});

describe("the manager asks for a bot's agent's message, at the target the rule resolved, and never for a session the person drives", () => {
  const judged: { served: string; input: Record<string, unknown> }[] = [];
  const source = (verdict: { allowed: true } | { allowed: false; message: string }): BridgeToolSource => ({
    ...NO_PLUGIN_TOOLS,
    judge: async (_s, _ctx, call) => { judged.push({ served: call.served, input: call.input }); return verdict; },
  });
  const USER = { kind: "user", device: "d".repeat(16), clientMessageId: "m1" } as const;
  const BOT = { kind: "bot", bot: "alpha", session: "s_alpha", origin: "user" } as const;

  test("a refusal reaches the agent as the refusal, nothing is delivered, and the judge saw the session the message goes to", async () => {
    judged.length = 0;
    const w = (world = new World({ script: [[{ say: "ok" }]], pluginTools: source({ allowed: false, message: "SendMessage was refused: this computer's level doesn't allow it." }) }));
    const { sessionId } = await w.manager.start({ caller: BOT, backend: "fake", prompt: "Go.", root: "home/Studio/project1" });
    await waitFor(() => (w.host.get(sessionId)?.status === "idle" ? true : undefined), "the agent to be idle");
    const before = w.parentInputs("agent").length;
    const err = await w.manager.bridgeHandlers().sendMessage(sessionId, { text: "progress" }).catch((e: unknown) => e as Error);
    expect((err as Error).message).toBe("SendMessage was refused: this computer's level doesn't allow it.");
    expect(w.parentInputs("agent").length).toBe(before);
    expect(judged).toEqual([{ served: "SendMessage", input: { to: "s_alpha", message: "progress" } }]);
  });

  test("an allowed one is delivered; the judge is asked once", async () => {
    judged.length = 0;
    const w = (world = new World({ script: [[{ say: "ok" }]], pluginTools: source({ allowed: true }) }));
    const { sessionId } = await w.manager.start({ caller: BOT, backend: "fake", prompt: "Go.", root: "home/Studio/project1" });
    await waitFor(() => (w.host.get(sessionId)?.status === "idle" ? true : undefined), "the agent to be idle");
    const before = w.parentInputs("agent").length;
    await w.manager.bridgeHandlers().sendMessage(sessionId, { text: "progress" });
    expect(w.parentInputs("agent").length).toBe(before + 1);
    expect(judged.length).toBe(1);
  });

  test("with no approvals wired on this computer a bot's agent's message is refused, not sent without the ask", async () => {
    const w = (world = new World({ script: [[{ say: "ok" }]], noApprovals: true }));
    const { sessionId } = await w.manager.start({ caller: BOT, backend: "fake", prompt: "Go.", root: "home/Studio/project1" });
    await waitFor(() => (w.host.get(sessionId)?.status === "idle" ? true : undefined), "the agent to be idle");
    const before = w.parentInputs("agent").length;
    const err = await w.manager.bridgeHandlers().sendMessage(sessionId, { text: "progress" }).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain("approvals aren't running");
    expect(w.parentInputs("agent").length).toBe(before);
  });

  test("an agent a bot starts begins at the starting session's depth + 1, never at a fresh 0, and never past the limit", async () => {
    for (const [at, begins] of [[0, 1], [3, 4], [EXCHANGE_DEPTH_LIMIT - 1, EXCHANGE_DEPTH_LIMIT], [EXCHANGE_DEPTH_LIMIT, EXCHANGE_DEPTH_LIMIT]] as const) {
      const depths = new ExchangeDepths();
      depths.turnStarted("s_alpha", { from: "session", session: "s_other", text: "x", depth: at });
      const w = (world = new World({ script: [[{ say: "ok" }]], depths }));
      const { sessionId } = await w.manager.start({ caller: BOT, backend: "fake", prompt: "Go.", root: "home/Studio/project1" });
      const first = w.host.history(sessionId).find((r) => r.type === "input");
      expect([at, first?.type === "input" ? (first.input as { depth?: number }).depth : undefined]).toEqual([at, begins]);
      await world.close();
    }
  });

  test("a coding session the person started is not asked", async () => {
    judged.length = 0;
    const w = (world = new World({ script: [[{ say: "ok" }]], pluginTools: source({ allowed: false, message: "no" }) }));
    const a = await w.manager.start({ caller: USER, backend: "fake", prompt: "Hi.", root: "home/Studio/project1", title: "One" });
    const b = await w.manager.start({ caller: { ...USER, clientMessageId: "m2" }, backend: "fake", prompt: "Hi.", root: "home/Studio/project1", title: "Two" });
    await waitFor(() => (w.host.get(a.sessionId)?.status === "idle" && w.host.get(b.sessionId)?.status === "idle" ? true : undefined), "both idle");
    await w.manager.bridgeHandlers().sendMessage(a.sessionId, { text: "hello", to: b.sessionId });
    expect(judged).toEqual([]);
  });
});
