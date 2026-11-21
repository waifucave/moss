// The SessionGraph conformance suite (spec revision 20, §9.5). `runSessionGraphConformance(make)` registers every case
// against the graph `make` builds (with the clock it is given); `tests/session-graph.test.ts` runs it against
// FakeSessionGraph, and lane CG runs it against the engine's. It also pins FakeSessionSource, the scene player.
import { describe, expect, test } from "bun:test";
import { SAMPLE_SESSION_SCENE, SUBAGENTS_MAX, sessionMotion, type SessionLinkEvent } from "@waifucave/moss-protocol";
import { isContractError } from "../common";
import { FakeSessionSource } from "../fakes/session-graph";
import type { SessionGraph } from "../session-graph";

export type SessionGraphFactory = (now: () => number) => SessionGraph;

const user = { kind: "user" } as const;
const throws = (fn: () => unknown, code: Parameters<typeof isContractError>[1]) => {
  try { fn(); } catch (e) { return isContractError(e, code); }
  return false;
};

export function runSessionGraphConformance(make: SessionGraphFactory): void {
  describe("SessionGraph", () => {
    test("who started it is set once; a child counts while it runs, a task while it runs; counts only", () => {
      let t = 10;
      const g = make(() => t);
      g.started("s_a", "coding", user);
      expect(g.fields("s_a")).toEqual({ startedBy: user });
      expect(throws(() => g.started("s_a", "coding", user), "conflict")).toBe(true);
      g.started("s_c", "agent", { kind: "session", session: "s_a" });
      g.taskStarted("s_a", "bash_1");
      expect(g.fields("s_a").waiting).toEqual({ tasks: 1, children: 1 });
      expect(sessionMotion({ status: "idle", waiting: g.fields("s_a").waiting })).toBe("waiting");
      expect(sessionMotion({ status: "prompting", waiting: g.fields("s_a").waiting })).toBe("running");
      g.ended("s_c");
      g.taskEnded("s_a", "bash_1");
      expect(g.fields("s_a").waiting).toBeUndefined();
      expect(g.fields("s_c").startedBy).toEqual({ kind: "session", session: "s_a" });
      // A bot's agent is its bot's conversation's child.
      g.started("s_moss", "bot", user, "moss");
      g.started("s_d", "agent", { kind: "bot", bot: "moss", session: "s_moss" }, "moss");
      expect(g.fields("s_moss").waiting).toEqual({ tasks: 0, children: 1 });
      // An ended session's own tasks end with it.
      g.taskStarted("s_d", "monitor_1");
      g.ended("s_d");
      expect(g.fields("s_d").waiting).toBeUndefined();
    });

    test("a subagent row keeps its id, is replaced in place, ends with a time, and the list is bounded", () => {
      let t = 100;
      const g = make(() => t);
      g.started("s_a", "coding", user);
      g.subagent("s_a", { id: "call_1", name: "Explore", state: "running", startedAt: 50 });
      g.subagent("s_a", { id: "call_2", name: "Review", state: "running", startedAt: 60 });
      t = 200;
      g.subagent("s_a", { id: "call_1", name: "Explore", state: "done", startedAt: 999 });
      const rows = g.fields("s_a").subagents!;
      expect(rows.map((r) => r.id)).toEqual(["call_1", "call_2"]);
      expect(rows[0]).toEqual({ id: "call_1", name: "Explore", state: "done", startedAt: 50, endedAt: 200 });
      expect(throws(() => g.subagent("s_a", { id: "", name: "x", state: "running", startedAt: 1 }), "invalid")).toBe(true);
      for (let i = 0; i < SUBAGENTS_MAX + 5; i++) g.subagent("s_a", { id: `r${i}`, name: "n", state: i % 2 === 0 ? "done" : "running", startedAt: 300 + i });
      const after = g.fields("s_a").subagents!;
      expect(after.length).toBe(SUBAGENTS_MAX);
      // The ended ones went first: every running row is still there.
      expect(after.filter((r) => r.state === "running").length).toBe(1 + Math.floor((SUBAGENTS_MAX + 5) / 2));
    });

    test("a link joins two known sessions or the person and one, with no words; heard by both ends' kinds only", () => {
      const g = make(() => 7);
      g.started("s_a", "coding", user);
      g.started("s_b", "coding", user);
      g.started("s_moss", "bot", user, "moss");
      g.started("s_d", "agent", { kind: "bot", bot: "moss", session: "s_moss" }, "moss");
      const heard: Record<string, SessionLinkEvent[]> = { user: [], sessions: [], both: [], bots: [] };
      g.watchLinks({ kind: "user" }, (l) => heard["user"]!.push(l));
      g.watchLinks({ kind: "plugin", capabilities: ["sessions.read"] }, (l) => heard["sessions"]!.push(l));
      g.watchLinks({ kind: "plugin", capabilities: ["sessions.read", "conversation.read"] }, (l) => heard["both"]!.push(l));
      g.watchLinks({ kind: "plugin", capabilities: ["conversation.read"] }, (l) => heard["bots"]!.push(l));
      const ab = g.link("s_a", "s_b", "message");
      expect(ab).toEqual({ type: "session_link", ts: 7, from: { end: "session", session: "s_a", kind: "coding" }, to: { session: "s_b", kind: "coding" }, link: "message" });
      g.link("s_moss", "s_d", "spawn");
      g.link(undefined, "s_a", "message");
      expect(heard["user"]!.length).toBe(3);
      expect(heard["sessions"]!.map((l) => l.link)).toEqual(["message", "message"]);
      expect(heard["both"]!.length).toBe(3);
      expect(heard["bots"]!.length).toBe(0);
      expect(Object.keys(ab).sort()).toEqual(["from", "link", "to", "ts", "type"]);
      expect(throws(() => g.link("s_a", "s_a", "message"), "invalid")).toBe(true);
      expect(throws(() => g.link("s_a", "s_zz", "message"), "invalid")).toBe(true);
    });

    test("each change of a session's fields is heard once; an unchanged one is not", () => {
      const g = make(() => 1);
      const heard: string[] = [];
      g.watch((c) => heard.push(`${c.session}:${JSON.stringify(c.fields.waiting ?? null)}`));
      g.started("s_a", "coding", user);
      g.taskStarted("s_a", "t1");
      g.taskStarted("s_a", "t1");
      g.taskEnded("s_a", "t1");
      g.taskEnded("s_a", "t1");
      expect(heard).toEqual(["s_a:null", 's_a:{"tasks":1,"children":0}', "s_a:null"]);
    });
  });

  describe("FakeSessionSource (the scene player)", () => {
    test("plays a scene: views and links in order, links gated by both ends' kinds", () => {
      const source = new FakeSessionSource();
      const views: string[] = [];
      const links: string[] = [];
      const codeOnly: string[] = [];
      source.watch((v) => views.push(v.id));
      source.watchLinks({ kind: "user" }, (l) => links.push(l.link));
      source.watchLinks({ kind: "plugin", capabilities: ["sessions.read"] }, (l) => codeOnly.push(l.link));
      const steps: (() => void)[] = [];
      source.play(SAMPLE_SESSION_SCENE, (_ms, fn) => { steps.push(fn); return () => {}; });
      for (const s of steps) s();
      expect(new Set(views)).toEqual(new Set(["s_a", "s_b", "s_moss", "s_c", "s_d"]));
      expect(links.length).toBe(SAMPLE_SESSION_SCENE.filter((s) => s.event.type === "session_link").length);
      // The bot's links (user→bot, bot→agent, agent→bot) reach no plugin that reads code sessions only.
      expect(codeOnly.length).toBe(links.length - 3);
      expect(source.list().find((v) => v.id === "s_c")!.status).toBe("stopped");
    });
  });
}
