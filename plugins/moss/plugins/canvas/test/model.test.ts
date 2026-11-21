import { describe, expect, test } from "bun:test";
import { SAMPLE_SESSION_SCENE, SESSION_STATUSES, sceneAt, sessionMotion } from "@waifucave/moss-protocol";
import type { SessionView } from "@waifucave/moss-plugin-sdk";
import { MOSS_CORAL, modelLabel, motionOf, NEUTRAL, statusLine } from "../client/look";
import { buildModel, botBlockId, subBlockId } from "../client/model";
import { BACKENDS } from "../gallery/fixtures";

const looks = new Map(BACKENDS.map((b) => [b.id, b]));

describe("how a session moves", () => {
  test("motionOf is the protocol's sessionMotion for every status, with and without waiting", () => {
    for (const status of SESSION_STATUSES) {
      for (const waiting of [undefined, { tasks: 0, children: 0 }, { tasks: 1, children: 0 }, { tasks: 0, children: 2 }]) {
        expect([status, waiting, motionOf({ status, waiting })]).toEqual([status, waiting, sessionMotion({ status, waiting })]);
      }
    }
  });

  test("the status line: running wins over waiting, waiting names what, a card waiting says so", () => {
    expect(statusLine({ status: "prompting", waiting: { tasks: 2, children: 0 } })).toBe("Running");
    expect(statusLine({ status: "idle", waiting: { tasks: 2, children: 1 } })).toBe("Waiting · 2 background jobs, 1 session it started");
    expect(statusLine({ status: "idle" })).toBe("Idle");
    expect(statusLine({ status: "failed" })).toBe("Failed");
    expect(statusLine({ status: "idle", needsYou: { cards: 1, questions: 0 } })).toBe("Needs you");
    expect(statusLine({ status: "prompting", subagents: [{ id: "a", name: "x", state: "running", startedAt: 0 }] })).toBe("Running · 1 subagent");
  });

  test("a model id reads as a name", () => {
    expect(modelLabel("anthropic/claude-opus-5-5")).toBe("Claude Opus 5.5");
    expect(modelLabel("openai/gpt-6")).toBe("GPT 6");
    expect(modelLabel(undefined)).toBeUndefined();
  });
});

describe("the model of the sample scene", () => {
  const end = buildModel(sceneAt(SAMPLE_SESSION_SCENE, 20_000).sessions, looks);

  test("a block per code session, one per bot, one per subagent row; the bot's own conversation is not a block of its own", () => {
    expect(end.blocks.map((b) => [b.id, b.type]).sort()).toEqual([
      [botBlockId("moss"), "bot"], ["s_a", "main"], ["s_b", "main"], ["s_c", "main"], ["s_d", "main"], [subBlockId("s_a", "call_explore_1"), "sub"],
    ].sort() as [string, string][]);
    expect(end.blockOfSession("s_moss")).toBe(botBlockId("moss"));
  });

  test("who started it is its left point: the child hangs from s_a, the bot's agent from the bot, the subagent from s_a", () => {
    expect(end.byId.get("s_c")!.parent).toBe("s_a");
    expect(end.byId.get("s_d")!.parent).toBe(botBlockId("moss"));
    expect(end.byId.get(subBlockId("s_a", "call_explore_1"))!.parent).toBe("s_a");
    expect(end.byId.get("s_a")!.parent).toBeUndefined();
    expect(end.edges.map((e) => [e.kind, e.a, e.b]).sort()).toEqual([
      ["bot", botBlockId("moss"), "s_d"], ["child", "s_a", "s_c"], ["child", "s_a", subBlockId("s_a", "call_explore_1")],
    ].sort() as [string, string, string][]);
  });

  test("standard blocks: the title and agent · model · effort; the agent's colour; a bot is coral", () => {
    const a = end.byId.get("s_a")!;
    expect(a.title).toBe("Fix the login flow");
    expect(a.meta).toBe("Claude Code · Claude Opus 5.5 · high");
    expect(a.brand).toBe(looks.get("claude-code")!.color!);
    expect(end.byId.get(botBlockId("moss"))!.brand).toBe(MOSS_CORAL);
    // MOSS's own coding agent is coral when its record names no colour; an unknown backend is the neutral.
    const s = (id: string, backend: string): SessionView => ({ id, kind: "coding", computer: "c", status: "idle", startedAt: 1, updatedAt: 1, backend });
    const m = buildModel({ x: s("x", "moss-code"), y: s("y", "nobody") }, new Map());
    expect(m.byId.get("x")!.brand).toBe(MOSS_CORAL);
    expect(m.byId.get("y")!.brand).toBe(NEUTRAL);
  });

  test("motion through the scene: s_a runs at 1 s, waits on its child at 6 s, the child ends at 11 s; the bot runs while its conversation does", () => {
    const at = (t: number) => buildModel(sceneAt(SAMPLE_SESSION_SCENE, t).sessions, looks);
    expect(at(1_000).byId.get("s_a")!.motion).toBe("running");
    expect(at(6_000).byId.get("s_a")!.motion).toBe("waiting");
    expect(at(9_000).byId.get("s_a")!.motion).toBe("running");
    expect(at(11_000).byId.get("s_c")!.motion).toBe("ended");
    expect(at(6_500).byId.get(botBlockId("moss"))!.motion).toBe("running");
    expect(at(8_000).byId.get(botBlockId("moss"))!.motion).toBe("waiting");
    expect(at(8_000).byId.get("s_b")!.status).toBe("Waiting · 1 background job");
  });

  test("an archived session leaves the canvas, and a child of one becomes a root", () => {
    const st = sceneAt(SAMPLE_SESSION_SCENE, 20_000).sessions;
    const m = buildModel({ ...st, s_a: { ...st.s_a!, archived: true } }, looks);
    expect(m.byId.has("s_a")).toBe(false);
    expect(m.byId.get("s_c")!.parent).toBeUndefined();
  });

  test("a session from before revision 20 (no startedBy) hangs from its parent, or a bot's agent from its bot", () => {
    const v = (id: string, extra: Partial<SessionView>): SessionView => ({ id, kind: "agent", computer: "c", status: "idle", startedAt: 1, updatedAt: 1, ...extra });
    const m = buildModel({ p: v("p", { kind: "coding" }), c: v("c", { parent: "p" }), b: v("b", { bot: "alpha" }) }, new Map());
    expect(m.byId.get("c")!.parent).toBe("p");
    expect(m.byId.get("b")!.parent).toBe(botBlockId("alpha"));
    expect(m.byId.get(botBlockId("alpha"))!.title).toBe("Alpha");
  });
});
