// The guard around ONE real agent program in a `--real-agents` preview (real-lib.ts says why): the engine starts this where it would start the agent, and this
// starts the real program with its real HOME and a PATH of a few folders, and keeps the run's hard budget on the ACP lines that pass between them.
//   --agent <program name>  --budget <folder>  --real <program>  --home <real home>  --path <PATH>  -- <the arguments the engine gave>
// A version or help probe passes straight through and counts as nothing. Anything else is a session: the third session of an agent is refused (the guard
// ends with a plain line), a prompt that is not one line of text is answered with an error and never reaches the agent, the fourth turn of a session likewise,
// and a turn that outlives BUDGET.turnMs is cancelled and then its process ended. It opens no file but the budget's counters and reads nothing of the agent's.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { BUDGET, claimSession, noteRefusal, noteTurn, promptProblem } from "./real-lib";

const argv = process.argv.slice(2);
const cut = argv.indexOf("--");
const flags = argv.slice(0, cut < 0 ? argv.length : cut);
const rest = cut < 0 ? [] : argv.slice(cut + 1);
const flag = (n: string): string => { const v = flags[flags.indexOf(n) + 1]; if (flags.indexOf(n) < 0 || v === undefined) { process.stderr.write(`real-guard: ${n} is required\n`); process.exit(2); } return v!; };
const agent = flag("--agent"), budget = flag("--budget"), real = flag("--real"), home = flag("--home"), path = flag("--path");
const turnMs = Number(process.env.MOSS_PREVIEW_GUARD_TURN_MS) > 0 ? Number(process.env.MOSS_PREVIEW_GUARD_TURN_MS) : BUDGET.turnMs;

// The two names the real program gets that the engine did not give it; everything else is what the engine gave an agent (it strips MOSS_* itself).
const env: Record<string, string | undefined> = { ...process.env, HOME: home, PATH: path };
for (const k of Object.keys(env)) if (/^MOSS_/i.test(k)) delete env[k];

const probe = rest.some((a) => a === "--version" || a === "-V" || a === "--help" || a === "-h");
if (!probe) {
  const n = claimSession(budget, agent);
  if (n === undefined) {
    noteRefusal(budget, agent, "a session beyond the budget");
    process.stderr.write(`real-guard: ${agent}: the preview's budget is ${BUDGET.sessionsPerAgent} sessions per agent and they are spent\n`);
    process.exit(1);
  }
}

const child = spawn(real, rest, { env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "inherit"] });
child.on("error", (e) => { process.stderr.write(`real-guard: ${agent}: cannot start ${real}: ${e.message}\n`); process.exit(127); });
child.on("exit", (code, sig) => process.exit(code ?? (sig === null ? 1 : 128)));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } setTimeout(() => process.exit(0), 2_000).unref(); });

if (probe) {
  process.stdin.pipe(child.stdin!);
  child.stdout!.pipe(process.stdout);
} else {
  let turns = 0;
  let active: { id: unknown; sessionId: unknown; timer: ReturnType<typeof setTimeout> } | undefined;
  const reply = (id: unknown, why: string): void => {
    noteRefusal(budget, agent, why);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: `preview budget: ${why}` } })}\n`);
  };
  createInterface({ input: process.stdin }).on("line", (line) => {
    let m: { id?: unknown; method?: string; params?: { sessionId?: unknown; prompt?: unknown } } | undefined;
    try { m = JSON.parse(line); } catch { /* not JSON: passed on as it is */ }
    if (m?.method === "session/prompt") {
      const bad = turns >= BUDGET.turnsPerSession ? `a session is ${BUDGET.turnsPerSession} turns and they are spent` : promptProblem(m.params?.prompt);
      if (bad !== undefined) { reply(m.id, bad); return; }
      turns++;
      noteTurn(budget, agent);
      const sessionId = m.params?.sessionId;
      const timer = setTimeout(() => {
        noteRefusal(budget, agent, `a turn over ${Math.round(turnMs / 1000)} s: cancelled`);
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } })}\n`);
        setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* gone */ } }, BUDGET.cancelGraceMs).unref();
      }, turnMs);
      active = { id: m.id, sessionId, timer };
    }
    child.stdin!.write(`${line}\n`);
  }).on("close", () => child.stdin!.end());
  createInterface({ input: child.stdout! }).on("line", (line) => {
    try {
      const m = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown; method?: string };
      if (active !== undefined && m.id === active.id && m.method === undefined && (m.result !== undefined || m.error !== undefined)) { clearTimeout(active.timer); active = undefined; }
    } catch { /* passed on as it is */ }
    process.stdout.write(`${line}\n`);
  });
}
