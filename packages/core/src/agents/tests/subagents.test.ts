// An agent's own subagents (spec revision 20, §9.5 "Subagents"): which tool call starts one is the backend's `subagents`
// quirk, never its name. Claude Code's frames are played as its ACP adapter sends them (read from
// `@zed-industries/claude-agent-acp` 0.23.1's code, never run against an account); every other bundled agent declares
// none; MOSS's own backends declare the runtime's `Agent` tool, which neither offers today.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentQuirks, AgentSession, AgentStartSpec } from "../../contracts/agent-backend";
import { FakeClock } from "../../contracts/fakes/clock";
import { FakeFence } from "../../contracts/fakes/fence";
import { WELL_BEHAVED_QUIRKS } from "../../contracts/fakes/agent-backend";
import type { TurnControl } from "../../contracts/session-host";
import { Listeners } from "../../contracts/common";
import { AgentDriver } from "../driver";
import { MOSS_CODE_QUIRKS } from "../moss-code/backend";
import { quirksWithCommand, readQuirksFile } from "../plugin-backends";
import { metaToolName, subagentOf } from "../subagents";
import { acpHarness } from "../testing/harness";
import type { FakeAcpStep } from "../testing/fake-acp-agent";
import { IN_PROCESS_QUIRKS } from "../../runtime-sdk/turn-loop/subagent-backend";

const PLUGINS = join(import.meta.dir, "../../../../../plugins/moss/plugins");
const root = realpathSync(mkdtempSync(join(tmpdir(), "moss-cg-subagents-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function bundledQuirks(folder: string): AgentQuirks {
  const file = readQuirksFile(join(PLUGINS, folder), "quirks.json");
  return quirksWithCommand(file.quirks, { program: "agent", acpArgs: ["acp"] });
}
const CLAUDE = bundledQuirks("agent-claude-code").subagents!;

/** A Task call as Claude Code's adapter sends it: the call while its input streams, the whole input, then its end; one
 *  of the subagent's own calls between (`parentToolUseId`). */
function claudeTaskFrames(id: string, end: "completed" | "failed"): Record<string, unknown>[] {
  const meta = { claudeCode: { toolName: "Task" } };
  return [
    { sessionUpdate: "tool_call", toolCallId: id, title: "Task", kind: "think", status: "pending", rawInput: {}, _meta: meta },
    { sessionUpdate: "tool_call_update", toolCallId: id, title: "Explore the auth module", kind: "think", rawInput: { description: "Explore the auth module", prompt: "Find where sessions are made.", subagent_type: "Explore", model: "haiku" }, _meta: meta },
    { sessionUpdate: "tool_call", toolCallId: `${id}_inner`, title: "Read auth.ts", kind: "read", status: "pending", rawInput: { file_path: "auth.ts" }, _meta: { claudeCode: { toolName: "Read", parentToolUseId: id } } },
    { sessionUpdate: "tool_call_update", toolCallId: `${id}_inner`, status: "completed", _meta: { claudeCode: { toolName: "Read", parentToolUseId: id } } },
    { sessionUpdate: "tool_call_update", toolCallId: id, status: end, rawOutput: [{ type: "text", text: "Sessions are made in host.ts." }], _meta: meta },
  ];
}

describe("which call starts a subagent", () => {
  test("Claude Code's: its tool's name in _meta, its name from the input's description, then its type; its model", () => {
    expect(metaToolName(CLAUDE, { _meta: { claudeCode: { toolName: "Task" } } })).toBe("Task");
    expect(metaToolName(CLAUDE, { _meta: { claudeCode: {} } })).toBeUndefined();
    expect(metaToolName(CLAUDE, {})).toBeUndefined();
    expect(subagentOf(CLAUDE, { toolName: "Task", title: "Task", kind: "think", rawInput: {} })).toEqual({ name: "Task" });
    expect(subagentOf(CLAUDE, { toolName: "Agent", title: "Agent", kind: "think", rawInput: { subagent_type: "Explore", model: "haiku" } })).toEqual({ name: "Explore", model: "haiku" });
    expect(subagentOf(CLAUDE, { toolName: "Task", title: "Explore the auth module", kind: "think", rawInput: { description: "Explore the auth module\nmore" } })).toEqual({ name: "Explore the auth module" });
    // Another tool, or a call whose name isn't said, is no subagent.
    expect(subagentOf(CLAUDE, { toolName: "Read", title: "Read a.ts", kind: "read", rawInput: { description: "x" } })).toBeUndefined();
    expect(subagentOf(CLAUDE, { title: "Task", kind: "think" })).toBeUndefined();
  });

  test("MOSS's own: the runtime's Agent tool by the call's title (its coding agent) or kind (its in-process subagents)", () => {
    expect(subagentOf(MOSS_CODE_QUIRKS.subagents, { title: "Agent", kind: "other", rawInput: { description: "Map the tests", model: "anthropic/claude-haiku-5" } })).toEqual({ name: "Map the tests", model: "anthropic/claude-haiku-5" });
    expect(subagentOf(MOSS_CODE_QUIRKS.subagents, { title: "Bash ls", kind: "execute" })).toBeUndefined();
    expect(subagentOf(IN_PROCESS_QUIRKS.subagents, { title: "Agent", kind: "Agent", rawInput: { subagent_type: "general" } })).toEqual({ name: "general" });
  });

  test("every bundled agent declares the quirk: Claude Code its frames, every other one none known", () => {
    const folders = readdirSync(PLUGINS).filter((f) => f.startsWith("agent-"));
    expect(folders.length).toBeGreaterThan(5);
    for (const f of folders) {
      const q = bundledQuirks(f);
      expect(q.subagents === null || f === "agent-claude-code").toBe(true);
    }
  });
});

const spec = (): AgentStartSpec => ({
  sessionId: "s_agent", root: "/Users/me/project1", fence: new FakeFence({ home: "/Users/me", mossHome: "/Users/me/.moss" }).policy(),
  bridge: { name: "moss-bridge", command: "/opt/moss/moss-core", args: ["bridge"], env: { MOSS_BRIDGE_TOKEN: "placeholder" }, tools: ["SendMessage", "Glossary"] },
});
let n = 0;

async function eventsOf(quirks: AgentQuirks, script: FakeAcpStep[]): Promise<AgentEvent[]> {
  const h = acpHarness(join(root, `agent-${++n}`), { id: "fake", clock: new FakeClock(), quirks, script: [script] as never });
  const s = await h.start(spec());
  const events: AgentEvent[] = [];
  s.onEvent((e) => { if (e.type !== "progress") events.push(e); });
  try {
    await s.prompt({ text: "go" });
  } finally {
    await s.stop();
  }
  return events;
}

describe("Claude Code's frames through MOSS's ACP client", () => {
  test("a Task call is said a subagent, renamed once its input arrives; the subagent's own calls are not; its end is the call's", async () => {
    const quirks: AgentQuirks = { ...WELL_BEHAVED_QUIRKS, subagents: CLAUDE };
    const events = await eventsOf(quirks, [{ raw: claudeTaskFrames("toolu_1", "completed") }, { say: "done" }]);
    expect(events.filter((e) => e.type === "subagent")).toEqual([
      { type: "subagent", id: "toolu_1", name: "Task" },
      { type: "subagent", id: "toolu_1", name: "Explore the auth module", model: "haiku" },
    ]);
    expect(events.filter((e) => e.type === "tool_call_update" && e.id === "toolu_1").map((e) => (e as { status: string }).status)).toEqual(["completed"]);
  }, 30_000);

  test("an agent that declares none gets no subagent from the same frames", async () => {
    const events = await eventsOf({ ...WELL_BEHAVED_QUIRKS, subagents: null }, [{ raw: claudeTaskFrames("toolu_1", "failed") }]);
    expect(events.some((e) => e.type === "subagent")).toBe(false);
  }, 30_000);
});

describe("the driver's record", () => {
  test("a subagent the agent says becomes the session's agent_subagent record, beside its call", async () => {
    const fns = new Listeners<AgentEvent>();
    const session: AgentSession = {
      agentSessionId: "a1", state: () => "ready", cancel: async () => {}, setConfig: async () => {}, stop: async () => {},
      onPermission: () => {}, onEvent: (fn) => fns.add(fn), lastProgressAt: () => 0,
      prompt: async () => {
        fns.emit({ type: "tool_call", id: "toolu_1", kind: "think", title: "Task", status: "pending", rawInput: {} });
        fns.emit({ type: "subagent", id: "toolu_1", name: "Explore", model: "haiku" });
        fns.emit({ type: "tool_call_update", id: "toolu_1", status: "completed" });
        return { stopReason: "end_turn", text: "ok" };
      },
    };
    const driver = new AgentDriver({ start: async () => session, promptOf: async (i) => ({ text: "text" in i ? i.text : "" }) });
    const recorded: { type: string; [k: string]: unknown }[] = [];
    const ctl: TurnControl = { origin: "user", signal: new AbortController().signal, onFold: () => () => {}, record: (e) => recorded.push(e) };
    await driver.turn({ from: "user", text: "go", device: "d", sentAt: 1, clientMessageId: "m1" }, ctl);
    expect(recorded.filter((e) => e.type !== "agent_started").map((e) => e.type)).toEqual(["agent_tool_call", "agent_subagent", "agent_tool_call_update"]);
    expect(recorded.find((e) => e.type === "agent_subagent")).toEqual({ type: "agent_subagent", id: "toolu_1", name: "Explore", model: "haiku" });
  });
});
