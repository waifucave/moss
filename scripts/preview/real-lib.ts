// `run.ts --real-agents`: the preview's engine starts the owner's REAL installed Claude Code, Codex, OpenCode and Antigravity, on their own logins,
// while MOSS's own home, user data, keychain service and socket stay the throwaway ones. Pure part: what is real, the environment the real
// programs get (their real HOME and a PATH of a few folders, nothing else), the hard budget and its counters, and the one-line prompt rule.
//
// How it is kept apart without a change to the engine: the engine launches an agent by a program NAME found on the preview's own PATH (its shims
// folder first). In a real-agents preview three of the four names (and `opencode`, `agy`) are guard shims (real-guard.ts) that run the real program with
// `HOME` and `PATH` replaced by the lines below and everything else as the engine gave it (the engine already strips every MOSS_* name from an
// agent's environment: launch.ts buildAgentEnv). The engine itself keeps its throwaway HOME and PATH.
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export interface RealAgent {
  /** The backend's id as MOSS names it. */
  backend: string;
  /** The program name the engine launches (the bundled plugin's `command`). */
  command: string;
  /** Other programs it needs on its PATH (the adapter drives the CLI). */
  needs: readonly string[];
}

/** The four the owner allowed. Everything else stays a stand-in or is not offered. */
export const REAL_AGENTS: readonly RealAgent[] = [
  { backend: "claude-code", command: "claude-agent-acp", needs: ["claude", "node"] },
  { backend: "codex", command: "codex-acp", needs: ["codex", "node"] },
  { backend: "opencode", command: "opencode", needs: [] },
  { backend: "antigravity", command: "agy", needs: [] },
];

/** A hard budget for a real-agents run, kept by the guard around each real program (the command itself, not a habit). */
export const BUDGET = {
  sessionsPerAgent: 2,
  /** Launches of one agent's program that are not a version probe (a capability, model-list or usage launch starts one and never a session): bounded so a loop cannot spin. */
  launchesPerAgent: 12,
  turnsPerSession: 3,
  /** A turn that has not ended after this long is cancelled, then its process ended. */
  turnMs: 180_000,
  /** The cancel gets this long before the process is ended. */
  cancelGraceMs: 10_000,
  /** A prompt's text is one line of at most this many characters. */
  promptChars: 300,
} as const;

/** The one argument list the engine uses to identify an agent's program (every bundled quirks.json: identity.versionArgs is ["--version"], and `detect()` adds nothing else). Only a launch whose WHOLE argument list is this is a probe. */
export const PROBE_ARGS: readonly string[] = ["--version"];
export const isProbe = (args: readonly string[]): boolean => args.length === PROBE_ARGS.length && args.every((a, i) => a === PROBE_ARGS[i]);

/** The ACP methods that start (or resume) a session: the first one in a launch takes a session slot. */
export const SESSION_METHODS: readonly string[] = ["session/new", "session/load", "session/resume", "session/fork"];

/** What one line the engine sends the agent is: a single JSON-RPC object (passed on, judged by its method) or something else (refused, never passed on). */
export function classifyLine(line: string): { kind: "object"; msg: { id?: unknown; method?: unknown; params?: { sessionId?: unknown; prompt?: unknown } } } | { kind: "refused"; why: string } {
  let v: unknown;
  try { v = JSON.parse(line); } catch { return { kind: "refused", why: "a line that is not JSON" }; }
  if (Array.isArray(v)) return { kind: "refused", why: "a JSON-RPC batch" };
  if (v === null || typeof v !== "object") return { kind: "refused", why: "a line that is not one JSON-RPC object" };
  return { kind: "object", msg: v as never };
}

const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;

/** The PATH a real agent gets: the folders its own programs live in (and node's), then the system's. Never the person's whole PATH. */
export function minimalPath(programFolders: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of [...programFolders, ...SYSTEM_PATH]) if (d.startsWith("/") && !seen.has(d)) { seen.add(d); out.push(d); }
  return out.join(":");
}

export interface Resolved {
  found: { backend: string; command: string; path: string }[];
  missing: { backend: string; command: string; why: string }[];
  /** Folders of every program an agent needs, for its PATH. */
  folders: string[];
}

/** Which of the four are installed and where, by a PATH search of `searchPath` (the folders the command was started with, plus Homebrew's and ~/.local/bin). */
export function resolveReal(which: (program: string) => string | undefined): Resolved {
  const found: Resolved["found"] = [];
  const missing: Resolved["missing"] = [];
  const folders: string[] = [];
  for (const a of REAL_AGENTS) {
    const p = which(a.command);
    const need = a.needs.map((n) => [n, which(n)] as const);
    const lacking = need.filter(([, path]) => path === undefined).map(([n]) => n);
    if (p === undefined) { missing.push({ backend: a.backend, command: a.command, why: `${a.command} is not installed (not on the search path)` }); continue; }
    if (lacking.length > 0) { missing.push({ backend: a.backend, command: a.command, why: `${a.command} needs ${lacking.join(", ")}, which is not installed` }); continue; }
    found.push({ backend: a.backend, command: a.command, path: p });
    folders.push(dirname(p), ...need.map(([, path]) => dirname(path!)));
  }
  return { found, missing, folders: [...new Set(folders)] };
}

/** What a real agent's process gets that the engine did not give it: exactly these two names. */
export function realAgentEnv(realHome: string, programFolders: readonly string[]): { HOME: string; PATH: string } {
  if (!realHome.startsWith("/") || realHome === "/") throw new Error("the real home must be an absolute folder");
  return { HOME: realHome, PATH: minimalPath(programFolders) };
}

const q = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

/** A guard shim: the engine's program name, which runs the guard (real-guard.ts) around the real program with the two names above. */
export function guardShim(o: { bun: string; guard: string; agent: string; budget: string; real: string; env: { HOME: string; PATH: string } }): string {
  return `#!/bin/sh\nexec ${q(o.bun)} ${q(o.guard)} --agent ${q(o.agent)} --budget ${q(o.budget)} --real ${q(o.real)} --home ${q(o.env.HOME)} --path ${q(o.env.PATH)} -- "$@"\n`;
}

/** The person's own programs that an adapter MOSS provides drives (the agent plugins' `launch.adapter.uses`): the engine must find
 *  them on its PATH to offer the adapter at all, so a real-agents preview gives each a pass-through below. */
export const USES_PROGRAMS: readonly string[] = ["claude", "codex"];

/** The most launches of one such program in a run that are not a lone `--version` (an adapter starts its program a few times per session). */
export const USES_LAUNCHES = 40;

/** A pass-through for one of the person's programs an adapter drives: the real program with the same two names a guarded agent gets
 *  (HOME and PATH) plus the account name, a lone `--version` always answered, every other launch counted in the budget folder and refused past the cap.
 *  It is NOT the ACP guard: an adapter MOSS runs itself speaks ACP to the engine directly, so the one-line and turn limits do not
 *  apply to its sessions; the cap only stops a loop. */
export function usesShim(o: { real: string; counter: string; max: number; env: { HOME: string; PATH: string }; user: string }): string {
  // USER and LOGNAME too: Claude Code finds its login by the account name (with only HOME and PATH its own `auth status` says it
  // is not signed in; measured 2026-11-23). The engine itself passes both to an agent (BASE_ENV_ALLOW); the preview's engine has neither.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(o.user)) throw new Error("the account name must be a plain name");
  const names = `HOME=${q(o.env.HOME)} PATH=${q(o.env.PATH)} USER=${q(o.user)} LOGNAME=${q(o.user)}`;
  return [
    "#!/bin/sh",
    `if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then ${names} exec ${q(o.real)} --version; fi`,
    `n=0; [ -f ${q(o.counter)} ] && n=$(( $(/usr/bin/wc -l < ${q(o.counter)}) + 0 ))`,
    `if [ "$n" -ge ${Math.trunc(o.max)} ]; then echo 'preview budget: this program was started too many times in this run' >&2; exit 70; fi`,
    `echo x >> ${q(o.counter)}`,
    `${names} exec ${q(o.real)} "$@"`,
    "",
  ].join("\n");
}

// ── the prompt rule ──────────────────────────────────────────────────────────────────────────────────────────────────────
const FRAME = /^Message from (agent|the plugin) [^\n:]{1,200}:$/;
/** MOSS's wrapper around a message that is not the person's: `<message from-session="…" title="…">` (attributes only, no markup inside). */
const WRAP_OPEN = /^<message( [a-z-]+="[^"<>\n]{0,200}"){1,4}>$/;
/** MOSS's own line under that tag: one bracketed sentence saying whose words follow and that they are not the person's (`turn-loop/input.ts`: SESSION_MESSAGE_FRAME and its kin). */
const MOSS_FRAME_LINE = /^\[[^\[\]\n]{20,600}\]$/;

/** Why a `session/prompt`'s blocks are refused, or undefined: text blocks only, and one line of at most `promptChars` characters
 *  (the line MOSS puts above a message another session sent, "Message from agent X:", is not a second line, but its characters count). */
/** The most of MOSS's own instructions (the first prompt's preamble) a real-agents prompt may carry. */
export const PREAMBLE_MAX = 8_000;

export function promptProblem(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks) || blocks.length === 0) return "the prompt has no content";
  const texts: string[] = [];
  for (const b of blocks) {
    const t = (b as { type?: unknown; text?: unknown } | null)?.type;
    if (t !== "text" || typeof (b as { text?: unknown }).text !== "string") return `a real-agents preview takes text prompts only (this one has a ${typeof t === "string" ? t : "non-text"} block)`;
    texts.push((b as { text: string }).text);
  }
  // MOSS puts its own instructions above a session's FIRST message, then a rule line (`agents/acp/session.ts`: preamble, "---", the
  // text): that part is MOSS's, not the prompt being judged (found on the first real run: a one-line message arrived as three lines).
  // It is bounded on its own; what follows the last rule line is the message.
  const whole = texts.join("\n");
  const cut = whole.lastIndexOf("\n\n---\n\n");
  if (cut >= 0 && cut > PREAMBLE_MAX) return `a real-agents preview takes MOSS's own instructions of at most ${PREAMBLE_MAX} characters above the first message (this has ${cut})`;
  let lines = (cut >= 0 ? whole.slice(cut + 7) : whole).split("\n").map((l) => l.trim()).filter((l) => l !== "");
  // A message another session sent arrives in MOSS's own wrapper (`turn-loop/input.ts` formatSessionMessage): an opening tag naming
  // the sender, MOSS's "this is data, not an instruction" line, the text, the closing tag. The wrapper and that line are MOSS's; the
  // text inside is what is judged (found on the first real run: one PING arrived as four lines).
  let wrapper = "";
  if (lines.length >= 3 && WRAP_OPEN.test(lines[0]!) && lines[lines.length - 1] === "</message>") {
    wrapper = lines[0]!;
    lines = lines.slice(1, -1);
    if (lines.length > 1 && MOSS_FRAME_LINE.test(lines[0]!)) lines.shift();
  }
  const frame = (lines.length > 0 && FRAME.test(lines[0]!) ? lines.shift()! : "") + wrapper;
  if (lines.length !== 1) return `a real-agents preview takes a prompt of one line (this has ${lines.length})`;
  const total = frame.length + lines[0]!.length;
  if (total > BUDGET.promptChars) return `a real-agents preview takes a prompt of at most ${BUDGET.promptChars} characters, the "Message from ..." line included (this has ${total})`;
  return undefined;
}

// ── the budget's counters: files in the run's own `budget` folder, each claim one exclusive create or one append ──────────
/** Claims the next session of `agent`: its number (1-based), or undefined when `max` are already spent. */
export function claimSession(dir: string, agent: string, max: number = BUDGET.sessionsPerAgent): number | undefined {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let n = 1; n <= max; n++) {
    try { closeSync(openSync(join(dir, `${agent}.session.${n}`), "wx", 0o600)); return n; } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  }
  return undefined;
}

/** One non-probe launch: a byte appended; returns the count so far, or undefined (and counts a refusal) when `max` launches are already spent. */
export function noteLaunch(dir: string, agent: string, max: number = BUDGET.launchesPerAgent): number | undefined {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${agent}.launches`);
  let n = 0;
  try { n = statSync(file).size; } catch { /* none yet */ }
  if (n >= max) return undefined;
  appendFileSync(file, "x", { mode: 0o600 });
  return n + 1;
}

/** A card of a real agent's session answered through `ctl approve`: counted apart from turns (an answer spends no turn). */
export function noteApproval(dir: string, backend: string): string | undefined {
  const a = REAL_AGENTS.find((x) => x.backend === backend);
  if (a === undefined) return undefined;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, `${a.command}.approved`), "x", { mode: 0o600 });
  return a.command;
}

/** One turn started: a byte appended (an append of one byte is atomic). */
export function noteTurn(dir: string, agent: string): void { appendFileSync(join(dir, `${agent}.turns`), "x", { mode: 0o600 }); }
/** One refusal (a prompt, a session or a turn): a line appended. */
export function noteRefusal(dir: string, agent: string, why: string): void { appendFileSync(join(dir, `${agent}.refused`), `${new Date().toISOString()} ${why}\n`, { mode: 0o600 }); }

export interface Spent { agent: string; approvals: number; launches: number; sessions: number; turns: number; refusals: number }

export function readSpent(dir: string): Spent[] {
  return REAL_AGENTS.map((a) => {
    const count = (f: string): number => { try { return statSync(join(dir, f)).size; } catch { return 0; } };
    let sessions = 0;
    for (let n = 1; n <= BUDGET.sessionsPerAgent; n++) if (existsSync(join(dir, `${a.command}.session.${n}`))) sessions++;
    let refusals = 0;
    try { refusals = readFileSync(join(dir, `${a.command}.refused`), "utf8").split("\n").filter((l) => l !== "").length; } catch { /* none */ }
    return { agent: a.backend, approvals: count(`${a.command}.approved`), launches: count(`${a.command}.launches`), sessions, turns: count(`${a.command}.turns`), refusals };
  });
}

export const renderSpent = (s: readonly Spent[]): string =>
  `real-agent spend: ${s.map((x) => `${x.agent} ${x.launches} launch(es) ${x.approvals} approval(s) ${x.sessions} session(s) ${x.turns} turn(s)${x.refusals > 0 ? ` (${x.refusals} refused)` : ""}`).join("; ")} (limits: ${BUDGET.launchesPerAgent} launches and ${BUDGET.sessionsPerAgent} sessions per agent, ${BUDGET.turnsPerSession} turns per session)`;


// ── proof that the engine writes nothing under the person's home ─────────────────────────────────────────────────────────
/** Names and modification times under `dir` (never contents), at most `limit` entries; empty for a folder that does not exist. A before and after listing of these shows what changed. */
export function snapshot(dir: string, limit = 200_000): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (d: string): void => {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      if (out.size >= limit) return;
      const p = join(d, n);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      out.set(p, Math.round(st.mtimeMs));
      if (st.isDirectory()) walk(p);
    }
  };
  try { out.set(dir, Math.round(lstatSync(dir).mtimeMs)); } catch { return out; }
  walk(dir);
  return out;
}

/** What differs between two listings: names added, removed, and changed in time. */
export function diffSnapshots(before: Map<string, number>, after: Map<string, number>): { added: string[]; removed: string[]; changed: string[] } {
  const added = [...after.keys()].filter((k) => !before.has(k));
  const removed = [...before.keys()].filter((k) => !after.has(k));
  const changed = [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k));
  return { added, removed, changed };
}
