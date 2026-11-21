// The gallery's and the tests' pretend world: the agents `agent.backends` would list (with the look each agent's plugin
// ships: a colour, no icon here, so the SDK's fallback mark shows), their options, the person's last start, the recent
// folders and a session's last lines. The sessions themselves are the protocol's SAMPLE_SESSION_SCENE (or `manySessions`).
import type { SessionView } from "@waifucave/moss-plugin-sdk";
import type { AgentOptions, BackendRow, FolderToken, RecentStart } from "../client/preselect";

const here = [{ computer: "Studio", installed: true }];
const elsewhere = [{ computer: "Studio", installed: false }];

export const BACKENDS: BackendRow[] = [
  // Each agent's colour(s) are its icon's real ones (the owner, 2026-11-21); MOSS's own agent is the Shards mark's gold.
  { id: "moss-code", name: "MOSS's coding agent", color: "#E5A72E", computers: here },
  { id: "claude-code", name: "Claude Code", color: "#D97757", computers: here },
  { id: "codex", name: "Codex", color: "#484FF6", color2: "#7893F9", computers: here },
  { id: "gemini", name: "Gemini CLI", color: "#3488FB", color2: "#F24D50", computers: here },
  // Black-and-white brands: no colour; their mark and motion wear the theme's text colour.
  { id: "opencode", name: "OpenCode", computers: here },
  { id: "cursor", name: "Cursor", computers: here },
  { id: "qwen", name: "Qwen", color: "#082DFF", computers: elsewhere },
  { id: "moss-subagent", name: "MOSS's subagents", color: "#F0694C", userStartable: false, computers: here },
];

export const OPTIONS: Record<string, AgentOptions> = {
  "moss-code": {
    backend: "moss-code", known: true, source: "catalog",
    models: [
      { id: "anthropic/claude-opus-5-5", name: "Opus 5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      { id: "anthropic/claude-sonnet-5", name: "Sonnet 5", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    ],
    default: { model: "anthropic/claude-opus-5-5", effort: "medium" },
  },
  "claude-code": {
    backend: "claude-code", known: true, source: "quirks",
    models: [
      { id: "anthropic/claude-opus-5-5", name: "Opus 5.5", efforts: ["low", "medium", "high", "max"], defaultEffort: "high" },
      { id: "anthropic/claude-sonnet-5", name: "Sonnet 5", efforts: ["low", "medium", "high"] },
    ],
    default: { model: "anthropic/claude-opus-5-5" },
  },
  codex: {
    backend: "codex", known: true, source: "probe",
    models: [{ id: "openai/gpt-6", name: "GPT-6", efforts: ["low", "medium", "high"], defaultEffort: "medium" }],
    default: { model: "openai/gpt-6", effort: "medium" },
  },
  gemini: { backend: "gemini", known: false, source: "unknown", models: [] },
  opencode: { backend: "opencode", known: false, source: "unknown", models: [] },
  cursor: { backend: "cursor", known: false, source: "unknown", models: [] },
};

export const RECENT: RecentStart = { backend: "claude-code", model: "anthropic/claude-opus-5-5", effort: "high" };

export const FOLDERS: FolderToken[] = [
  { token: "pick-1", name: "app" },
  { token: "pick-2", name: "docs" },
  { token: "pick-3", name: "notes" },
];

/** A session's last lines, as `sessions.history` gives them. */
export const LAST_LINES: Record<string, Record<string, unknown>[]> = {
  s_a: [
    { type: "user_message", text: "Fix the login flow" },
    { type: "tool_call", name: "Edit", displayTitle: "Edit src/auth/login.ts" },
    { type: "assistant_message", text: "The session cookie was set before the redirect.\nMoved it after; the login test passes now." },
  ],
  s_b: [{ type: "assistant_message", text: "Rewrote the getting-started page; waiting on the docs build." }],
  s_c: [{ type: "assistant_message", text: "Report: 14 tests added, all green." }],
  s_d: [{ type: "tool_call", name: "Write", displayTitle: "Write notes/release-0.4.md" }],
};

const T0 = 1_781_270_000_000;
const AGENTS = ["claude-code", "codex", "moss-code", "gemini", "opencode", "cursor"] as const;
const MODELS: Record<string, string> = { "claude-code": "anthropic/claude-opus-5-5", codex: "openai/gpt-6", "moss-code": "anthropic/claude-sonnet-5", gemini: "google/gemini-3-pro", opencode: "muse/spark-1-3", cursor: "cursor/composer-2" };
const TITLES = [
  "Fix the flaky upgrade rows", "API refactor", "Port the parser to Rust", "Review the parser port", "Design the settings page", "Triage the issue backlog",
  "Weekly usage report", "Tidy the downloads folder", "Bump the Electron pin", "Write the release notes", "Profile the cold start", "Split the sidebar into parts",
  "Move the faces into the SDK", "Translate the setup guide", "Clean up the old migrations and every file that still names the previous app after the rename",
];

/** `n` sessions: some running, some waiting, some ended (folded), a few children and a bot's. Deterministic. */
export function manySessions(n: number): Record<string, SessionView> {
  const out: Record<string, SessionView> = {};
  for (let i = 0; i < n; i++) {
    const id = `m${String(i).padStart(2, "0")}`;
    const backend = AGENTS[i % AGENTS.length]!;
    const status: SessionView["status"] = i % 7 === 3 ? "stopped" : i % 3 === 0 ? "prompting" : "idle";
    const child = i > 2 && i % 6 === 1;
    out[id] = {
      id, kind: child ? "agent" : "coding", computer: "Studio", status, startedAt: T0 + i * 1_000, updatedAt: T0 + i * 1_000 + 500,
      title: `${TITLES[i % TITLES.length]}${i >= TITLES.length ? ` (${Math.floor(i / TITLES.length) + 1})` : ""}`, backend, model: MODELS[backend]!, effort: i % 2 === 0 ? "high" : "medium",
      startedBy: child ? { kind: "session", session: `m${String(i - 1).padStart(2, "0")}` } : { kind: "user" },
      ...(i % 5 === 2 && status === "idle" ? { waiting: { tasks: 1 + (i % 2), children: 0 } } : {}),
    };
  }
  return out;
}
