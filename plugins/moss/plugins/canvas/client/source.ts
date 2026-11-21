// Where the canvas's sessions come from: the core, through the part's own door (`useCore`), and nothing else. It listens
// first (`session_changed`, `session_link`), then lists (`session.list`), so a change made while the list is on its way is
// never lost: a view replaces an older one by `updatedAt` (the protocol's `foldSessionEvents` rule). Each link is applied
// against the model as it stands when it arrives (links.ts). The engine serves this; until it does, the spine's
// `playSessionScene` answers the same calls and events in the tests and the gallery.
import type { SessionView } from "@waifucave/moss-plugin-sdk";
import { useCore, usePluginApi } from "@waifucave/moss-plugin-sdk/ui";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { applyLink, EMPTY_LINKS, waveDone, type LinkEvent, type LinkState } from "./links";
import type { BackendLook } from "./look";
import { buildModel } from "./model";
import type { BackendRow } from "./preselect";

export interface GraphState {
  sessions: Readonly<Record<string, SessionView>>;
  links: LinkState;
  backends: ReadonlyMap<string, BackendLook>;
  /** `agent.backends` as listed, for the + panel; undefined until it answers. */
  rows: readonly BackendRow[] | undefined;
  botNames: ReadonlyMap<string, string>;
  /** This computer's name (`computer.list`'s `self`), for which agents it has. */
  here: string | undefined;
  /** False until `session.list` has answered once. */
  loaded: boolean;
}

type Action =
  | { t: "view"; view: SessionView }
  | { t: "list"; views: readonly SessionView[] }
  | { t: "link"; link: LinkEvent }
  | { t: "done"; wave: number }
  | { t: "backends"; rows: readonly BackendRow[] }
  | { t: "bots"; names: ReadonlyMap<string, string> }
  | { t: "here"; here: string | undefined };

const newer = (old: SessionView | undefined, view: SessionView) => old === undefined || view.updatedAt >= old.updatedAt;

export const EMPTY_GRAPH: GraphState = { sessions: {}, links: EMPTY_LINKS, backends: new Map(), rows: undefined, botNames: new Map(), here: undefined, loaded: false };

export function graphReducer(state: GraphState, a: Action): GraphState {
  switch (a.t) {
    case "view":
      return newer(state.sessions[a.view.id], a.view) ? { ...state, sessions: { ...state.sessions, [a.view.id]: a.view } } : state;
    case "list": {
      const sessions = { ...state.sessions };
      for (const v of a.views) if (newer(sessions[v.id], v)) sessions[v.id] = v;
      return { ...state, sessions, loaded: true };
    }
    case "link":
      return { ...state, links: applyLink(state.links, a.link, buildModel(state.sessions, state.backends, state.botNames)) };
    case "done": {
      const links = waveDone(state.links, a.wave);
      return links === state.links ? state : { ...state, links };
    }
    case "backends":
      return { ...state, rows: a.rows, backends: new Map(a.rows.map((r) => [r.id, r])) };
    case "bots":
      return { ...state, botNames: a.names };
    case "here":
      return { ...state, here: a.here };
  }
}

const isView = (v: unknown): v is SessionView => typeof v === "object" && v !== null && typeof (v as SessionView).id === "string" && typeof (v as SessionView).updatedAt === "number";
const plainName = (n: unknown): string | undefined => (typeof n === "string" ? n : typeof (n as { en?: unknown } | undefined)?.en === "string" ? (n as { en: string }).en : undefined);

export function useSessionGraph(): GraphState & { waveDone(id: number): void } {
  const core = useCore();
  // The API object is read through a ref: the listening and the reads start once per core, whatever its identity.
  const apiRef = useRef(usePluginApi());
  apiRef.current = usePluginApi();
  const [state, dispatch] = useReducer(graphReducer, EMPTY_GRAPH);
  useEffect(() => {
    if (core === undefined) return;
    let live = true;
    const offView = core.on("session_changed", (e) => { if (isView(e.session)) dispatch({ t: "view", view: e.session }); });
    const offLink = core.on("session_link", (e) => { if (typeof e.ts === "number" && typeof e.to === "object") dispatch({ t: "link", link: e as unknown as LinkEvent }); });
    void Promise.resolve(core.call("session.list", {})).then(
      (r: { sessions?: unknown[] } | undefined) => { if (live) dispatch({ t: "list", views: (r?.sessions ?? []).filter(isView) }); },
      () => { if (live) dispatch({ t: "list", views: [] }); },
    );
    void Promise.resolve(core.call("agent.backends", {})).then(
      (r: { backends?: BackendRow[] } | undefined) => {
        if (!live) return;
        dispatch({ t: "backends", rows: (r?.backends ?? []).map((b) => ({ ...b, name: plainName(b.name) ?? b.id, computers: b.computers ?? [] })) });
      },
      () => { if (live) dispatch({ t: "backends", rows: [] }); },
    );
    void Promise.resolve(core.call("computer.list", {})).then(
      (r: { computers?: { name: string; link?: string }[] } | undefined) => { if (live) dispatch({ t: "here", here: r?.computers?.find((c) => c.link === "self")?.name }); },
      () => undefined,
    );
    void Promise.resolve(apiRef.current.bots?.list?.()).then(
      (bots: { id: string; name: unknown }[] | undefined) => {
        if (!live || bots === undefined) return;
        dispatch({ t: "bots", names: new Map(bots.flatMap((b) => { const n = plainName(b.name); return n !== undefined ? [[b.id, n] as const] : []; })) });
      },
      () => undefined,
    );
    return () => {
      live = false;
      offView();
      offLink();
    };
  }, [core]);
  const done = useCallback((wave: number) => dispatch({ t: "done", wave }), []);
  return { ...state, waveDone: done };
}

/** The last line a session shows, from its history's newest events: the agent's last words (their last line), else the
 *  last tool it ran. */
export function lastLineOf(events: readonly Record<string, unknown>[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "assistant_message" && typeof e.text === "string" && e.text.trim() !== "") {
      const lines = e.text.split("\n").map((l) => l.trim()).filter(Boolean);
      return lines[lines.length - 1];
    }
    if (e.type === "tool_call") {
      const t = typeof e.displayTitle === "string" && e.displayTitle !== "" ? e.displayTitle : typeof e.name === "string" ? e.name : undefined;
      if (t !== undefined) return t;
    }
  }
  return undefined;
}

/** Where the person dragged blocks, kept in the plugin's own `places` setting (a device setting: a string of JSON, as
 *  settings hold no objects). Read once; written once per drag's end, only for blocks still known, newest kept when it
 *  would pass the setting's size (a string setting holds 8,192 characters; a page's write is held to 8,300 characters of
 *  its JSON, and 30 writes a minute per plugin tree). */
export const PLACES_MAX_CHARS = 8_000;

export function encodePlaces(places: Readonly<Record<string, { x: number; y: number }>>, known: ReadonlySet<string>): string {
  const entries = Object.entries(places).filter(([id]) => known.has(id)).map(([id, p]) => [id, { x: Math.round(p.x), y: Math.round(p.y) }] as const);
  // Newest last (insertion order): drop from the front until it fits. Measured as the setting's value is (the string's
  // own JSON, every quote escaped), which the page's write is held to.
  while (entries.length > 0 && JSON.stringify(JSON.stringify(Object.fromEntries(entries))).length > PLACES_MAX_CHARS) entries.shift();
  return entries.length === 0 ? "" : JSON.stringify(Object.fromEntries(entries));
}

export function decodePlaces(raw: unknown): Record<string, { x: number; y: number }> {
  if (typeof raw !== "string" || raw === "") return {};
  try {
    const v = JSON.parse(raw) as Record<string, { x?: unknown; y?: unknown }>;
    const out: Record<string, { x: number; y: number }> = {};
    for (const [id, p] of Object.entries(v ?? {})) if (typeof p?.x === "number" && typeof p?.y === "number" && Number.isFinite(p.x) && Number.isFinite(p.y)) out[id] = { x: p.x, y: p.y };
    return out;
  } catch {
    return {};
  }
}
