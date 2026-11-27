// MOSS's own coding agent tells its session's background tasks (spec revision 20, §9.5 "Waiting"): the runtime's task
// frames, a task that ends after its turn included; a foreground command and a subagent's own frames never count; when
// the runtime ends, its tasks end with it.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Options } from "@waifucave/clover-agent-sdk";
import { FakeFence } from "../../contracts/fakes/fence";
import { MossCodeBackend, noteToolFrames, reportingTasks, type MossCodeDeps } from "../moss-code/backend";
import { waitFor } from "./world";

const root = realpathSync(mkdtempSync(join(tmpdir(), "moss-code-tasks-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const MODEL = "winter-test/calls";
const frame = (subtype: string, task: string, more: Record<string, unknown> = {}) => ({ type: "system", subtype, task_id: task, uuid: `u-${task}-${subtype}`, session_id: "x", ...more });

/** A runtime whose first turn starts a background command and a monitor, and whose second sees the command end. */
function fakeQuery(): MossCodeDeps["query"] {
  return ((args: { prompt: AsyncIterable<string>; options: Options }) => {
    async function* run() {
      yield { type: "system", subtype: "init", model: MODEL, permissionMode: "default" };
      let i = 0;
      for await (const _ of args.prompt) {
        i++;
        if (i === 1) {
          yield frame("task_started", "bash_1", { description: "npm test", is_backgrounded: true });
          yield frame("task_started", "fg_1", { description: "ls", is_backgrounded: false });
          yield frame("task_started", "sub_task", { description: "inner", parent_tool_use_id: "toolu_9" });
          yield frame("task_started", "monitor_1", { description: "watch the log" });
        }
        yield { type: "assistant", message: { content: [{ type: "text", text: `reply ${i}` }] } };
        yield { type: "result", subtype: "success", is_error: false, result: `reply ${i}`, usage: { input_tokens: 1, output_tokens: 1 } };
        // Between turns: the command ends (the runtime would start a turn of its own with the notification).
        if (i === 2) yield frame("task_notification", "bash_1", { status: "completed", output_file: "", summary: "done" });
      }
    }
    return Object.assign(run(), { interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, setEffort: async () => {}, supportedModels: async () => [] });
  }) as unknown as MossCodeDeps["query"];
}

describe("MOSS's coding agent's background tasks", () => {
  test("each task that will wake the session is told as it starts and ends, a late end too; the runtime's end ends the rest", async () => {
    const told: string[] = [];
    const fence = new FakeFence({ home: root, mossHome: join(root, ".moss") });
    const backend = new MossCodeBackend({
      clock: { now: () => Date.now() } as never, defaultModel: () => MODEL, sandboxReady: () => true, pause: { mayAct: () => true },
      baseOptions: (o) => ({ model: o.model, cwd: o.cwd, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, settingSources: [] }) as Options,
      query: fakeQuery(),
      tasks: { started: (s, t) => told.push(`${s}+${t}`), ended: (s, t) => told.push(`${s}-${t}`), gone: (s) => told.push(`${s} gone`) },
    });
    const s = await backend.start({ sessionId: "s_code", root, bridge: { name: "moss_testbridge", command: "x", args: [], env: {}, tools: [] }, fence: fence.policy(), inProcessBridge: { type: "sdk", name: "moss_testbridge", instance: {} } as never });
    try {
      await s.prompt({ text: "one" });
      expect(told).toEqual(["s_code+bash_1", "s_code+monitor_1"]);
      await s.prompt({ text: "two" });
      await waitFor(() => told.length === 3, "the command's end");
      expect(told).toEqual(["s_code+bash_1", "s_code+monitor_1", "s_code-bash_1"]);
    } finally {
      await s.stop();
    }
    await waitFor(() => told.at(-1) === "s_code gone", "the runtime's end");
  }, 30_000);

  test("a task updated to a final status ends; one updated to the background starts; a report that throws stops nothing", async () => {
    async function* gen() {
      yield frame("task_started", "t1", { is_backgrounded: false });
      yield frame("task_updated", "t1", { patch: { is_backgrounded: true } });
      yield frame("task_updated", "t1", { patch: { status: "killed" } });
      yield { type: "assistant" };
    }
    const told: string[] = [];
    const q = reportingTasks(gen() as never, {
      started: (t) => { told.push(`+${t}`); throw new Error("no"); },
      ended: (t) => told.push(`-${t}`),
      gone: () => told.push("gone"),
    });
    const out: unknown[] = [];
    for await (const m of q as AsyncIterable<unknown>) out.push(m);
    expect(out.length).toBe(4);
    expect(told).toEqual(["+t1", "-t1", "gone"]);
  });

  test("Windows: the host's own PreToolUse hook answers TaskStop and TaskOutput for this session's core commands; anything else is left to the runtime", async () => {
    let hooks: NonNullable<Options["hooks"]> | undefined;
    const asked: string[] = [];
    const quiet = (args: { prompt: AsyncIterable<string>; options: Options }) => {
      hooks = args.options.hooks;
      async function* run() { yield { type: "system", subtype: "init", model: MODEL, permissionMode: "default" }; for await (const _ of args.prompt) { /* idle */ } }
      return Object.assign(run(), { interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, setEffort: async () => {}, supportedModels: async () => [] });
    };
    const fence = new FakeFence({ home: root, mossHome: join(root, ".moss") });
    const backend = new MossCodeBackend({
      clock: { now: () => Date.now() } as never, defaultModel: () => MODEL, sandboxReady: () => true, pause: { mayAct: () => true },
      baseOptions: (o) => ({ model: o.model, cwd: o.cwd, env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, settingSources: [] }) as Options,
      query: quiet as never,
      windowsTask: async (session, tool, input) => { asked.push(`${session} ${tool} ${JSON.stringify(input)}`); return (input as { task_id?: string }).task_id === "win_bg_00000001" ? { text: "Stopped win_bg_00000001.", isError: false } : null; },
    });
    const s = await backend.start({ sessionId: "s_win", root, bridge: { name: "moss_testbridge", command: "x", args: [], env: {}, tools: [] }, fence: fence.policy(), inProcessBridge: { type: "sdk", name: "moss_testbridge", instance: {} } as never });
    try {
      const own = (hooks?.PreToolUse ?? []).find((m) => m.matcher === "TaskStop|TaskOutput");
      expect(own).toBeDefined();
      const run = async (tool: string, input: unknown) => (await own!.hooks[0]!({ tool_name: tool, tool_input: input } as never, "id", { signal: new AbortController().signal }) ) as { hookSpecificOutput?: { toolResult?: unknown } };
      expect((await run("TaskStop", { task_id: "win_bg_00000001" })).hookSpecificOutput?.toolResult).toEqual({ content: "Stopped win_bg_00000001." });
      // Not this session's (or not a core command's) id: no answer, the runtime's own tool runs.
      expect(await run("TaskStop", { task_id: "bash_1" })).toEqual({});
      expect(asked[0]).toBe('s_win TaskStop {"task_id":"win_bg_00000001"}');
    } finally {
      await s.stop();
    }
  }, 30_000);
});

test("reportingTasks logs each task frame's kind and id, never anything else", async () => {
  const frames = [
    { type: "system", subtype: "task_started", task_id: "t1", is_backgrounded: true, command: "echo SECRET-VALUE" },
    { type: "system", subtype: "task_notification", task_id: "t1", output: "SECRET-OUT" },
  ];
  const q = { async *[Symbol.asyncIterator]() { for (const f of frames) yield f; } } as never;
  const lines: string[] = [];
  const told = reportingTasks(q, { started() {}, ended() {}, gone() {} }, (l) => lines.push(l));
  for await (const _ of told as AsyncIterable<unknown>) { /* drained */ }
  expect(lines).toEqual(["moss-code: task frame task_started t1 backgrounded=true", "moss-code: task frame task_notification t1 backgrounded=unset"]);
  expect(lines.join("\n")).not.toContain("SECRET");
});

test("noteToolFrames logs a shell call's name and background flag and whether its result says background, never the input or output", () => {
  const lines: string[] = [];
  const names = new Map<string, string>();
  noteToolFrames({ type: "assistant", message: { content: [{ type: "tool_use", id: "u1", name: "Bash", input: { command: "echo SECRET-CMD", run_in_background: true } }, { type: "tool_use", id: "u2", name: "Read", input: {} }] } }, names, (l) => lines.push(l));
  noteToolFrames({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "u1", content: "Command running in background SECRET-OUT" }, { type: "tool_result", tool_use_id: "u2", content: "x" }] } }, names, (l) => lines.push(l));
  expect(lines).toEqual(["moss-code: tool call Bash run_in_background=true", "moss-code: tool result of Bash says background=true"]);
  expect(lines.join("\n")).not.toContain("SECRET");
});
