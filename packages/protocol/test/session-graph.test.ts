// The session canvas's shared shapes (spec revision 20, §9.5): who started a session, waiting and its precedence, an agent's
// subagents, the link event and its two-sided gate, who may reach whom, and the sample scene.
import { describe, expect, test } from "bun:test";
import {
  MOSS_EVENTS, MOSS_METHODS, REACH_RULE_LINES, SAMPLE_SESSION_SCENE, SessionLinkEvent, SessionView, decodeMossCoreEvent, eventDataKinds,
  foldSessionEvents, mayReach, pluginMayHear, reachRefusal, resolveSessionTo, sceneAt, sessionMotion, type SessionSceneStep,
} from "../src/index";

const base = { id: "s_1", kind: "coding", computer: "Studio", status: "idle", startedAt: 1, updatedAt: 1 } as const;

describe("the session graph on SessionView (§9.5)", () => {
  test("who started it, what it waits on and its subagents ride on the view; parent and bot stay", () => {
    const v = SessionView.parse({
      ...base, parent: "s_0", startedBy: { kind: "session", session: "s_0" }, waiting: { tasks: 1, children: 2 },
      subagents: [{ id: "call_1", name: "Explore", state: "running", startedAt: 2 }],
    });
    expect(v.startedBy).toEqual({ kind: "session", session: "s_0" });
    for (const startedBy of [{ kind: "user" }, { kind: "bot", bot: "moss", session: "s_moss" }, { kind: "routine", routine: "r_1", bot: "moss" }]) {
      expect(SessionView.safeParse({ ...base, startedBy }).success).toBe(true);
    }
    expect(SessionView.safeParse({ ...base, startedBy: { kind: "plugin", pluginId: "x" } }).success).toBe(false);
    expect(SessionView.safeParse({ ...base, subagents: Array.from({ length: 65 }, (_, i) => ({ id: `c${i}`, name: "n", state: "done", startedAt: 1 })) }).success).toBe(false);
    expect(SessionView.safeParse({ ...base, waiting: { tasks: -1, children: 0 } }).success).toBe(false);
  });

  test("running wins over waiting; waiting needs something that will wake it; an ended session is ended", () => {
    const w = { tasks: 1, children: 0 };
    expect(sessionMotion({ status: "prompting", waiting: w })).toBe("running");
    expect(sessionMotion({ status: "starting" })).toBe("running");
    expect(sessionMotion({ status: "idle", waiting: w })).toBe("waiting");
    expect(sessionMotion({ status: "ready", waiting: { tasks: 0, children: 3 } })).toBe("waiting");
    expect(sessionMotion({ status: "idle", waiting: { tasks: 0, children: 0 } })).toBe("still");
    expect(sessionMotion({ status: "idle" })).toBe("still");
    expect(sessionMotion({ status: "stopped", waiting: w })).toBe("ended");
  });
});

describe("the link event (§9.5)", () => {
  const link = { type: "session_link", ts: 5, from: { end: "session", session: "s_a", kind: "coding" }, to: { session: "s_b", kind: "coding" }, link: "message" } as const;

  test("it is a core event of the sessions area, transient, with no words", () => {
    const spec = MOSS_EVENTS.get("session_link")!;
    expect([spec.area, spec.scope, spec.transient, spec.capability]).toEqual(["sessions", "core", true, "conversation.*"]);
    expect(decodeMossCoreEvent(link).kind).toBe("event");
    expect(SessionLinkEvent.safeParse({ ...link, text: "hello" }).success).toBe(false);
    expect(SessionLinkEvent.safeParse({ ...link, link: "chat" }).success).toBe(false);
    expect(SessionLinkEvent.safeParse({ ...link, from: { end: "user" } }).success).toBe(true);
  });

  test("a plugin hears it only when it may read BOTH sessions' kinds; the person's end has none", () => {
    const spec = MOSS_EVENTS.get("session_link")!;
    const botToAgent = { ...link, from: { end: "session", session: "s_moss", kind: "bot", bot: "moss" }, to: { session: "s_d", kind: "agent", bot: "moss" } };
    expect(eventDataKinds("session_link", botToAgent)).toEqual(["bots", "sessions"]);
    expect(pluginMayHear(spec, ["sessions.read"], botToAgent)).toBe(false);
    expect(pluginMayHear(spec, ["conversation.read"], botToAgent)).toBe(false);
    expect(pluginMayHear(spec, ["conversation.read", "sessions.read"], botToAgent)).toBe(true);
    expect(pluginMayHear(spec, ["sessions.read"], link)).toBe(true);
    expect(pluginMayHear(spec, ["conversation.read"], link)).toBe(false);
    const fromUser = { ...link, from: { end: "user" } };
    expect(eventDataKinds("session_link", fromUser)).toEqual(["sessions"]);
    expect(pluginMayHear(spec, ["sessions.read"], fromUser)).toBe(true);
    // A link whose ends don't read: heard by no plugin.
    expect(pluginMayHear(spec, ["sessions.read", "conversation.read"], { ...link, to: { session: "s_b" } })).toBe(false);
  });

  test("a session event from another code session carries the sender, read as a code session's", () => {
    const spec = MOSS_EVENTS.get("session_message")!;
    // Only between sessions that are no bot's: the receiver is always a code session.
    expect([spec.area, spec.scope, spec.capability]).toEqual(["sessions", "session", "sessions.read"]);
  });
});

describe("who may reach whom (§9.5)", () => {
  const s = (id: string, kind: "bot" | "side-thread" | "agent" | "coding", bot?: string) => ({ id, kind, ...(bot !== undefined ? { bot } : {}) });

  test("a bot's own conversation: its own bot's sessions and every bot's conversation, word for word, and (the owner's ruling of 2026-11-22) the sessions the person started", () => {
    const from = { id: "s_moss", kind: "bot" as const, bot: "moss" };
    expect(reachRefusal(from, s("s_moss", "bot", "moss"))).toBe("That is this conversation; SendMessage reaches another one.");
    expect(reachRefusal(from, s("s_luna", "bot", "luna"))).toBeUndefined();
    expect(reachRefusal(from, s("s_d", "agent", "moss"))).toBeUndefined();
    expect(reachRefusal(from, s("s_code", "coding"))).toBeUndefined();
    expect(reachRefusal(from, { ...s("s_kid", "coding"), parent: "s_code", startedBy: { kind: "session" as const, session: "s_code" } })).toBe("s_kid is a session another of the user's sessions started; SendMessage reaches your bot's sessions, other bots' conversations and the sessions the user started themselves.");
    expect(reachRefusal(from, s("s_e", "agent", "luna"))).toBe('s_e belongs to the bot luna; message that bot\'s conversation instead (SendMessage with to: "luna").');
  });

  test("a session a bot created: that bot and any other session; another bot only once it has messaged it", () => {
    const from = { id: "s_d", kind: "agent" as const, bot: "moss" };
    expect(reachRefusal(from, s("s_d", "agent", "moss"))).toBe("That is this session; SendMessage reaches another one.");
    expect(reachRefusal(from, s("s_moss", "bot", "moss"))).toBeUndefined();
    expect(reachRefusal(from, s("s_side", "side-thread", "moss"))).toBeUndefined();
    for (const t of [s("s_code", "coding"), s("s_e", "agent", "luna"), { ...s("s_kid", "coding"), parent: "s_code", startedBy: { kind: "session" as const, session: "s_code" } }]) expect(reachRefusal(from, t)).toBeUndefined();
    expect(reachRefusal(from, s("s_luna", "bot", "luna"))).toContain("only after that bot has messaged it first");
    expect(reachRefusal(from, s("s_luna", "bot", "luna"), (b) => b === "sora")).toContain("only after that bot has messaged it first");
    expect(reachRefusal(from, s("s_luna", "bot", "luna"), (b) => b === "luna")).toBeUndefined();
  });

  test("a session the person created: any other session; a bot only once it has messaged it", () => {
    const from = { id: "s_a", kind: "coding" as const };
    expect(reachRefusal(from, s("s_a", "coding"))).toBe("That is this session; SendMessage reaches another one.");
    expect(reachRefusal(from, s("s_b", "coding"))).toBeUndefined();
    expect(reachRefusal(from, s("s_c", "agent"))).toBeUndefined();
    expect(reachRefusal(from, s("s_d", "agent", "moss"))).toBeUndefined();
    expect(reachRefusal(from, s("s_moss", "bot", "moss"))).toContain("only after that bot has messaged it first");
    expect(reachRefusal(from, s("s_side", "side-thread", "moss"))).toContain("only after that bot has messaged it first");
    expect(reachRefusal(from, s("s_moss", "bot", "moss"), (b) => b === "moss")).toBeUndefined();
    expect(reachRefusal(from, s("s_side", "side-thread", "moss"), (b) => b === "moss")).toBeUndefined();
    expect(mayReach(from, { ...s("s_b", "coding"), status: "stopped" })).toBe(false);
    expect(mayReach(from, { ...s("s_b", "coding"), status: "idle" })).toBe(true);
    // Four lines are the owner's own (his words, quoted in the file); two are the controller's (never itself, ended takes nothing).
    expect(REACH_RULE_LINES.filter((l) => l.ruled === "owner").length).toBe(4);
  });

  test("a `to` is an id, else the one title it matches; two titles name the ids", () => {
    const reach = [{ id: "s_b", title: "Docs pass" }, { id: "s_c", title: "Tests" }, { id: "s_d", title: "tests" }];
    expect(resolveSessionTo("s_b", reach)).toEqual({ session: "s_b" });
    expect(resolveSessionTo("docs PASS", reach)).toEqual({ session: "s_b" });
    expect("error" in resolveSessionTo("Tests", reach)).toBe(true);
    expect("error" in resolveSessionTo("s_z", reach)).toBe(true);
  });

  test("the tools' methods: the bridge lists what it may reach; agent.options and agent.recent are the person's clients'", () => {
    expect(MOSS_METHODS.get("bridge.listSessions")!.roles).toEqual(["bridge"]);
    expect(MOSS_METHODS.get("bridge.sendMessage")!.params.safeParse({ text: "hi", to: "Docs pass" }).success).toBe(true);
    for (const m of ["agent.options", "agent.recent"]) expect(MOSS_METHODS.get(m)!.roles).toEqual(["app", "cli"]);
    expect(MOSS_METHODS.get("app.openIn")!.params.safeParse({ program: "host", what: { kind: "window" } }).success).toBe(false);
    expect(MOSS_METHODS.get("app.openIn")!.params.safeParse({ program: "moss", what: { kind: "bot", bot: "moss" } }).success).toBe(true);
  });
});

describe("the sample scene", () => {
  test("every step is a wire event its own schema takes, in time order", () => {
    let at = -1;
    for (const step of SAMPLE_SESSION_SCENE) {
      expect(step.at).toBeGreaterThanOrEqual(at);
      at = step.at;
      const decoded = decodeMossCoreEvent(step.event);
      expect([step.at, decoded.kind]).toEqual([step.at, "event"]);
    }
  });

  test("it shows what a reader must draw: a child joined to its parent, links of each kind, waiting, a subagent, a bot's agent, endings", () => {
    const mid = sceneAt(SAMPLE_SESSION_SCENE, 7_600);
    expect(mid.sessions["s_c"]!.startedBy).toEqual({ kind: "session", session: "s_a" });
    expect(sessionMotion(mid.sessions["s_a"]!)).toBe("waiting");
    expect(sessionMotion(mid.sessions["s_moss"]!)).toBe("waiting");
    expect(mid.sessions["s_a"]!.subagents![0]!.state).toBe("done");
    const end = sceneAt(SAMPLE_SESSION_SCENE, Number.POSITIVE_INFINITY);
    expect(new Set(end.links.map((l) => l.link))).toEqual(new Set(["message", "spawn", "report"]));
    expect(end.sessions["s_c"]!.status).toBe("stopped");
    expect(end.sessions["s_d"]!.bot).toBe("moss");
    expect(Object.values(end.sessions).every((v) => sessionMotion(v) !== "running")).toBe(true);
  });

  test("folding (generated sequences): a session is the newest view seen, never an older one; links keep arrival order", () => {
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
    const events = SAMPLE_SESSION_SCENE.map((s) => s.event);
    for (let round = 0; round < 300; round++) {
      const seq: SessionSceneStep["event"][] = Array.from({ length: 1 + rand(40) }, () => events[rand(events.length)]!);
      const cut = rand(seq.length + 1);
      const whole = foldSessionEvents(seq);
      // Folding in two halves gives the same state as folding all at once.
      expect(foldSessionEvents(seq.slice(cut), foldSessionEvents(seq.slice(0, cut)))).toEqual(whole);
      for (const [id, v] of Object.entries(whole.sessions)) {
        const seen = seq.flatMap((e) => (e.type === "session_changed" && e.session.id === id ? [e.session] : []));
        expect(v.updatedAt).toBe(Math.max(...seen.map((x) => x.updatedAt)));
      }
      expect(whole.links).toEqual(seq.filter((e) => e.type === "session_link"));
    }
  });
});
