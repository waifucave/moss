// The session host's graph (spec revision 20, §9.5): who started each session (kept in its meta across a restart), what
// it waits on, its agent's subagent rows (restored from its log, ended when their call is closed), the links its
// deliveries make, and the engine's titles of code sessions.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionLinkEvent, SessionView } from "@waifucave/moss-protocol";
import { FakeClock, flush } from "../../contracts/fakes/clock";
import { FakeSessionDriver } from "../../contracts/fakes/session-host";
import type { UserInput } from "../../contracts/session-host";
import { DurableSessionHost } from "../durable-host";
import { sessionMetaPath } from "../ids";
import { projectRecords } from "../wire";

const homes: string[] = [];
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "moss-cg-graph-"));
  homes.push(home);
  return home;
}
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

const user = (text: string, id = `m-${text}`): Omit<UserInput, "from"> => ({ text, device: "phone0000000000000", sentAt: 1, clientMessageId: id });

function hostOn(home = tempHome(), clock = new FakeClock(), titles?: ConstructorParameters<typeof DurableSessionHost>[0]["titles"]) {
  const host = new DurableSessionHost({ home, clock, ...(titles ? { titles } : {}) });
  const links: SessionLinkEvent[] = [];
  host.graph.watchLinks({ kind: "user" }, (l) => links.push(l));
  return { home, clock, host, links };
}

describe("who started a session", () => {
  test("each way a session starts reads its starter, kept in its meta and the same after a restart", () => {
    const { home, clock, host } = hostOn();
    host.open({ id: "b_moss", kind: "bot", bot: "moss", computer: "Studio" }, new FakeSessionDriver());
    host.open({ id: "s_code", kind: "coding", computer: "Studio" }, new FakeSessionDriver({ canFold: false }));
    host.open({ id: "agent_1", kind: "agent", bot: "moss", parent: "b_moss", computer: "Studio" }, new FakeSessionDriver({ canFold: false }));
    host.open({ id: "t_run", kind: "side-thread", bot: "moss", parent: "b_moss", routine: "r_daily", computer: "Studio" }, new FakeSessionDriver());
    // A session another one started (lane CM's tools name it so).
    host.open({ id: "agent_2", kind: "agent", parent: "s_code", startedBy: { kind: "session", session: "s_code" }, computer: "Studio" }, new FakeSessionDriver({ canFold: false }));
    const want: Record<string, unknown> = {
      b_moss: { kind: "user" },
      s_code: { kind: "user" },
      agent_1: { kind: "bot", bot: "moss", session: "b_moss" },
      t_run: { kind: "routine", routine: "r_daily", bot: "moss" },
      agent_2: { kind: "session", session: "s_code" },
    };
    for (const [id, by] of Object.entries(want)) expect(host.get(id)!.startedBy).toEqual(by as never);
    expect(JSON.parse(readFileSync(sessionMetaPath(home, undefined, "agent_2"), "utf8")).startedBy).toEqual({ kind: "session", session: "s_code" });
    const again = new DurableSessionHost({ home, clock });
    for (const [id, by] of Object.entries(want)) expect(again.get(id)!.startedBy).toEqual(by as never);
  });
});

describe("waiting", () => {
  test("a bot's conversation waits on its agent until it ends; a background task counts until it ends; both survive as views", async () => {
    const { host } = hostOn();
    const views: SessionView[] = [];
    host.watch((v) => views.push(v));
    host.open({ id: "b_moss", kind: "bot", bot: "moss", computer: "Studio" }, new FakeSessionDriver());
    host.open({ id: "agent_1", kind: "agent", bot: "moss", parent: "b_moss", computer: "Studio" }, new FakeSessionDriver({ canFold: false }));
    expect(host.get("b_moss")!.waiting).toEqual({ tasks: 0, children: 1 });
    // The parent's view was sent again when its child started.
    expect(views.filter((v) => v.id === "b_moss").at(-1)!.waiting).toEqual({ tasks: 0, children: 1 });
    host.taskStarted("b_moss", "bash_1");
    expect(host.get("b_moss")!.waiting).toEqual({ tasks: 1, children: 1 });
    await host.stop("agent_1");
    expect(host.get("b_moss")!.waiting).toEqual({ tasks: 1, children: 0 });
    host.taskEnded("b_moss", "bash_1");
    expect(host.get("b_moss")!.waiting).toBeUndefined();
    expect(views.filter((v) => v.id === "b_moss").at(-1)!.waiting).toBeUndefined();
    // A session it doesn't know, or a task never started, changes nothing.
    host.taskStarted("s_nobody", "x");
    host.taskEnded("b_moss", "never");
  });

  // Backlog 522: the canvas showed a bot "waiting" on an agent that was only idle (it had reported and waits for the next message).
  test("an agent that reported and sits idle is not waited for; its next turn is", async () => {
    const { host } = hostOn();
    const views: SessionView[] = [];
    host.watch((v) => views.push(v));
    host.open({ id: "b_moss", kind: "bot", bot: "moss", computer: "Studio" }, new FakeSessionDriver());
    const agent = new FakeSessionDriver({ canFold: false });
    host.open({ id: "agent_1", kind: "agent", bot: "moss", parent: "b_moss", computer: "Studio" }, agent);
    // Not run yet: its bot waits for it.
    expect(host.get("b_moss")!.waiting).toEqual({ tasks: 0, children: 1 });
    await host.deliver("agent_1", { from: "bot", bot: "moss", session: "b_moss", text: "Write the tests." });
    await flush();
    expect(host.get("agent_1")!.status).toBe("prompting");
    expect(host.get("b_moss")!.waiting).toEqual({ tasks: 0, children: 1 });
    agent.end({ text: "Done." });
    await flush();
    expect(host.get("agent_1")!.status).toBe("idle");
    expect(host.get("b_moss")!.waiting).toBeUndefined();
    expect(views.filter((v) => v.id === "b_moss").at(-1)!.waiting).toBeUndefined();
    // Its next message starts a turn: waited for again, and idle again when that ends.
    await host.deliver("agent_1", { from: "bot", bot: "moss", session: "b_moss", text: "Also the docs." });
    await flush();
    expect(host.get("b_moss")!.waiting).toEqual({ tasks: 0, children: 1 });
    agent.end({ text: "Docs too." });
    await flush();
    expect(host.get("b_moss")!.waiting).toBeUndefined();
    // An idle agent that is stopped is ended, not counted, and its bot is not left waiting.
    await host.stop("agent_1");
    expect(host.get("b_moss")!.waiting).toBeUndefined();
  });

  test("a restart keeps an idle child idle (not waited for), and a child that has not run yet is still waited for", async () => {
    const { home, clock, host } = hostOn();
    host.open({ id: "b_moss", kind: "bot", bot: "moss", computer: "Studio" }, new FakeSessionDriver());
    const ran = new FakeSessionDriver({ canFold: false });
    host.open({ id: "agent_ran", kind: "agent", bot: "moss", parent: "b_moss", computer: "Studio" }, ran);
    host.open({ id: "agent_new", kind: "agent", bot: "moss", parent: "b_moss", computer: "Studio" }, new FakeSessionDriver({ canFold: false }));
    await host.deliver("agent_ran", { from: "bot", bot: "moss", session: "b_moss", text: "Write the tests." });
    await flush();
    ran.end({ text: "Done." });
    await flush();
    expect(host.get("b_moss")!.waiting).toEqual({ tasks: 0, children: 1 });
    const again = new DurableSessionHost({ home, clock });
    expect(again.get("agent_ran")!.status).toBe("idle");
    expect(again.get("b_moss")!.waiting).toEqual({ tasks: 0, children: 1 }); // agent_new only
  });

  test("an idle agent with a background task of its own is still waited for until the task ends", async () => {
    const { host } = hostOn();
    host.open({ id: "b_moss", kind: "bot", bot: "moss", computer: "Studio" }, new FakeSessionDriver());
    const agent = new FakeSessionDriver({ canFold: false });
    host.open({ id: "agent_1", kind: "agent", bot: "moss", parent: "b_moss", computer: "Studio" }, agent);
    await host.deliver("agent_1", { from: "bot", bot: "moss", session: "b_moss", text: "Run the build." });
    await flush();
    host.taskStarted("agent_1", "bash_1");
    agent.end({ text: "Started it." });
    await flush();
    expect(host.get("b_moss")!.waiting).toEqual({ tasks: 0, children: 1 });
    host.taskEnded("agent_1", "bash_1");
    expect(host.get("b_moss")!.waiting).toBeUndefined();
  });

  test("a restart has no task running, and counts the children that are still running", async () => {
    const { home, clock, host } = hostOn();
    host.open({ id: "b_moss", kind: "bot", bot: "moss", computer: "Studio" }, new FakeSessionDriver());
    host.open({ id: "agent_1", kind: "agent", bot: "moss", parent: "b_moss", computer: "Studio" }, new FakeSessionDriver({ canFold: false }));
    host.open({ id: "agent_2", kind: "agent", bot: "moss", parent: "b_moss", computer: "Studio" }, new FakeSessionDriver({ canFold: false }));
    await host.stop("agent_2");
    host.taskStarted("b_moss", "bash_1");
    const again = new DurableSessionHost({ home, clock });
    expect(again.get("b_moss")!.waiting).toEqual({ tasks: 0, children: 1 });
  });
});

describe("links", () => {
  test("a bot's task to its agent is a spawn, its next message a message, the agent's message and its report to the bot", async () => {
    const { host, links } = hostOn();
    host.open({ id: "b_moss", kind: "bot", bot: "moss", computer: "Studio" }, new FakeSessionDriver());
    const agent = new FakeSessionDriver({ canFold: false });
    host.open({ id: "agent_1", kind: "agent", bot: "moss", parent: "b_moss", computer: "Studio" }, agent);
    await host.deliver("agent_1", { from: "bot", bot: "moss", session: "b_moss", text: "Write the tests." });
    await host.deliver("agent_1", { from: "bot", bot: "moss", session: "b_moss", text: "Also the docs." });
    await host.deliver("b_moss", { from: "agent", agent: "agent_1", text: "Halfway." });
    await flush();
    agent.end({ text: "Done." });
    await flush();
    agent.end({ text: "Docs too." });
    await flush();
    const seen = links.map((l) => `${l.from.end === "session" ? l.from.session : "user"}>${l.to.session}:${l.link}`);
    expect(seen.slice(0, 4)).toEqual(["b_moss>agent_1:spawn", "b_moss>agent_1:message", "agent_1>b_moss:message", "agent_1>b_moss:report"]);
    // No words ever ride a link.
    for (const l of links) expect(Object.keys(l).sort()).toEqual(["from", "link", "to", "ts", "type"]);
  });

  test("the person's message is a link from the person; a session's message to another code session lands as session_message", async () => {
    const { host, links } = hostOn();
    host.open({ id: "s_a", kind: "coding", computer: "Studio" }, new FakeSessionDriver({ canFold: false }));
    host.open({ id: "s_b", kind: "coding", computer: "Studio" }, new FakeSessionDriver({ canFold: false }));
    await host.sendUser("s_a", user("hello"));
    const { seq } = await host.deliver("s_b", { from: "session", session: "s_a", text: "The API moved to v2." });
    expect(links.map((l) => [l.from.end, l.to.session, l.link])).toEqual([["user", "s_a", "message"], ["session", "s_b", "message"]]);
    const projected = projectRecords(host.history("s_b"), { kind: "coding" });
    expect(projected.find((e) => e.seq === seq)).toMatchObject({ type: "session_message", fromSession: "s_a", text: "The API moved to v2." });
  });

  test("a plugin hears a link only when it may read both ends", async () => {
    const { host } = hostOn();
    const code: string[] = [];
    const both: string[] = [];
    host.graph.watchLinks({ kind: "plugin", capabilities: ["sessions.read"] }, (l) => code.push(l.to.session));
    host.graph.watchLinks({ kind: "plugin", capabilities: ["sessions.read", "conversation.read"] }, (l) => both.push(l.to.session));
    host.open({ id: "b_moss", kind: "bot", bot: "moss", computer: "Studio" }, new FakeSessionDriver());
    host.open({ id: "agent_1", kind: "agent", bot: "moss", parent: "b_moss", computer: "Studio" }, new FakeSessionDriver({ canFold: false }));
    await host.deliver("agent_1", { from: "bot", bot: "moss", session: "b_moss", text: "Go." });
    expect(code).toEqual([]);
    expect(both).toEqual(["agent_1"]);
  });
});

describe("subagent rows", () => {
  test("a call its driver marks a subagent is a row; its end ends it; a closed call fails it; the log restores them", async () => {
    const { home, clock, host } = hostOn();
    const d = new FakeSessionDriver({ canFold: false });
    host.open({ id: "s_a", kind: "coding", computer: "Studio" }, d);
    await host.sendUser("s_a", user("look around"));
    await flush();
    d.emit({ type: "agent_tool_call", id: "toolu_1", kind: "think", title: "Task", status: "pending" });
    d.emit({ type: "agent_subagent", id: "toolu_1", name: "Task" });
    clock.advance(10);
    // Its name, once its input arrived: the same row, renamed, its start unchanged.
    d.emit({ type: "agent_subagent", id: "toolu_1", name: "Explore the auth module", model: "haiku" });
    d.emit({ type: "agent_tool_call", id: "toolu_2", kind: "think", title: "Review", status: "pending" });
    d.emit({ type: "agent_subagent", id: "toolu_2", name: "Review" });
    d.emit({ type: "agent_tool_call", id: "toolu_3", kind: "read", title: "Read a.ts", status: "pending" });
    expect(host.get("s_a")!.subagents!.map((r) => [r.id, r.state])).toEqual([["toolu_1", "running"], ["toolu_2", "running"]]);
    clock.advance(500);
    d.emit({ type: "agent_tool_call_update", id: "toolu_1", status: "completed" });
    d.emit({ type: "agent_tool_call_update", id: "toolu_3", status: "completed" });
    const rows = host.get("s_a")!.subagents!;
    expect(rows[0]).toMatchObject({ id: "toolu_1", name: "Explore the auth module", model: "haiku", state: "done" });
    expect(rows[0]!.endedAt! - rows[0]!.startedAt).toBe(510);
    // The turn ends with the second still open: the core closes the call, and the row fails with it.
    d.end({ text: "ok" });
    await flush();
    expect(host.get("s_a")!.subagents!.map((r) => r.state)).toEqual(["done", "failed"]);
    const again = new DurableSessionHost({ home, clock });
    expect(again.get("s_a")!.subagents!.map((r) => [r.id, r.state])).toEqual([["toolu_1", "done"], ["toolu_2", "failed"]]);
  });

  test("a restart ends a subagent its interrupted turn left running", async () => {
    const { home, clock, host } = hostOn();
    const d = new FakeSessionDriver({ canFold: false });
    host.open({ id: "s_a", kind: "coding", computer: "Studio" }, d);
    await host.sendUser("s_a", user("go"));
    await flush();
    d.emit({ type: "agent_tool_call", id: "toolu_1", kind: "think", title: "Explore", status: "pending" });
    d.emit({ type: "agent_subagent", id: "toolu_1", name: "Explore" });
    // The daemon dies here; the next start reads the log.
    const again = new DurableSessionHost({ home, clock });
    expect(again.get("s_a")!.subagents!.map((r) => r.state)).toEqual(["failed"]);
  });
});

describe("titles", () => {
  test("a code session is titled after its first turn, from its first message, on its model's light model; once; kept across a restart", async () => {
    const asked: { text: string; model: string }[] = [];
    const titles = {
      titler: async (text: string, model: string) => { asked.push({ text, model }); return "Fix the login loop"; },
      lightModelFor: (m: string | undefined) => (m === "anthropic/claude-opus-5-5" ? "anthropic/claude-haiku-5" : "default-light"),
    };
    const { home, clock, host } = hostOn(tempHome(), new FakeClock(), titles);
    const views: SessionView[] = [];
    host.watch((v) => views.push(v));
    const d = new FakeSessionDriver({ canFold: false });
    host.open({ id: "s_a", kind: "coding", model: "anthropic/claude-opus-5-5", computer: "Studio" }, d);
    await host.sendUser("s_a", user("the login page loops"));
    await flush();
    expect(asked).toEqual([]);
    d.end({ text: "Looking." });
    await flush();
    expect(asked).toEqual([{ text: "the login page loops", model: "anthropic/claude-haiku-5" }]);
    expect(host.get("s_a")!.title).toBe("Fix the login loop");
    expect(views.filter((v) => v.id === "s_a").at(-1)!.title).toBe("Fix the login loop");
    await host.sendUser("s_a", user("and again"));
    await flush();
    d.end({});
    await flush();
    expect(asked.length).toBe(1);
    const again = new DurableSessionHost({ home, clock, titles });
    expect(again.titles!.title("s_a")).toEqual({ title: "Fix the login loop", by: "engine" });
  });

  test("a spawn's title is never replaced; a bot's conversation is never titled; a failed titler tries again next turn", async () => {
    let fail = true;
    const asked: string[] = [];
    const titles = { titler: async (text: string) => { asked.push(text); if (fail) throw new Error("no model"); return "Second try"; }, lightModelFor: () => "light" };
    const { host } = hostOn(tempHome(), new FakeClock(), titles);
    const spawned = new FakeSessionDriver({ canFold: false });
    host.open({ id: "agent_1", kind: "agent", bot: "moss", parent: "b_moss", title: "Tidy the notes", computer: "Studio" }, spawned);
    const bot = new FakeSessionDriver();
    host.open({ id: "b_moss", kind: "bot", bot: "moss", computer: "Studio" }, bot);
    const code = new FakeSessionDriver({ canFold: false });
    host.open({ id: "s_a", kind: "coding", computer: "Studio" }, code);
    await host.deliver("agent_1", { from: "bot", bot: "moss", session: "b_moss", text: "Tidy them." });
    await host.sendUser("b_moss", user("hi"));
    await host.sendUser("s_a", user("first"));
    await flush();
    spawned.end({});
    bot.end({});
    code.end({});
    await flush();
    expect(host.get("agent_1")!.title).toBe("Tidy the notes");
    expect(host.get("b_moss")!.title).toBeUndefined();
    expect(host.get("s_a")!.title).toBeUndefined();
    expect(asked).toEqual(["first"]);
    fail = false;
    await host.sendUser("s_a", user("second"));
    await flush();
    code.end({});
    await flush();
    expect(host.get("s_a")!.title).toBe("Second try");
    expect(asked).toEqual(["first", "first"]);
  });
});

describe("the record of links, kept by the host", () => {
  test("links between sessions survive a restart in the transcripts folder, and an ended session's go from the file", async () => {
    const { home, clock, host } = hostOn();
    host.open({ id: "s_a", kind: "coding", computer: "Studio" }, new FakeSessionDriver({ canFold: false }));
    host.open({ id: "s_b", kind: "coding", computer: "Studio" }, new FakeSessionDriver({ canFold: false }));
    host.open({ id: "s_c", kind: "coding", computer: "Studio" }, new FakeSessionDriver({ canFold: false }));
    await host.deliver("s_b", { from: "session", session: "s_a", text: "one" });
    await host.deliver("s_c", { from: "session", session: "s_a", text: "two" });
    await host.deliver("s_b", { from: "session", session: "s_a", text: "three" });
    await host.sendUser("s_a", user("from the person"));
    // A clean stop writes what waits.
    await host.close();
    const again = new DurableSessionHost({ home, clock });
    const r = again.graph.links({ kind: "user" });
    expect(r.pairs.map((p) => [p.to.session, p.count]).sort()).toEqual([["s_b", 2], ["s_c", 1]]);
    expect(r.links.length).toBe(3);
    // No words were kept.
    expect(readFileSync(join(home, "transcripts", "links.json"), "utf8")).not.toContain("three");
    await host.stop("s_c");
    const third = new DurableSessionHost({ home, clock });
    expect(third.graph.links({ kind: "user" }).pairs.map((p) => p.to.session)).toEqual(["s_b"]);
    expect(readFileSync(join(home, "transcripts", "links.json"), "utf8")).not.toContain("s_c");
  });
});

describe("a title another computer sends", () => {
  test("is one plain line, or none, when its session is first held here", () => {
    const { host: laptop } = hostOn();
    const { host: studio } = hostOn();
    laptop.open({ id: "c_dirty", kind: "coding", computer: "Laptop", title: "Fix\u001b[2J ‮exe.txt‬\nsecond line" }, new FakeSessionDriver());
    laptop.open({ id: "c_blank", kind: "coding", computer: "Laptop", title: "ok" }, new FakeSessionDriver());
    const dirty = { ...laptop.get("c_dirty")!, title: "Fix\u001b[2J ‮exe.txt‬\nsecond line" } as SessionView;
    const blank = { ...laptop.get("c_blank")!, title: "​‮" } as SessionView;
    studio.ingest(dirty, laptop.history("c_dirty"), { from: "laptop-device", late: false });
    studio.ingest(blank, laptop.history("c_blank"), { from: "laptop-device", late: false });
    expect(studio.get("c_dirty")!.title).toBe("Fix exe.txt");
    expect(studio.get("c_blank")!.title).toBeUndefined();
  });
});
