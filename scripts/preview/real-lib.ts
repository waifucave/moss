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
  turnsPerSession: 3,
  /** A turn that has not ended after this long is cancelled, then its process ended. */
  turnMs: 180_000,
  /** The cancel gets this long before the process is ended. */
  cancelGraceMs: 10_000,
  /** A prompt's text is one line of at most this many characters. */
  promptChars: 300,
} as const;

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

// ── the prompt rule ──────────────────────────────────────────────────────────────────────────────────────────────────────
const FRAME = /^Message from (agent|the plugin) [^\n:]{1,200}:$/;

/** Why a `session/prompt`'s blocks are refused, or undefined: text blocks only, and one line of at most `promptChars` characters
 *  (the line MOSS puts above a message another session sent, "Message from agent X:", is not counted). */
export function promptProblem(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks) || blocks.length === 0) return "the prompt has no content";
  const texts: string[] = [];
  for (const b of blocks) {
    const t = (b as { type?: unknown; text?: unknown } | null)?.type;
    if (t !== "text" || typeof (b as { text?: unknown }).text !== "string") return `a real-agents preview takes text prompts only (this one has a ${typeof t === "string" ? t : "non-text"} block)`;
    texts.push((b as { text: string }).text);
  }
  const lines = texts.join("\n").split("\n").map((l) => l.trim()).filter((l) => l !== "");
  if (lines.length > 0 && FRAME.test(lines[0]!)) lines.shift();
  if (lines.length !== 1) return `a real-agents preview takes a prompt of one line (this has ${lines.length})`;
  if (lines[0]!.length > BUDGET.promptChars) return `a real-agents preview takes a prompt of at most ${BUDGET.promptChars} characters (this has ${lines[0]!.length})`;
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

/** One turn started: a byte appended (an append of one byte is atomic). */
export function noteTurn(dir: string, agent: string): void { appendFileSync(join(dir, `${agent}.turns`), "x", { mode: 0o600 }); }
/** One refusal (a prompt, a session or a turn): a line appended. */
export function noteRefusal(dir: string, agent: string, why: string): void { appendFileSync(join(dir, `${agent}.refused`), `${new Date().toISOString()} ${why}\n`, { mode: 0o600 }); }

export interface Spent { agent: string; sessions: number; turns: number; refusals: number }

export function readSpent(dir: string): Spent[] {
  return REAL_AGENTS.map((a) => {
    const count = (f: string): number => { try { return statSync(join(dir, f)).size; } catch { return 0; } };
    let sessions = 0;
    for (let n = 1; n <= BUDGET.sessionsPerAgent; n++) if (existsSync(join(dir, `${a.command}.session.${n}`))) sessions++;
    let refusals = 0;
    try { refusals = readFileSync(join(dir, `${a.command}.refused`), "utf8").split("\n").filter((l) => l !== "").length; } catch { /* none */ }
    return { agent: a.backend, sessions, turns: count(`${a.command}.turns`), refusals };
  });
}

export const renderSpent = (s: readonly Spent[]): string =>
  `real-agent spend: ${s.map((x) => `${x.agent} ${x.sessions} session(s) ${x.turns} turn(s)${x.refusals > 0 ? ` (${x.refusals} refused)` : ""}`).join("; ")} (limits: ${BUDGET.sessionsPerAgent} sessions per agent, ${BUDGET.turnsPerSession} turns per session)`;


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
