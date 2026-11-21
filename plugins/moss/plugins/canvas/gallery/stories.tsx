// The canvas's gallery stories: the real start page (`CanvasStart`) on the SDK's test layer, its core a `fakeCore` the
// spine's `playSessionScene` plays SAMPLE_SESSION_SCENE into (or thirty sessions, or none). A story starts the scene at a
// moment (`at`: every step up to it at once) and plays the rest on real timers, so a picture taken a little later catches
// what moves. `initial` opens a block or the + panel for a picture.
import { useMemo, useState, type ReactNode } from "react";
import { SAMPLE_SESSION_SCENE, type SessionSceneStep } from "@waifucave/moss-protocol";
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
const MARKS: Record<string, { mediaType: "image/png" | "image/svg+xml"; data: string }> = typeof __CANVAS_MARKS__ === "object" ? __CANVAS_MARKS__ : {};
const backends = () => BACKENDS.map((b) => (MARKS[b.id] !== undefined ? { ...b, icon: { ...MARKS[b.id]!, at: 0 } } : b));

function World({ scene, at = 0, live = true, initial, params, onRoute }: { scene: readonly SessionSceneStep[]; at?: number; live?: boolean; initial?: CanvasStartProps["initial"]; params?: { session?: string }; onRoute?: (r: string) => void }) {
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
    playSessionScene(core, scene, handlers, (ms, fn) => {
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
      bots: { list: async () => [{ id: "moss", name: "MOSS" }] },
    };
    return runtimeWith({ core: () => core, api: () => api, userSend: () => async () => undefined });
  }, [scene, at, live]);
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
/** Thirty sessions, and a few messages crossing between them once it opens. */
function manyScene(): SessionSceneStep[] {
  const sessions = Object.values(manySessions(30));
  const steps: SessionSceneStep[] = sessions.map((s: SessionView) => ({ at: 0, event: { type: "session_changed", ts: T0, session: s as never } }));
  const link = (at: number, from: string, to: string): SessionSceneStep => ({ at, event: { type: "session_link", ts: T0 + at, from: { end: "session", session: from, kind: "coding" }, to: { session: to, kind: "coding" }, link: "message" } });
  steps.push(link(200, "m00", "m06"), link(260, "m12", "m03"), link(320, "m18", "m24"));
  return steps;
}

export const STORIES: Story[] = [
  { id: "scene", title: "The sample scene, live", notes: "SAMPLE_SESSION_SCENE played on real timers. Press Replay to watch it again.", render: () => <Live /> },
  { id: "wave", title: "A message crossing", notes: "At 9 s Docs pass (Codex) answers Fix the login flow: the dotted line between them lights from Codex's point to Claude Code's.", render: () => <World scene={SAMPLE_SESSION_SCENE} at={8_600} /> },
  { id: "still", title: "Everything still", notes: "The scene's end, every session idle or ended: nothing moves.", render: () => <World scene={SAMPLE_SESSION_SCENE} at={20_000} live={false} initial={{ showEnded: true }} /> },
  { id: "open", title: "A block open", notes: "It grows a little: the session's last line, a composer that sends as you, Open tab.", render: () => <World scene={SAMPLE_SESSION_SCENE} at={9_500} live={false} initial={{ open: "s_a" }} /> },
  { id: "bot", title: "A bot's block open", notes: "Open in MOSS: the bot's conversation is MOSS's.", render: () => <World scene={SAMPLE_SESSION_SCENE} at={8_000} live={false} initial={{ open: "bot:moss" }} /> },
  { id: "plus", title: "+ New session", notes: "Every step preselected: the last used agent, its last model and effort, the last folder. Create works at once.", render: () => <World scene={SAMPLE_SESSION_SCENE} at={9_500} live={false} initial={{ panel: true }} /> },
  { id: "plus-model", title: "+: model and effort", render: () => <World scene={SAMPLE_SESSION_SCENE} at={9_500} live={false} initial={{ panel: true, step: "model" }} /> },
  { id: "plus-folder", title: "+: the folder", render: () => <World scene={SAMPLE_SESSION_SCENE} at={9_500} live={false} initial={{ panel: true, step: "folder" }} /> },
  { id: "many", title: "Thirty sessions", notes: "Bands of sessions, five groups side by side; ended ones folded into the count (press it to show them).", render: () => <World scene={manyScene()} at={0} /> },
  { id: "empty", title: "No sessions", render: () => <World scene={[]} /> },
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
