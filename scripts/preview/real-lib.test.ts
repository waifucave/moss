import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUDGET, REAL_AGENTS, claimSession, classifyLine, diffSnapshots, isProbe, noteLaunch, snapshot, guardShim, minimalPath, noteTurn, promptProblem, readSpent, realAgentEnv, renderSpent, resolveReal } from "./real-lib";
import { approvable, seedRefusal } from "./seed";
import { baseEnv, daemonEnv, isolationProblems, layoutFor, parseOptions, UsageError } from "./lib";

describe("which agents are real and what a real agent gets", () => {
  test("only the four the owner allowed", () => {
    expect(REAL_AGENTS.map((a) => a.command).sort()).toEqual(["agy", "claude-agent-acp", "codex-acp", "opencode"]);
  });
  test("found and missing, by a search; an adapter without its CLI is missing", () => {
    const installed: Record<string, string> = { "claude-agent-acp": "/opt/homebrew/bin/claude-agent-acp", claude: "/opt/homebrew/bin/claude", node: "/opt/homebrew/bin/node", "codex-acp": "/opt/homebrew/bin/codex-acp", opencode: "/Users/u/.local/bin/opencode" };
    const r = resolveReal((p) => installed[p]);
    expect(r.found.map((f) => f.backend)).toEqual(["claude-code", "opencode"]);
    expect(r.missing.map((m) => [m.backend, m.why])).toEqual([["codex", "codex-acp needs codex, which is not installed"], ["antigravity", "agy is not installed (not on the search path)"]]);
    expect(r.folders).toEqual(["/opt/homebrew/bin", "/Users/u/.local/bin"]);
  });
  test("the environment is two names: the real HOME and a PATH of the program folders and the system's", () => {
    const e = realAgentEnv("/Users/u", ["/opt/homebrew/bin", "/opt/homebrew/bin", "relative/bin"]);
    expect(Object.keys(e).sort()).toEqual(["HOME", "PATH"]);
    expect(e.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    expect(minimalPath([])).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(() => realAgentEnv("relative", [])).toThrow();
    expect(() => realAgentEnv("/", [])).toThrow();
  });
  test("the shim runs the guard with the names, quoted", () => {
    const t = guardShim({ bun: "/b/bun", guard: "/r/g.ts", agent: "codex-acp", budget: "/t/b", real: "/opt/h's/codex-acp", env: { HOME: "/Users/u", PATH: "/a:/b" } });
    expect(t.startsWith("#!/bin/sh\nexec '/b/bun' '/r/g.ts' --agent 'codex-acp'")).toBe(true);
    expect(t).toContain("--real '/opt/h'\\''s/codex-acp'");
    expect(t).toContain("--home '/Users/u' --path '/a:/b' -- \"$@\"");
  });
  test("the engine's own environment stays the throwaway one whatever the agents get", () => {
    const layout = layoutFor("/tmp/mprev-abc123");
    const input = { layout, service: "com.waifucave.moss.core.test.preview-deadbeef", bunDir: "/b" };
    const d = daemonEnv({ ...input, runPid: 1, usageInert: { MOSS_USAGE_INERT: "1" } });
    expect(d.HOME).toBe("/tmp/mprev-abc123/user");
    expect(d.PATH).not.toContain("/opt/homebrew");
    expect(isolationProblems(d, layout, "/Users/u")).toEqual([]);
    expect(baseEnv(input).MOSS_LOGIN_SHELL_PATH).toBe("off");
    // a real home in the engine's environment is a leak
    expect(isolationProblems({ ...d, HOME: "/Users/u" }, layout, "/Users/u").join(" ")).toContain("HOME is /Users/u");
  });
  test("--real-agents needs --control, and goes with neither --shot nor --stop", () => {
    expect(parseOptions(["--control", "--real-agents"]).realAgents).toBe(true);
    expect(parseOptions(["--control", "--headless", "--real-agents"]).realAgents).toBe(true);
    expect(parseOptions(["--control"]).realAgents).toBe(false);
    expect(() => parseOptions(["--real-agents"])).toThrow(UsageError);
    expect(() => parseOptions(["--stop", "--real-agents"])).toThrow(UsageError);
  });
});

describe("the prompt rule", () => {
  const t = (text: string) => [{ type: "text", text }];
  test("one line of text, at most the limit", () => {
    expect(promptProblem(t("Reply with the single word OK."))).toBeUndefined();
    expect(promptProblem(t("Message from agent agent_abc123:\n\nThe API changed."))).toBeUndefined();
    expect(promptProblem(t("a\nb"))).toContain("one line");
    expect(promptProblem(t("x".repeat(BUDGET.promptChars + 1)))).toContain("at most");
    expect(promptProblem(t("x".repeat(BUDGET.promptChars)))).toBeUndefined();
    expect(promptProblem([])).toContain("no content");
    expect(promptProblem("OK")).toContain("no content");
    expect(promptProblem([{ type: "image", data: "x" }])).toContain("text prompts only");
    expect(promptProblem([...t("OK"), { type: "resource_link", uri: "file:///x" }])).toContain("text prompts only");
    // the frame line is not a second line, but its characters count
    const frame = "Message from agent agent_abc123:";
    expect(promptProblem(t(`${frame}\n\n${"x".repeat(BUDGET.promptChars - frame.length)}`))).toBeUndefined();
    expect(promptProblem(t(`${frame}\n\n${"x".repeat(BUDGET.promptChars - frame.length + 1)}`))).toContain("included");
    expect(promptProblem(t("preamble\n\n---\n\nthe prompt"))).toContain("one line");
    expect(promptProblem(t(""))).toContain("0");
  });
});

describe("the budget's counters", () => {
  test("two sessions per agent, then none; turns and refusals are counted and said", () => {
    const dir = mkdtempSync(join(tmpdir(), "mprev-test-"));
    try {
      expect(claimSession(dir, "codex-acp")).toBe(1);
      expect(claimSession(dir, "codex-acp")).toBe(2);
      expect(claimSession(dir, "codex-acp")).toBeUndefined();
      expect(claimSession(dir, "agy")).toBe(1);
      noteTurn(dir, "codex-acp"); noteTurn(dir, "codex-acp");
      const s = readSpent(dir);
      expect(s.find((x) => x.agent === "codex")).toEqual({ agent: "codex", approvals: 0, launches: 0, sessions: 2, turns: 2, refusals: 0 });
      expect(s.find((x) => x.agent === "antigravity")).toMatchObject({ sessions: 1, turns: 0 });
      expect(renderSpent(s)).toContain("codex 0 launch(es) 0 approval(s) 2 session(s) 2 turn(s)");
      expect(renderSpent(s)).toContain("limits: 12 launches and 2 sessions per agent, 3 turns per session");
      expect(noteLaunch(dir, "agy", 2)).toBe(1);
      expect(noteLaunch(dir, "agy", 2)).toBe(2);
      expect(noteLaunch(dir, "agy", 2)).toBeUndefined();
      expect(readSpent(dir).find((x) => x.agent === "antigravity")).toMatchObject({ launches: 2, sessions: 1 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("the guard around a program (a stand-in agent that echoes prompts)", () => {
  const dir = mkdtempSync(join(tmpdir(), "mprev-test-"));
  // The "real" program: prints its HOME and PATH and the names starting MOSS_ it was given, answers each session/prompt after an optional delay.
  const prog = join(dir, "prog.js");
  writeFileSync(prog, `#!${process.execPath}
if (process.argv.includes("--version")) { console.log("1.2.3 " + process.env.HOME + " " + process.env.PATH + " " + Object.keys(process.env).filter((k) => k.startsWith("MOSS_")).join(",")); process.exit(0); }
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (l) => { const m = JSON.parse(l); if (m.method === "session/prompt") { const d = Number(process.env.DELAY || 0); setTimeout(() => console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn", saw: [process.env.HOME] } })), d); } if (m.method === "session/cancel") console.log(JSON.stringify({ jsonrpc: "2.0", method: "cancelled" })); });
`);
  chmodSync(prog, 0o755);
  const guard = join(import.meta.dir, "real-guard.ts");
  const run = (budget: string, lines: unknown[], extra: Record<string, string> = {}, args: string[] = ["acp"], waitMs = 1500) => new Promise<{ out: string[]; code: number | null }>((ok) => {
    const c = spawn(process.execPath, [guard, "--agent", "codex-acp", "--budget", budget, "--real", prog, "--home", "/real/home", "--path", "/real/bin:/usr/bin", "--", ...args], { env: { PATH: "/usr/bin", HOME: "/throwaway", MOSS_SECRET: "x", ...extra }, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    for (const l of lines) c.stdin.write(`${JSON.stringify(l)}\n`);
    let code: number | null = null;
    c.on("exit", (x) => { code = x; });
    setTimeout(() => { c.kill("SIGTERM"); setTimeout(() => ok({ out: out.split("\n").filter(Boolean), code }), 300); }, waitMs);
  });
  const prompt = (id: number, text: string) => ({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: "s1", prompt: [{ type: "text", text }] } });

  test("a version probe passes through with the real HOME and PATH and no MOSS_ name, and counts as nothing", async () => {
    const b = join(dir, "b1");
    const r = await run(b, [], {}, ["--version"], 800);
    expect(r.out[0]).toBe("1.2.3 /real/home /real/bin:/usr/bin ");
    expect(readSpent(b).find((x) => x.agent === "codex")).toMatchObject({ sessions: 0, turns: 0 });
  }, 15_000);

  test("prompts reach the program with the real HOME; a long one, a fourth turn and a third session do not", async () => {
    const b = join(dir, "b2");
    const r = await run(b, [prompt(1, "Reply with the single word OK."), prompt(2, "line\nline"), prompt(3, "again"), prompt(4, "again"), prompt(5, "one too many")]);
    const answers = r.out.map((l) => JSON.parse(l));
    expect(answers.find((a) => a.id === 1).result.saw).toEqual(["/real/home"]);
    expect(answers.find((a) => a.id === 2).error.message).toContain("one line");
    expect(answers.find((a) => a.id === 3).result).toBeDefined();
    expect(answers.find((a) => a.id === 4).result).toBeDefined();
    expect(answers.find((a) => a.id === 5).error.message).toContain("3 turns");
    expect(readSpent(b).find((x) => x.agent === "codex")).toEqual({ agent: "codex", approvals: 0, launches: 1, sessions: 1, turns: 3, refusals: 2 });
    // a second launch's first prompt takes the second slot; the third launch's is refused, with an answer
    const second = await run(b, [prompt(1, "ok")]);
    expect(second.out.map((l) => JSON.parse(l))[0].result).toBeDefined();
    const third = await run(b, [prompt(1, "ok")]);
    expect(JSON.parse(third.out[0]!).error.message).toContain("session beyond the budget");
    expect(readSpent(b).find((x) => x.agent === "codex")).toMatchObject({ launches: 3, sessions: 2, turns: 4 });
  }, 30_000);

  test("a launch that sends no prompt takes no session; session/new takes one each; launches are counted apart", async () => {
    const b = join(dir, "b4");
    await run(b, [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }], {}, ["acp"], 2000);
    await run(b, [], {}, ["models"], 2000);
    expect(readSpent(b).find((x) => x.agent === "codex")).toMatchObject({ launches: 2, sessions: 0, turns: 0 });
    const n = (id: number) => ({ jsonrpc: "2.0", id, method: "session/new", params: {} });
    const r = await run(b, [n(1), n(2), n(3)]);
    expect(r.out.map((l) => JSON.parse(l)).find((a) => a.id === 3).error.message).toContain("session beyond the budget");
    expect(readSpent(b).find((x) => x.agent === "codex")).toMatchObject({ sessions: 2 });
  }, 30_000);

  test("a batch and anything that is not one JSON-RPC object never reach the program", async () => {
    const b = join(dir, "b5");
    const r = await run(b, [[prompt(1, "ok"), prompt(2, "ok")], 7, "text", prompt(3, "ok")]);
    const answers = r.out.map((l) => JSON.parse(l));
    expect(answers.filter((a) => a.error).length).toBe(3);
    expect(answers.find((a) => a.id === 3).result).toBeDefined();
    expect(readSpent(b).find((x) => x.agent === "codex")).toMatchObject({ turns: 1, refusals: 3 });
  }, 15_000);

  test("only the whole --version list is a probe: other arguments, even with it, are launches", async () => {
    const b = join(dir, "b6");
    await run(b, [], {}, ["--version"], 2500);
    expect(readSpent(b).find((x) => x.agent === "codex")).toMatchObject({ launches: 0 });
    const r = await run(b, [prompt(1, "ok")], {}, ["acp", "--version"], 3000);
    expect(r.out.length).toBe(1);
    expect(readSpent(b).find((x) => x.agent === "codex")).toMatchObject({ launches: 1, turns: 1 });
    await run(b, [], {}, ["--help"], 2500);
    expect(readSpent(b).find((x) => x.agent === "codex")).toMatchObject({ launches: 2 });
  }, 20_000);

  test("a turn over the limit is cancelled", async () => {
    const b = join(dir, "b3");
    const r = await run(b, [prompt(1, "slow")], { DELAY: "60000", MOSS_PREVIEW_GUARD_TURN_MS: "400" }, ["acp"], 1500);
    expect(r.out.some((l) => l.includes("cancelled"))).toBe(true);
    expect(readFileSync(join(b, "codex-acp.refused"), "utf8")).toContain("cancelled");
  }, 15_000);

  test("cleanup", () => { rmSync(dir, { recursive: true, force: true }); });
});

describe("the listing that shows the engine wrote nothing under a home", () => {
  test("names and times only; an added, removed or touched entry shows, an untouched folder does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "mprev-test-"));
    try {
      mkdirSync(join(dir, "a", "b"), { recursive: true });
      writeFileSync(join(dir, "a", "b", "f"), "secret contents are never read");
      const before = snapshot(dir);
      expect(before.has(join(dir, "a", "b", "f"))).toBe(true);
      expect(diffSnapshots(before, snapshot(dir))).toEqual({ added: [], removed: [], changed: [] });
      writeFileSync(join(dir, "new"), "x");
      utimesSync(join(dir, "a", "b", "f"), new Date(1_000_000), new Date(1_000_000));
      rmSync(join(dir, "a", "b"), { recursive: true });
      const d = diffSnapshots(before, snapshot(dir));
      expect(d.added).toEqual([join(dir, "new")]);
      expect(d.removed.sort()).toEqual([join(dir, "a", "b"), join(dir, "a", "b", "f")].sort());
      expect(snapshot(join(dir, "missing")).size).toBe(0);
      expect(snapshot(dir, 2).size).toBeLessThanOrEqual(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("probe and line rules, pure", () => {
  test("a probe is exactly --version", () => {
    expect(isProbe(["--version"])).toBe(true);
    for (const a of [[], ["-V"], ["--help"], ["-h"], ["acp", "--version"], ["--version", "x"], ["--version", "--help"]]) expect(isProbe(a)).toBe(false);
  });
  test("one JSON object passes; arrays and bare values do not", () => {
    expect(classifyLine('{"jsonrpc":"2.0","id":1,"method":"x"}').kind).toBe("object");
    for (const l of ["[]", '[{"method":"session/prompt"}]', "7", "null", '"s"', "nope", ""]) expect(classifyLine(l).kind).toBe("refused");
  });
});

describe("the seeding poller in a real-agents preview", () => {
  const card = (session?: string) => ({ id: "c1", hash: "h", ...(session !== undefined ? { session } : {}), options: [{ id: "no", kind: "deny" }, { id: "yes", kind: "approve" }] });
  test("approves only a card of a session the seeding started", () => {
    expect(approvable(card("s_mine"), true, new Set(["s_mine"]))?.id).toBe("yes");
    expect(approvable(card("s_real"), true, new Set(["s_mine"]))).toBeUndefined();
    expect(approvable(card(), true, new Set(["s_mine"]))).toBeUndefined();
    expect(approvable(card("s_real"), false, new Set())?.id).toBe("yes");
  });
  test("seed is refused once a real session exists, and says so", () => {
    expect(seedRefusal([{ id: "a", backend: "moss-code" }, { id: "b", backend: "gemini" }])).toBeUndefined();
    expect(seedRefusal([{ id: "a", backend: "moss-code" }, { id: "b", backend: "codex" }])).toContain("seed is refused");
    expect(seedRefusal([{ id: "x" }])).toBeUndefined();
  });
});
