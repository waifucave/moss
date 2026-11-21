// The spine's sample scene (protocol `session-scene.ts`: SAMPLE_SESSION_SCENE, foldSessionEvents, sceneAt), copied here
// step for step: a bundled plugin imports only React, the SDK and its own folder (F2b, apps/desktop/test/
// bundled-imports.test.ts), and the SDK does not export the scene yet. Asked of lane CA (the SDK's owner) in the lane's
// report: export these three from `@waifucave/moss-plugin-sdk/ui/testing`, beside `playSessionScene`; this file then goes.
import type { SessionView } from "@waifucave/moss-plugin-sdk";
import type { LinkEvent } from "../client/links";

export type SessionSceneStep =
  | { at: number; event: { type: "session_changed"; ts: number; session: SessionView } }
  | { at: number; event: LinkEvent & { type: "session_link" } };

export interface SessionGraphState {
  sessions: Record<string, SessionView>;
  links: LinkEvent[];
}

/** The protocol's fold: a newer view (by `updatedAt`, an equal one too) replaces an older; links kept in order. */
export function foldSessionEvents(events: readonly SessionSceneStep["event"][], from: SessionGraphState = { sessions: {}, links: [] }, keepLinks = 256): SessionGraphState {
  const sessions = { ...from.sessions };
  const links = [...from.links];
  for (const e of events) {
    if (e.type === "session_changed") {
      const old = sessions[e.session.id];
      if (old === undefined || e.session.updatedAt >= old.updatedAt) sessions[e.session.id] = e.session;
    } else links.push(e);
  }
  return { sessions, links: links.slice(Math.max(0, links.length - keepLinks)) };
}

export function sceneAt(scene: readonly SessionSceneStep[], t: number): SessionGraphState {
  return foldSessionEvents(scene.filter((s) => s.at <= t).map((s) => s.event));
}

const T0 = 1_781_270_000_000;
const view = (id: string, at: number, extra: Partial<SessionView>): SessionView => ({
  id, kind: "coding", computer: "Studio", status: "ready", startedAt: T0, updatedAt: T0 + at, ...extra,
});
const changed = (at: number, session: SessionView): SessionSceneStep => ({ at, event: { type: "session_changed", ts: T0 + at, session } });
const link = (at: number, from: LinkEvent["from"], to: LinkEvent["to"], kind: LinkEvent["link"]): SessionSceneStep => ({
  at, event: { type: "session_link", ts: T0 + at, from, to, link: kind },
});
const code = (session: string) => ({ end: "session" as const, session, kind: "coding" as const });

const A = { title: "Fix the login flow", backend: "claude-code", model: "anthropic/claude-opus-5-5", effort: "high", root: "home/Studio/app", startedBy: { kind: "user" as const } };
const B = { title: "Docs pass", backend: "codex", model: "openai/gpt-6", effort: "medium", root: "home/Studio/docs", startedBy: { kind: "user" as const } };
const C = { kind: "agent" as const, title: "Write the auth tests", backend: "claude-code", model: "anthropic/claude-sonnet-5", parent: "s_a", startedBy: { kind: "session" as const, session: "s_a" }, root: "home/Studio/app" };
const BOT = { kind: "bot" as const, bot: "moss", title: "MOSS" };
const D = { kind: "agent" as const, bot: "moss", parent: "s_moss", title: "Tidy the release notes", backend: "moss-code", model: "anthropic/claude-sonnet-5", startedBy: { kind: "bot" as const, bot: "moss", session: "s_moss" }, root: "home/Studio/notes" };
const sub = (state: "running" | "done", at: number) => ({ id: "call_explore_1", name: "Explore the auth module", model: "anthropic/claude-haiku-5", state, startedAt: T0 + 2_500, ...(state === "done" ? { endedAt: T0 + at } : {}) });

/** SAMPLE_SESSION_SCENE: about 14 seconds. */
export const SAMPLE_SESSION_SCENE: readonly SessionSceneStep[] = [
  changed(0, view("s_a", 0, { ...A, status: "starting" })),
  changed(400, view("s_b", 400, { ...B, status: "idle" })),
  changed(600, view("s_moss", 600, { ...BOT, status: "idle" })),
  link(1_000, { end: "user" }, { session: "s_a", kind: "coding" }, "message"),
  changed(1_000, view("s_a", 1_000, { ...A, status: "prompting" })),
  changed(2_500, view("s_a", 2_500, { ...A, status: "prompting", subagents: [sub("running", 0)] })),
  changed(4_000, view("s_c", 4_000, { ...C, status: "starting" })),
  link(4_000, code("s_a"), { session: "s_c", kind: "agent" }, "spawn"),
  changed(4_200, view("s_c", 4_200, { ...C, status: "prompting" })),
  changed(5_000, view("s_a", 5_000, { ...A, status: "prompting", subagents: [sub("done", 5_000)] })),
  link(5_500, code("s_a"), { session: "s_b", kind: "coding" }, "message"),
  changed(5_600, view("s_b", 5_600, { ...B, status: "prompting" })),
  changed(6_000, view("s_a", 6_000, { ...A, status: "idle", waiting: { tasks: 0, children: 1 }, subagents: [sub("done", 5_000)] })),
  link(6_500, { end: "user" }, { session: "s_moss", kind: "bot", bot: "moss" }, "message"),
  changed(6_500, view("s_moss", 6_500, { ...BOT, status: "prompting" })),
  changed(7_500, view("s_d", 7_500, { ...D, status: "prompting" })),
  link(7_500, { end: "session", session: "s_moss", kind: "bot", bot: "moss" }, { session: "s_d", kind: "agent", bot: "moss" }, "spawn"),
  changed(7_600, view("s_moss", 7_600, { ...BOT, status: "idle", waiting: { tasks: 0, children: 1 } })),
  changed(8_000, view("s_b", 8_000, { ...B, status: "idle", waiting: { tasks: 1, children: 0 } })),
  link(9_000, code("s_b"), { session: "s_a", kind: "coding" }, "message"),
  changed(9_000, view("s_a", 9_000, { ...A, status: "prompting", waiting: { tasks: 0, children: 1 }, subagents: [sub("done", 5_000)] })),
  changed(10_000, view("s_a", 10_000, { ...A, status: "idle", waiting: { tasks: 0, children: 1 }, subagents: [sub("done", 5_000)] })),
  link(11_000, { end: "session", session: "s_c", kind: "agent" }, { session: "s_a", kind: "coding" }, "report"),
  changed(11_000, view("s_c", 11_000, { ...C, status: "stopped" })),
  changed(11_000, view("s_a", 11_000, { ...A, status: "prompting", subagents: [sub("done", 5_000)] })),
  changed(12_000, view("s_b", 12_000, { ...B, status: "idle" })),
  link(12_500, { end: "session", session: "s_d", kind: "agent", bot: "moss" }, { session: "s_moss", kind: "bot", bot: "moss" }, "report"),
  changed(12_500, view("s_d", 12_500, { ...D, status: "stopped" })),
  changed(12_500, view("s_moss", 12_500, { ...BOT, status: "prompting" })),
  changed(13_500, view("s_moss", 13_500, { ...BOT, status: "idle" })),
  changed(14_000, view("s_a", 14_000, { ...A, status: "idle", subagents: [sub("done", 5_000)] })),
];
