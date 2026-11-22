// The guard around ONE real agent program in a `--real-agents` preview (real-lib.ts says why): the engine starts this where it would start the agent, and this
// starts the real program with its real HOME and a PATH of a few folders, and keeps the run's hard budget on the ACP lines that pass between them.
//   --agent <program name>  --budget <folder>  --real <program>  --home <real home>  --path <PATH>  -- <the arguments the engine gave>
// A launch whose WHOLE argument list is the engine's version probe (--version) passes straight through and counts as nothing. Any other launch is counted and
// bounded (BUDGET.launchesPerAgent), but takes a SESSION slot only at its first session/new (or first prompt): a capability, model-list or usage launch spends none.
// The third session of an agent is refused, a line that is not ONE JSON-RPC object (a batch, a bare value) never reaches the agent, a prompt that is not one line of
// text is answered with an error, the fourth turn of a session likewise, and a turn that outlives BUDGET.turnMs is cancelled and then its process ended. It opens no file but the budget's counters and reads nothing of the agent's.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { BUDGET, SESSION_METHODS, claimSession, classifyLine, isProbe, noteLaunch, noteRefusal, noteTurn, promptProblem } from "./real-lib";

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

const probe = isProbe(rest);
if (!probe && noteLaunch(budget, agent) === undefined) {
  noteRefusal(budget, agent, "a launch beyond the budget");
  process.stderr.write(`real-guard: ${agent}: the preview's budget is ${BUDGET.launchesPerAgent} launches per agent and they are spent\n`);
  process.exit(1);
}

const child = spawn(real, rest, { env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "inherit"] });
child.on("error", (e) => { process.stderr.write(`real-guard: ${agent}: cannot start ${real}: ${e.message}\n`); process.exit(127); });
child.on("exit", (code, sig) => process.exit(code ?? (sig === null ? 1 : 128)));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, () => { try { child.kill(sig); } catch { /* gone */ } setTimeout(() => process.exit(0), 2_000).unref(); });

if (probe) {
  process.stdin.pipe(child.stdin!);
  child.stdout!.pipe(process.stdout);
} else {
  const turns = new Map<string, number>();
  let claimed = 0;
  let active: { id: unknown; sessionId: unknown; timer: ReturnType<typeof setTimeout> } | undefined;
  const reply = (id: unknown, why: string): void => {
    noteRefusal(budget, agent, why);
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code: -32000, message: `preview budget: ${why}` } })}\n`);
  };
  /** A session slot, once per session this process starts (a prompt with none started yet claims one); false when the agent's slots are spent. */
  const slot = (): boolean => {
    if (claimSession(budget, agent) === undefined) return false;
    claimed++;
    return true;
  };
  createInterface({ input: process.stdin }).on("line", (line) => {
    const c = classifyLine(line);
    if (c.kind === "refused") { reply(null, `${c.why} is not passed to the agent`); return; }
    const m = c.msg;
    if (typeof m.method === "string" && SESSION_METHODS.includes(m.method)) {
      if (!slot()) { reply(m.id, `a session beyond the budget (${BUDGET.sessionsPerAgent} per agent)`); return; }
    } else if (m.method === "session/prompt") {
      const sessionId = typeof m.params?.sessionId === "string" ? m.params.sessionId : "";
      const bad = (turns.get(sessionId) ?? 0) >= BUDGET.turnsPerSession ? `a session is ${BUDGET.turnsPerSession} turns and they are spent` : promptProblem(m.params?.prompt);
      if (bad !== undefined) { reply(m.id, bad); return; }
      if (claimed === 0 && !slot()) { reply(m.id, `a session beyond the budget (${BUDGET.sessionsPerAgent} per agent)`); return; }
      turns.set(sessionId, (turns.get(sessionId) ?? 0) + 1);
      noteTurn(budget, agent);
      const timer = setTimeout(() => {
        noteRefusal(budget, agent, `a turn over ${Math.round(turnMs / 1000)} s: cancelled`);
        child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: m.params?.sessionId } })}\n`);
        setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* gone */ } }, BUDGET.cancelGraceMs).unref();
      }, turnMs);
      active = { id: m.id, sessionId: m.params?.sessionId, timer };
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
