// The canvas's gallery stories: the real start page (`CanvasStart`) on the SDK's test layer, its core a `fakeCore` the
// spine's `playSessionScene` plays SAMPLE_SESSION_SCENE into (or thirty sessions, or none). A story starts the scene at a
// moment (`at`: every step up to it at once) and plays the rest on real timers, so a picture taken a little later catches
// what moves. `initial` opens a block or the + panel for a picture.
import { useMemo, useState, type ReactNode } from "react";
import { SAMPLE_SESSION_SCENE, type SessionSceneStep } from "@waifucave/moss-plugin-sdk/ui/testing";
import { fakeCore, playSessionScene, runtimeWith, TestLayer } from "@waifucave/moss-plugin-sdk/ui/testing";
import type { SessionView } from "@waifucave/moss-plugin-sdk";
import { CanvasCorner, CanvasStart, type CanvasStartProps } from "../client/entry";
import { BACKENDS, FOLDERS, LAST_LINES, manySessions, OPTIONS, RECENT } from "./fixtures";

export interface Story {
  id: string;
  title: string;
  notes?: string;
  render: () => ReactNode;
}

/** Marks for the agents, when the build was given them (`--marks <dir>`: the prepared vendor files); else the SDK's
 *  fallback letter on each agent's colour. */
declare const __CANVAS_MARKS__: Record<string, { mediaType: "image/png" | "image/svg+xml"; data: string }> | undefined;
const MARKS: Record<string, { mediaType: "image/png" | "image/svg+xml"; data: string }> = typeof __CANVAS_MARKS__ === "object" && __CANVAS_MARKS__ !== null ? __CANVAS_MARKS__ : {};
/** MOSS's own agent's mark is MOSS Code's Shards mark, on light and on dark (`icon`, `iconDark`, as `agent.backends` serves it). */
const backends = () => BACKENDS.map((b) => {
  if (b.id === "moss-code") return { ...b, ...(MARKS["moss-code-light"] !== undefined ? { icon: { ...MARKS["moss-code-light"], at: 0 } } : {}), ...(MARKS["moss-code-dark"] !== undefined ? { iconDark: { ...MARKS["moss-code-dark"], at: 0 } } : {}) };
  return MARKS[b.id] !== undefined ? { ...b, icon: { ...MARKS[b.id]!, at: 0 } } : b;
});

function World({ scene, at = 0, live = true, initial, params, onRoute, botState = "idle" }: { scene: readonly SessionSceneStep[]; at?: number; live?: boolean; initial?: CanvasStartProps["initial"]; params?: { session?: string }; onRoute?: (r: string) => void; botState?: string | Record<string, string> }) {
  const runtime = useMemo(() => {
    const handlers: Record<string, (p: any) => unknown> = {
      "agent.backends": () => ({ backends: backends() }),
      "computer.list": () => ({ computers: [{ name: "Studio", link: "self" }] }),
      "agent.recent": () => ({ ...RECENT, roots: [] }),
      "agent.options": (p: { backend: string }) => OPTIONS[p.backend] ?? { backend: p.backend, known: false, source: "unknown", models: [] },
      "ui.pick": (p: { recent?: boolean }) => (p.recent ? { recent: FOLDERS } : { picked: { token: "pick-9", name: "website" } }),
      "agent.start": () => ({ session: "s_new" }),
      "app.openIn": () => ({ opened: true, started: false }),
    };
    const core = fakeCore(handlers);
    playSessionScene(core, scene as never, handlers, (ms, fn) => {
      if (ms <= at) {
        fn();
        return () => undefined;
      }
      if (!live) return () => undefined;
      const t = setTimeout(fn, ms - at);
      return () => clearTimeout(t);
    });
    const api = {
      settings: { get: async () => undefined, set: async () => undefined },
      sessions: { history: async (s: string) => ({ events: LAST_LINES[s] ?? [], hasMore: false }) },
      bots: { list: async () => BOTS.map((b) => ({ id: b.id, name: b.name, face: b.face })) },
      // The activity feed: each bot's live state, which its face shows.
      activity: { list: async () => BOTS.map((b) => ({ subject: { kind: "bots", id: b.id }, state: typeof botState === "string" ? botState : botState[b.id] ?? "idle", since: 0 })), watch: () => () => undefined },
    };
    return runtimeWith({ core: () => core, api: () => api, userSend: () => async () => undefined });
  }, [scene, at, live, JSON.stringify(botState)]);
  return (
    <TestLayer runtime={runtime} pluginId="moss/canvas" entry="start" spot="main" spotKey="start">
      <CanvasStart props={{ route: "start", params: params ?? {}, navigate: (r) => onRoute?.(`${r.route} ${JSON.stringify(r.params)}`), ...(initial !== undefined ? { initial } : {}) }} />
    </TestLayer>
  );
}

/** The scene, live, with a replay. */
function Live() {
  const [run, setRun] = useState(0);
  const [route, setRoute] = useState<string | undefined>();
  return (
    <div className="g-live">
      <div className="g-live__bar">
        <button type="button" onClick={() => { setRun((n) => n + 1); setRoute(undefined); }}>Replay the scene</button>
        <span>{route !== undefined ? `The window would go to: ${route}` : "About 14 seconds: sessions start, a subagent, a child, messages, waiting, a bot's agent, endings."}</span>
      </div>
      <div className="g-live__canvas"><World key={run} scene={SAMPLE_SESSION_SCENE} onRoute={setRoute} /></div>
    </div>
  );
}

const T0 = 1_781_270_000_000;

/** Bots with their records' faces (`bot.records`' pins, as lane CA's `BotFace` reads them): MOSS as her record has her (the
 *  kit's tile in coral with round eyes), and two with other traits. The gallery's build hands these to MOSS's own faces kit. */
const BOTS = [
  { id: "moss", name: "MOSS", face: { shape: "tile", color: "coral", eyes: "round" } },
  { id: "pip", name: "Pip", face: { shape: "drop", color: "sky", eyes: "tall", temper: "restless" } },
  { id: "juno", name: "Juno", face: { shape: "gem", color: "mint", eyes: "dot", temper: "slow" } },
];

/** Three bots, each with a session it started. */
function botsScene(): SessionSceneStep[] {
  const steps: SessionSceneStep[] = [];
  const titles: Record<string, string> = { moss: "Tidy the release notes", pip: "Sort the photo folder", juno: "Draft the weekly summary" };
  BOTS.forEach((b, i) => {
    steps.push({ at: 0, event: { type: "session_changed", ts: T0 + i, session: { id: `s_${b.id}`, kind: "bot", bot: b.id, computer: "Studio", status: "idle", startedAt: T0 + i, updatedAt: T0 + i, title: b.name } } });
    steps.push({ at: 0, event: { type: "session_changed", ts: T0 + i, session: { id: `s_${b.id}_task`, kind: "agent", bot: b.id, parent: `s_${b.id}`, computer: "Studio", status: "prompting", startedAt: T0 + 10 + i, updatedAt: T0 + 10 + i, title: titles[b.id]!, backend: "moss-code", model: "anthropic/claude-sonnet-5", startedBy: { kind: "bot", bot: b.id, session: `s_${b.id}` } } } });
  });
  return steps;
}

/** One message's trip. Arrival cases: the receiver starts running because of it (`run`); stays idle, a final report to an
 *  idle parent (`idle`); is waiting on background jobs (`wait`). Sending cases: from a running sender (`send-run`) and from
 *  an idle one (`send-idle`), both to an idle receiver. The message leaves at `delay` ms. */
type TripKind = "run" | "idle" | "wait" | "send-run" | "send-idle";
function tripScene(kind: TripKind, delay: number): SessionSceneStep[] {
  const v = (id: string, at: number, extra: Partial<SessionView>): SessionSceneStep =>
    ({ at, event: { type: "session_changed", ts: T0 + at, session: { id, kind: "coding", computer: "Studio", status: "idle", startedAt: T0, updatedAt: T0 + at, startedBy: { kind: "user" }, ...extra } as SessionView } });
  const child = (at: number, status: SessionView["status"]) => v("t_child", at, { id: "t_child", kind: "agent", title: "Write the auth tests", backend: "claude-code", model: "anthropic/claude-sonnet-5", parent: "t_recv", startedBy: { kind: "session", session: "t_recv" }, status, startedAt: T0 + 5 });
  const sender = kind === "idle" ? child(0, "prompting")
    : v("t_send", 0, { title: "Fix the login flow", backend: "claude-code", model: "anthropic/claude-opus-5-5", effort: "high", status: kind === "send-idle" ? "idle" : "prompting" });
  const receiver = v("t_recv", 0, { title: kind === "idle" ? "Plan the auth work" : "Docs pass", backend: "codex", model: "openai/gpt-6", effort: "medium", ...(kind === "wait" ? { waiting: { tasks: 1, children: 0 } } : {}) });
  const from = kind === "idle" ? { end: "session" as const, session: "t_child", kind: "agent" as const } : { end: "session" as const, session: "t_send", kind: "coding" as const };
  const steps: SessionSceneStep[] = [receiver, sender, { at: delay, event: { type: "session_link", ts: T0 + delay, from, to: { session: "t_recv", kind: "coding" }, link: kind === "idle" ? "report" : "message" } }];
  if (kind === "run") steps.push(v("t_recv", delay, { title: "Docs pass", backend: "codex", model: "openai/gpt-6", effort: "medium", status: "prompting" }));
  // The child reports, then stops: it was running as it sent.
  if (kind === "idle") steps.push(child(delay + 50, "stopped"));
  return steps;
}

const CASES: readonly { kind: TripKind; title: string; notes: string }[] = [
  { kind: "run", title: "Arriving: the receiver starts running", notes: "Its ring swells in the sender's colour, settling into its own, and runs on from its point." },
  { kind: "idle", title: "Arriving: the receiver stays idle", notes: "Its outline gives one soft glow pulse that fades." },
  { kind: "wait", title: "Arriving: the receiver is waiting", notes: "It glows once over its dashes." },
  { kind: "send-run", title: "Sending: the sender is running", notes: "Its ring swells as the wave leaves its point." },
  { kind: "send-idle", title: "Sending: the sender is idle", notes: "Its outline swells once as the wave leaves." },
];

/** The five cases side by side, with Replay, slow motion and the theme. */
function Trips() {
  const [run, setRun] = useState(0);
  const [slow, setSlow] = useState(false);
  const [dark, setDark] = useState(document.documentElement.dataset.theme === "dark");
  return (
    <div className="g-live" style={(slow ? { "--cv-slow": 4 } : {}) as never}>
      <div className="g-live__bar">
        <button type="button" onClick={() => setRun((n) => n + 1)}>Replay</button>
        <label><input type="checkbox" checked={slow} onChange={(e) => { setSlow(e.target.checked); setRun((n) => n + 1); }} /> Slow motion (4×)</label>
        <label><input type="checkbox" checked={dark} onChange={(e) => { setDark(e.target.checked); document.documentElement.dataset.theme = e.target.checked ? "dark" : "light"; }} /> Dark</label>
      </div>
      <div className="g-cases">
        {CASES.map((c) => (
          <div className="g-case" key={`${c.kind}-${run}`}>
            <div className="g-case__head"><b>{c.title}</b> <span>{c.notes}</span></div>
            <div className="g-case__canvas"><World scene={tripScene(c.kind, 900)} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** The sample scene with every kind of agent colour on it: Gemini (two colours) and two black-and-white brands, OpenCode
 *  and Cursor, besides the scene's Claude Code, Codex and MOSS's own agent; a message between them at 8.8 s. */
function paletteScene(): SessionSceneStep[] {
  const v = (id: string, at: number, title: string, backend: string, model: string, status: SessionView["status"], extra: Partial<SessionView> = {}): SessionSceneStep =>
    ({ at, event: { type: "session_changed", ts: T0 + at, session: { id, kind: "coding", computer: "Studio", status, startedAt: T0 + at, updatedAt: T0 + at, title, backend, model, startedBy: { kind: "user" }, ...extra } } });
  return [
    ...SAMPLE_SESSION_SCENE,
    v("s_g", 200, "Design the settings page", "gemini", "google/gemini-3-pro", "prompting"),
    v("s_o", 300, "Port the parser to Rust", "opencode", "muse/spark-1-3", "idle", { waiting: { tasks: 2, children: 0 } }),
    v("s_k", 350, "Profile the cold start", "cursor", "cursor/composer-2", "prompting"),
    { at: 8_800, event: { type: "session_link", ts: T0 + 8_800, from: { end: "session", session: "s_g", kind: "coding" }, to: { session: "s_o", kind: "coding" }, link: "message" } },
  ];
}
const PALETTE = paletteScene();
/** Thirty sessions, and a few messages crossing between them once it opens. */
function manyScene(): SessionSceneStep[] {
  const sessions = Object.values(manySessions(30));
  const steps: SessionSceneStep[] = sessions.map((s: SessionView) => ({ at: 0, event: { type: "session_changed", ts: T0, session: s } }));
  const link = (at: number, from: string, to: string): SessionSceneStep => ({ at, event: { type: "session_link", ts: T0 + at, from: { end: "session", session: from, kind: "coding" }, to: { session: to, kind: "coding" }, link: "message" } });
  steps.push(link(200, "m00", "m06"), link(260, "m12", "m03"), link(320, "m18", "m24"));
  return steps;
}

export const STORIES: Story[] = [
  { id: "scene", title: "The sample scene, live", notes: "SAMPLE_SESSION_SCENE played on real timers. Press Replay to watch it again.", render: () => <Live /> },
  { id: "trips", title: "A message crossing", notes: "The three receivers and the two senders side by side, over each block's own running light. Replay, slow it down, try it dark.", render: () => <Trips /> },
  ...CASES.map((c) => ({ id: `trip-${c.kind}`, title: c.title, notes: `${c.notes} (pinned at a moment for the pictures with #t=<seconds>)`, render: () => <World scene={tripScene(c.kind, 60)} /> })),
  { id: "bots", title: "Bots, idle", notes: "Three bots with their records' faces, drawn by MOSS's own faces kit (the gallery's build feeds it in where the plugin will take the SDK's BotFace).", render: () => <World scene={botsScene()} live={false} botState="idle" /> },
  { id: "bots-busy", title: "Bots at work", notes: "The same bots, working and thinking: their expressions from the activity feed.", render: () => <World scene={botsScene()} live={false} botState={{ moss: "working", pip: "thinking", juno: "asking" }} /> },
  { id: "wave", title: "Every agent's colour", notes: "Each agent in its icon's own colour: Claude Code, Codex (blue-violet), MOSS's own agent (gold), Gemini (two colours), OpenCode and Cursor (the text colour). At 9 s Codex answers Claude Code: the dotted line lights from Codex's point to Claude Code's.", render: () => <World scene={PALETTE} at={8_600} /> },
  { id: "still", title: "Everything still", notes: "The scene's end, every session idle or ended: nothing moves.", render: () => <World scene={SAMPLE_SESSION_SCENE} at={20_000} live={false} initial={{ showEnded: true }} /> },
  { id: "open", title: "A block open", notes: "It grows a little: the session's last line, a composer that sends as you, Open tab.", render: () => <World scene={PALETTE} at={9_500} live={false} initial={{ open: "s_a" }} /> },
  { id: "bot", title: "A bot's block open", notes: "Open in MOSS: the bot's conversation is MOSS's. Its face as MOSS draws it, idle.", render: () => <World scene={SAMPLE_SESSION_SCENE} at={8_000} live={false} initial={{ open: "bot:moss" }} /> },
  { id: "bot-thinking", title: "A bot thinking", notes: "The same face, its expression from the activity feed's state (thinking); its words beside it.", render: () => <World scene={SAMPLE_SESSION_SCENE} at={8_000} live={false} botState="thinking" /> },
  { id: "plus", title: "+ New session", notes: "Every step preselected: the last used agent, its last model and effort, the last folder. Create works at once.", render: () => <World scene={PALETTE} at={9_500} live={false} initial={{ panel: true }} /> },
  { id: "plus-model", title: "+: model and effort", render: () => <World scene={SAMPLE_SESSION_SCENE} at={9_500} live={false} initial={{ panel: true, step: "model" }} /> },
  { id: "plus-folder", title: "+: the folder", render: () => <World scene={SAMPLE_SESSION_SCENE} at={9_500} live={false} initial={{ panel: true, step: "folder" }} /> },
  { id: "many", title: "Thirty sessions", notes: "Bands of sessions, five groups side by side; ended ones folded into the count (press it to show them).", render: () => <World scene={manyScene()} at={0} /> },
  { id: "empty", title: "No sessions", render: () => <World scene={[]} /> },
  {
    id: "no-icon", title: "An agent with no icon", notes: "The one page with the fallback: an agent whose record carries no icon gets the SDK's letter mark on its colour, and its name beside it, since a letter alone doesn't name it.",
    render: () => <World scene={[{ at: 0, event: { type: "session_changed", ts: T0, session: { id: "s_k", kind: "coding", computer: "Studio", status: "prompting", startedAt: T0, updatedAt: T0, startedBy: { kind: "user" }, title: "Tidy the build scripts", backend: "kilo", model: "anthropic/claude-sonnet-5", effort: "medium" } as SessionView } }]} live={false} />,
  },
  { id: "closeup", title: "A running block, close", notes: "Claude Code's block while it runs, centred.", render: () => <World scene={PALETTE} at={9_500} live={false} params={{ session: "s_a" }} /> },
  { id: "closeup-gemini", title: "A two-colour agent running, close", render: () => <World scene={PALETTE} at={9_500} live={false} params={{ session: "s_g" }} /> },
  { id: "focus", title: "From a tab's corner", notes: "The canvas opened for one session: its block centred.", render: () => <World scene={SAMPLE_SESSION_SCENE} at={9_500} live={false} params={{ session: "s_d" }} /> },
  {
    id: "corner", title: "The tab's corner switch", notes: "In a session tab's top corner, beside the shell's own controls.",
    render: () => (
      <div className="g-tab">
        <span className="g-tab__title">Fix the login flow</span>
        <TestLayer runtime={runtimeWith({ api: () => ({}) })} pluginId="moss/canvas" entry="canvas-corner" spot="session.corner">
          <CanvasCorner props={{ session: "s_a", kind: "coding", navigate: () => undefined }} />
        </TestLayer>
      </div>
    ),
  },
];
