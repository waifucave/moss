// The canvas on the runtime (spec revision 20, §9.5): MOSS Code's start page (`main` keyed `start`) and the control in a
// session tab's corner (`session.corner`) that switches to it with that session's block in view. Everything the page
// asks of MOSS goes through the part's own door:
// * the sessions and their links (`session.list`, `session_changed`, `session_link`: source.ts);
// * a block's composer sends the person's own words (`useUserSend`, inside their press);
// * "Open tab" and the corner move the window (`navigate`, which every `main` and `session.corner` entry gets);
// * "Open in MOSS" asks the engine to open the bot's conversation in MOSS (`app.openIn`, on the person's press);
// * + asks for the last start and the recent folders (`agent.recent`, `ui.pick` with `recent`), the agent's models and
//   efforts (`agent.options`), the folder dialog (`ui.pick`) and starts the session (`agent.start`), then opens its tab.
// Until lanes CA and CG serve them, the calls that aren't served yet fail soft: the agent's own default, the dialog.
import { useKept, usePluginApi, useCore, useUserSend } from "@waifucave/moss-plugin-sdk/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, type CanvasProps, type View } from "./Canvas";
import type { Point } from "./layout";
import type { FolderToken } from "./preselect";
import { decodePlaces, encodePlaces, lastLineOf, useSessionGraph } from "./source";
import { S } from "./strings";

/** `main`'s route as the shell holds it. */
export interface ShellRoute {
  route: string;
  params: Record<string, string>;
}

export interface CanvasStartProps {
  route?: string;
  /** `session`: the block to bring into view (the corner's switch). */
  params?: { session?: string };
  navigate?: (route: ShellRoute) => void;
  /** The gallery's pictures only. */
  initial?: CanvasProps["initial"];
  /** How a message crossing looks, while the owner picks (the gallery's switch). */
  messageStyle?: CanvasProps["messageStyle"];
}

/** A pick's answer, in the shape `ui.pick` gives (`UiPickResult`), or the older one (`{ token, name }`). */
function pickedOf(r: unknown): FolderToken | undefined {
  const o = r as { picked?: FolderToken; token?: string; name?: string } | undefined;
  if (o?.picked !== undefined) return o.picked;
  return typeof o?.token === "string" ? { token: o.token, name: o.name ?? "" } : undefined;
}

export function CanvasStart({ props }: { props: CanvasStartProps }) {
  const core = useCore();
  // Read through a ref: what the page does with it never depends on the object's identity.
  const apiRef = useRef(usePluginApi());
  apiRef.current = usePluginApi();
  const api = apiRef.current;
  const send = useUserSend();
  const graph = useSessionGraph();
  const [kept, setKept] = useKept<View | undefined>("view", undefined);

  // Where the person dragged blocks: read once, written at each drag's end.
  const [places, setPlaces] = useState<Record<string, Point>>({});
  useEffect(() => {
    let live = true;
    void Promise.resolve(apiRef.current.settings?.get?.("places")).then((raw) => live && setPlaces((was) => ({ ...decodePlaces(raw), ...was })), () => undefined);
    return () => { live = false; };
  }, []);
  const known = useMemo(() => {
    const ids = new Set(Object.keys(graph.sessions));
    for (const s of Object.values(graph.sessions)) {
      if (s.bot !== undefined) ids.add(`bot:${s.bot}`);
      if (s.startedBy?.kind === "bot") ids.add(`bot:${s.startedBy.bot}`);
      for (const r of s.subagents ?? []) ids.add(`sub:${s.id}:${r.id}`);
    }
    return ids;
  }, [graph.sessions]);
  const onPlace = useCallback((id: string, at: Point) => {
    setPlaces((was) => {
      const { [id]: _old, ...rest } = was;
      const next = { ...rest, [id]: at };
      void Promise.resolve(apiRef.current.settings?.set?.("places", encodePlaces(next, known))).catch(() => undefined);
      return next;
    });
  }, [known]);

  const openTab = useCallback((session: string) => {
    if (props.navigate !== undefined) props.navigate({ route: "agent", params: { session } });
    else void apiRef.current.shell?.go?.({ session });
  }, [props.navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  const call = (method: string, params: unknown) => (core === undefined ? Promise.reject(new Error("MOSS isn't running")) : Promise.resolve(core.call(method, params)));

  return (
    <Canvas
      sessions={graph.sessions}
      links={graph.links}
      backends={graph.backends}
      botNames={graph.botNames}
      botFaces={graph.botFaces}
      botStates={graph.botStates}
      rows={graph.rows}
      here={graph.here}
      loaded={graph.loaded}
      onWaveDone={graph.waveDone}
      onSend={(session, text) => (send === undefined ? Promise.reject(new Error("This page can't send")) : send({ session }, { text }))}
      onOpenTab={openTab}
      onOpenInMoss={async (bot) => {
        const r = (await call("app.openIn", { program: "moss", what: { kind: "bot", bot } })) as { opened?: boolean; refused?: string } | undefined;
        if (r?.opened === false) throw new Error(r.refused ?? "MOSS didn't open it");
      }}
      lastLine={(session) => Promise.resolve(api.sessions?.history?.(session, { limit: 40 })).then((h) => lastLineOf(h?.events ?? []))}
      places={places}
      onPlace={onPlace}
      beginNew={() => {
        // Inside the + press. The recent folders are asked only once `agent.recent` answers: both are lane CA's, served
        // together, and a `ui.pick` that doesn't know `dialog: false` would open the folder dialog on a press of +.
        const recent = call("agent.recent", {});
        return {
          recent: recent.catch(() => undefined),
          folders: recent.then(
            () => call("ui.pick", { kind: "folder", use: "agent.start", recent: true, dialog: false }).then((r) => (r as { recent?: FolderToken[] } | undefined)?.recent, () => undefined),
            () => undefined,
          ),
        };
      }}
      starter={{
        options: (agent) => call("agent.options", { backend: agent }).catch(() => undefined) as never,
        pickFolder: () => call("ui.pick", { kind: "folder", use: "agent.start" }).then(pickedOf),
        start: (params) => call("agent.start", params).then((r) => (r as { session?: string } | undefined)?.session),
      }}
      {...(props.params?.session !== undefined ? { focus: props.params.session } : {})}
      {...(kept !== undefined ? { view: kept } : {})}
      onView={setKept}
      {...(props.initial !== undefined ? { initial: props.initial } : {})}
      {...(props.messageStyle !== undefined ? { messageStyle: props.messageStyle } : {})}
    />
  );
}

export interface CanvasCornerProps {
  session: string;
  kind: string;
  navigate?: (route: ShellRoute) => void;
}

/** The switch in a session tab's corner: to the canvas, with this session's block in view. "Open tab" on the block comes
 *  back. */
export function CanvasCorner({ props }: { props: CanvasCornerProps }) {
  const api = usePluginApi();
  return (
    <button
      type="button"
      className="cv-corner"
      title={S.corner}
      aria-label={S.corner}
      onClick={() => {
        if (props.navigate !== undefined) props.navigate({ route: "start", params: { session: props.session } });
        else void api.shell?.go?.({ page: "start" });
      }}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect width="7" height="5" x="2" y="4" rx="1.5" />
        <rect width="7" height="5" x="15" y="4" rx="1.5" />
        <rect width="7" height="5" x="15" y="15" rx="1.5" />
        <path d="M9 6.5h6M18.5 9v6" />
      </svg>
    </button>
  );
}
