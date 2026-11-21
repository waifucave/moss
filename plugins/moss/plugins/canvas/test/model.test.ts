import { describe, expect, test } from "bun:test";
import { SAMPLE_SESSION_SCENE, sceneAt } from "../gallery/scene";
import type { SessionView } from "@waifucave/moss-plugin-sdk";
import { isGlyph, MOSS_CODE_GOLD, MOSS_CORAL, modelLabel, motionOf, statusLine } from "../client/look";
import { buildModel, botBlockId, subBlockId } from "../client/model";
import { BACKENDS } from "../gallery/fixtures";

const looks = new Map(BACKENDS.map((b) => [b.id, b]));

describe("how a session moves", () => {
  test("motionOf follows the protocol's sessionMotion: running wins, then waiting, then still; stopped and failed end", () => {
    const busy = { tasks: 1, children: 0 };
    for (const status of ["starting", "prompting", "cancelling"]) expect([status, motionOf({ status, waiting: busy })]).toEqual([status, "running"]);
    for (const status of ["ready", "idle"]) {
      expect([status, motionOf({ status, waiting: busy })]).toEqual([status, "waiting"]);
      expect([status, motionOf({ status, waiting: { tasks: 0, children: 2 } })]).toEqual([status, "waiting"]);
      expect([status, motionOf({ status, waiting: { tasks: 0, children: 0 } })]).toEqual([status, "still"]);
      expect([status, motionOf({ status })]).toEqual([status, "still"]);
    }
    for (const status of ["stopped", "failed"]) expect([status, motionOf({ status, waiting: busy })]).toEqual([status, "ended"]);
  });

  test("the status line: running wins over waiting, waiting names what, a card waiting says so", () => {
    expect(statusLine({ status: "prompting", waiting: { tasks: 2, children: 0 } })).toBe("Running");
    expect(statusLine({ status: "idle", waiting: { tasks: 2, children: 1 } })).toBe("Waiting · 2 background jobs, 1 session it started");
    expect(statusLine({ status: "idle" })).toBe("Idle");
    expect(statusLine({ status: "failed" })).toBe("Failed");
    expect(statusLine({ status: "idle", needsYou: { cards: 1, questions: 0 } })).toBe("Needs you");
    expect(statusLine({ status: "prompting", subagents: [{ id: "a", name: "x", state: "running", startedAt: 0 }] })).toBe("Running · 1 subagent");
  });

  test("a one-colour glyph (an SVG in currentColor) is told from an icon in its own colours", () => {
    const svg = (body: string) => ({ mediaType: "image/svg+xml" as const, data: btoa(body), at: 0 });
    expect(isGlyph(svg('<svg><path fill="currentColor"/></svg>'))).toBe(true);
    expect(isGlyph(svg('<svg><path fill="#D97757"/></svg>'))).toBe(false);
    expect(isGlyph({ mediaType: "image/png", data: "", at: 0 })).toBe(false);
    expect(isGlyph(undefined)).toBe(false);
  });

  test("a bot's state is the activity feed's, else what its sessions do; its face says it in words too", () => {
    const st = sceneAt(SAMPLE_SESSION_SCENE, 6_500).sessions;
    expect(buildModel(st, looks).byId.get(botBlockId("moss"))!.botState).toBe("working");
    expect(buildModel(sceneAt(SAMPLE_SESSION_SCENE, 8_000).sessions, looks).byId.get(botBlockId("moss"))!.botState).toBe("idle");
    const fed = buildModel(st, looks, new Map(), new Map([["moss", "asking" as const]])).byId.get(botBlockId("moss"))!;
    expect([fed.botState, fed.status]).toEqual(["asking", "Asking you"]);
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

  test("standard blocks: the title and agent · model · effort; the agent's own colour(s) at full hue; a bot is coral", () => {
    const a = end.byId.get("s_a")!;
    expect(a.title).toBe("Fix the login flow");
    // No icon in this data: our letter mark, so the agent's name leads the line (a letter alone doesn't name it).
    expect(a.meta).toBe("Claude Code · Claude Opus 5.5 · high");
    expect(a.agent).toBe("Claude Code");
    // With an icon, the line is the model and effort only.
    const withIcon = new Map([...looks].map(([k, v]) => [k, { ...v, icon: { mediaType: "image/png" as const, data: "", at: 0 } }]));
    const iconed = buildModel(sceneAt(SAMPLE_SESSION_SCENE, 20_000).sessions, withIcon);
    expect(iconed.byId.get("s_a")!.meta).toBe("Claude Opus 5.5 · high");
    expect(iconed.byId.get("sub:s_a:call_explore_1")!.meta).toBe("Claude Haiku 5");
    expect(iconed.byId.get("s_a")!.agent).toBe("Claude Code");
    expect(a.brand).toBe(looks.get("claude-code")!.color!);
    expect(end.byId.get(botBlockId("moss"))!.brand).toBe(MOSS_CORAL);
    // Codex: both its colours (a gradient). MOSS's own agent: the Shards mark's gold when its record names none (coral is
    // the bots'). A black-and-white brand, or an unknown backend: no colour (the theme's text colour), never a grey.
    expect([end.byId.get("s_b")!.brand, end.byId.get("s_b")!.brand2]).toEqual(["#484FF6", "#7893F9"]);
    const s = (id: string, backend: string): SessionView => ({ id, kind: "coding", computer: "c", status: "idle", startedAt: 1, updatedAt: 1, backend });
    const m = buildModel({ x: s("x", "moss-code"), y: s("y", "nobody"), z: s("z", "opencode") }, looks);
    expect(buildModel({ x: s("x", "moss-code") }, new Map()).byId.get("x")!.brand).toBe(MOSS_CODE_GOLD);
    expect(m.byId.get("x")!.brand).toBe("#E5A72E");
    expect(m.byId.get("y")!.brand).toBeUndefined();
    expect(m.byId.get("z")!.brand).toBeUndefined();
  });

  test("motion through the scene: s_a runs at 1 s, waits on its child at 6 s, the child ends at 11 s; the bot runs while its conversation does", () => {
    const at = (t: number) => buildModel(sceneAt(SAMPLE_SESSION_SCENE, t).sessions, looks);
    expect(at(1_000).byId.get("s_a")!.motion).toBe("running");
    expect(at(6_000).byId.get("s_a")!.motion).toBe("waiting");
    expect(at(9_000).byId.get("s_a")!.motion).toBe("running");
    expect(at(11_000).byId.get("s_c")!.motion).toBe("ended");
    expect(at(6_500).byId.get(botBlockId("moss"))!.motion).toBe("running");
    expect(at(8_000).byId.get(botBlockId("moss"))!.motion).toBe("waiting");
    // Drawn waiting, it says what it waits on; a bot whose session runs waits on it (not "Idle").
    expect(at(8_000).byId.get(botBlockId("moss"))!.status).toBe("Waiting · 1 session");
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
