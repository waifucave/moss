// The canvas (spec revision 20, §9.5): every session as a block, the lines between them, the waves of messages, and the
// + button. It pans (drag the background, two-finger scroll) and zooms (pinch, or the control key with the wheel), with
// a fit control. Nothing in it ticks: what moves is CSS, only on a block that runs or waits and on a line a message is
// crossing, and it all pauses while the window is hidden.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { BlockView, type Port } from "./Block";
import { choreograph, CREST, OUTLINE_RADIUS, ringStart, type Choreography, type TripInput } from "./choreography";
import { bounds, EMPTY_LAYOUT, place, rectOf, SIZE, type Layout, type Point, type Rect } from "./layout";
import { livePeers, type LinkState, type Wave } from "./links";
import type { BackendLook, BotState } from "./look";
import { buildModel, type Block, type CanvasModel, type Edge } from "./model";
import { NewSessionPanel, type PanelStep, type Starter } from "./NewSessionPanel";
import type { BackendRow, FolderToken, RecentStart } from "./preselect";
import type { SessionView } from "@waifucave/moss-plugin-sdk";
import { S } from "./strings";

export interface View { x: number; y: number; k: number }

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 1.6;
/** The smallest zoom the canvas opens at on its own: the blocks' text still reads. */
export const FIRST_FIT_FLOOR = 0.7;
const clampK = (k: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, k));

export interface CanvasProps {
  sessions: Readonly<Record<string, SessionView>>;
  links: LinkState;
  backends: ReadonlyMap<string, BackendLook>;
  botNames?: ReadonlyMap<string, string>;
  /** Each bot's state from the activity feed (its face's expression). */
  botStates?: ReadonlyMap<string, BotState>;
  rows: readonly BackendRow[] | undefined;
  here?: string;
  loaded?: boolean;
  onWaveDone(id: number): void;
  onSend(session: string, text: string): Promise<void>;
  onOpenTab(session: string): void;
  onOpenInMoss(bot: string): Promise<void>;
  lastLine(session: string): Promise<string | undefined>;
  /** Where the person dragged blocks, and the drag's end. */
  places: Readonly<Record<string, Point>>;
  onPlace(id: string, at: Point): void;
  /** Asked inside the + press: the last start and the recent folders. */
  beginNew(): { recent: Promise<RecentStart | undefined>; folders: Promise<readonly FolderToken[] | undefined> };
  starter: Starter;
  /** A session whose block is brought into view (the tab corner's switch). */
  focus?: string;
  /** The view kept across a reload of the window's document. */
  view?: View;
  onView?(view: View): void;
  /** The gallery's pictures: a block or the + panel open at first, ended sessions shown. */
  initial?: { open?: string; panel?: boolean; step?: PanelStep; showEnded?: boolean };
}

/** Where a point of a block is, in the world. */
export function portAt(r: Rect, port: Port): Point {
  switch (port) {
    case "l": return { x: r.x, y: r.y + r.h / 2 };
    case "r": return { x: r.x + r.w, y: r.y + r.h / 2 };
    case "t": return { x: r.x + r.w / 2, y: r.y };
    case "b": return { x: r.x + r.w / 2, y: r.y + r.h };
  }
}

/** The points a line joins: a parent's right to its child's left; between two main sessions, the upper one's bottom to
 *  the lower one's top (both bottoms when they sit side by side). */
export function edgePorts(e: Edge, ra: Rect, rb: Rect): [Port, Port] {
  if (e.kind !== "peer") return ["r", "l"];
  if (ra.y + ra.h <= rb.y) return ["b", "t"];
  if (rb.y + rb.h <= ra.y) return ["t", "b"];
  return ["b", "b"];
}

/** The control points of a soft curve from one point to another, leaving and arriving square to each point's side. */
function controls(from: Point, fp: Port, to: Point, tp: Port): [Point, Point] {
  const out = (p: Point, port: Port, d: number): Point => (port === "l" ? { x: p.x - d, y: p.y } : port === "r" ? { x: p.x + d, y: p.y } : port === "t" ? { x: p.x, y: p.y - d } : { x: p.x, y: p.y + d });
  const horizontal = fp === "l" || fp === "r";
  const span = horizontal ? Math.abs(to.x - from.x) : Math.abs(to.y - from.y);
  const d = Math.max(40, span / 2);
  return [out(from, fp, d), out(to, tp, d)];
}

export function curve(from: Point, fp: Port, to: Point, tp: Port): string {
  const [c1, c2] = controls(from, fp, to, tp);
  const n = (v: number) => Math.round(v * 10) / 10;
  return `M${n(from.x)},${n(from.y)} C${n(c1.x)},${n(c1.y)} ${n(c2.x)},${n(c2.y)} ${n(to.x)},${n(to.y)}`;
}

/** The curve's length in the world's pixels (16 straight steps along it: close enough to size a wave). */
export function curveLength(from: Point, fp: Port, to: Point, tp: Port): number {
  const [c1, c2] = controls(from, fp, to, tp);
  const at = (t: number): Point => {
    const u = 1 - t;
    return { x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x, y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y };
  };
  let len = 0;
  let prev = from;
  for (let i = 1; i <= 16; i++) {
    const p = at(i / 16);
    len += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
  }
  return len;
}

export function Canvas(p: CanvasProps) {
  const model = useMemo<CanvasModel>(() => buildModel(p.sessions, p.backends, p.botNames, p.botStates), [p.sessions, p.backends, p.botNames, p.botStates]);

  // Ended blocks fold into a count, but one that ended while the canvas was open stays until it is opened again: the
  // person sees it end (and its last report arrive). Its slot stays reserved either way, so nothing moves.
  const alive = useRef(new Set<string>());
  for (const b of model.blocks) if (b.motion !== "ended") alive.current.add(b.id);
  const [showEnded, setShowEnded] = useState(p.initial?.showEnded ?? false);
  const folded = model.blocks.filter((b) => b.motion === "ended" && !alive.current.has(b.id));
  const shown = showEnded ? model.blocks : model.blocks.filter((b) => !(b.motion === "ended" && !alive.current.has(b.id)));
  const shownIds = new Set(shown.map((b) => b.id));

  // The layout: slots only ever added (layout.ts). Every block gets one, shown or folded, so unfolding moves nothing.
  const layoutRef = useRef<Layout>(EMPTY_LAYOUT);
  const [drag, setDrag] = useState<{ id: string; at: Point } | undefined>();
  const moved = drag === undefined ? p.places : { ...p.places, [drag.id]: drag.at };
  layoutRef.current = place(layoutRef.current, model.blocks, p.places);
  const layout = layoutRef.current;
  const rect = (b: Block): Rect => rectOf(layout, b.id, b.type, moved) ?? { x: 0, y: 0, ...SIZE[b.type] };
  const rects = new Map(shown.map((b) => [b.id, rect(b)] as const));

  const edges = [...model.edges, ...livePeers(p.links, model)].filter((e) => shownIds.has(e.a) && shownIds.has(e.b));
  const joined = new Map<string, Set<Port>>();
  const ports = new Map<string, [Port, Port]>();
  for (const e of edges) {
    const pr = edgePorts(e, rects.get(e.a)!, rects.get(e.b)!);
    ports.set(e.id, pr);
    (joined.get(e.a) ?? joined.set(e.a, new Set()).get(e.a)!).add(pr[0]);
    (joined.get(e.b) ?? joined.set(e.b, new Set()).get(e.b)!).add(pr[1]);
  }

  // ---- The view: pan and zoom ----
  const viewport = useRef<HTMLDivElement>(null);
  const [view, setViewState] = useState<View | undefined>(p.view);
  const setView = useCallback((v: View) => { setViewState(v); p.onView?.(v); }, [p.onView]); // eslint-disable-line react-hooks/exhaustive-deps
  const size = (): { w: number; h: number } => {
    const el = viewport.current;
    return { w: el?.clientWidth || 1200, h: el?.clientHeight || 760 };
  };
  /** Every shown block in view (the Fit control: down to `ZOOM_MIN`, the whole picture). `floor`: no smaller than that,
   *  from the top left when it doesn't all fit (the first view of many sessions: readable, the rest a pan away). */
  const fit = useCallback((floor = ZOOM_MIN) => {
    const box = bounds([...rects.values()]);
    const { w, h } = size();
    if (box.w === 0) return setView({ x: 0, y: 0, k: 1 });
    const m = 40;
    const whole = Math.min(1, (w - 2 * m) / box.w, (h - 2 * m) / box.h);
    const k = clampK(Math.max(floor, whole));
    const x = box.w * k <= w - 2 * m ? (w - box.w * k) / 2 : m;
    const y = box.h * k <= h - 2 * m ? Math.min(m, (h - box.h * k) / 2) : m;
    setView({ x: Math.round(x - box.x * k), y: Math.round(y - box.y * k), k });
  }, [rects, setView]); // eslint-disable-line react-hooks/exhaustive-deps
  // The first time there is something to show and no view was kept: fit it, readably. Never again on its own (no jumps).
  useLayoutEffect(() => { if (view === undefined && shown.length > 0) fit(FIRST_FIT_FLOOR); }, [view === undefined, shown.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const v = view ?? { x: 0, y: 0, k: 1 };
  const zoomAt = (k: number, cx: number, cy: number) => {
    const nk = clampK(k);
    setView({ x: Math.round(cx - ((cx - v.x) * nk) / v.k), y: Math.round(cy - ((cy - v.y) * nk) / v.k), k: nk });
  };
  // A session asked for (the corner's switch): its block centred, at the zoom as it is.
  const focused = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (p.focus === undefined || focused.current === p.focus) return;
    const b = model.byId.get(p.focus);
    if (b === undefined) return;
    focused.current = p.focus;
    const r = rect(b);
    const { w, h } = size();
    const k = view?.k ?? 1;
    setView({ x: Math.round(w / 2 - (r.x + r.w / 2) * k), y: Math.round(h / 2 - (r.y + r.h / 2) * k), k });
  });

  // The wheel: pinch (the browser's ctrl+wheel) and ctrl+wheel zoom about the pointer; plain scroll pans.
  const viewRef = useRef(v);
  viewRef.current = v;
  useEffect(() => {
    const el = viewport.current;
    if (el === null) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const cur = viewRef.current;
      if (e.ctrlKey) {
        const box = el.getBoundingClientRect();
        const cx = e.clientX - box.left;
        const cy = e.clientY - box.top;
        const nk = clampK(cur.k * Math.exp(-e.deltaY * 0.01));
        setView({ x: Math.round(cx - ((cx - cur.x) * nk) / cur.k), y: Math.round(cy - ((cy - cur.y) * nk) / cur.k), k: nk });
      } else {
        setView({ x: Math.round(cur.x - e.deltaX), y: Math.round(cur.y - e.deltaY), k: cur.k });
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [setView]);

  // ---- Opening a block; clicking elsewhere closes it ----
  const [open, setOpen] = useState<string | undefined>(p.initial?.open);
  const [lines, setLines] = useState<Record<string, string | null>>({});
  useEffect(() => {
    const b = open === undefined ? undefined : model.byId.get(open);
    const session = b?.type === "bot" ? undefined : b?.session;
    if (session === undefined || lines[session] !== undefined) return;
    let live = true;
    void p.lastLine(session).then((l) => live && setLines((was) => ({ ...was, [session]: l ?? null })), () => live && setLines((was) => ({ ...was, [session]: null })));
    return () => { live = false; };
  }, [open, open !== undefined && model.byId.has(open)]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Dragging the background pans; dragging a block moves it ----
  const gesture = useRef<{ kind: "pan" | "block"; id?: string; x: number; y: number; from: Point; moved: boolean; pointer: number } | undefined>(undefined);
  const suppressClick = useRef(false);
  const onViewportDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest?.(".cv-card, .cv-panel, .cv-bar")) return;
    setOpen(undefined);
    gesture.current = { kind: "pan", x: e.clientX, y: e.clientY, from: { x: v.x, y: v.y }, moved: false, pointer: e.pointerId };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onHeadDown = (e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0) return;
    const b = model.byId.get(id);
    if (b === undefined) return;
    const r = rect(b);
    gesture.current = { kind: "block", id, x: e.clientX, y: e.clientY, from: { x: r.x, y: r.y }, moved: false, pointer: e.pointerId };
    viewport.current?.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (g === undefined || g.pointer !== e.pointerId) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.moved && Math.hypot(dx, dy) < 4) return;
    g.moved = true;
    if (g.kind === "pan") setView({ x: Math.round(g.from.x + dx), y: Math.round(g.from.y + dy), k: v.k });
    else setDrag({ id: g.id!, at: { x: Math.round(g.from.x + dx / v.k), y: Math.round(g.from.y + dy / v.k) } });
  };
  const onUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (g === undefined || g.pointer !== e.pointerId) return;
    gesture.current = undefined;
    if (g.kind === "block" && g.moved && drag !== undefined) {
      suppressClick.current = true;
      p.onPlace(drag.id, drag.at);
      setDrag(undefined);
    }
  };
  const toggle = (id: string) => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    setOpen((o) => (o === id ? undefined : id));
  };

  // ---- + ----
  const [panel, setPanel] = useState<{ recent: Promise<RecentStart | undefined>; folders: Promise<readonly FolderToken[] | undefined> } | undefined>(
    () => (p.initial?.panel ? p.beginNew() : undefined),
  );
  const plus = () => {
    if (panel !== undefined) return setPanel(undefined);
    // Inside the press: the recent folders are the app's dialog's answer, which only a press may ask.
    setPanel(p.beginNew());
    setOpen(undefined);
  };

  // ---- Hidden: every animation pauses ----
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.visibilityState === "hidden");
  useEffect(() => {
    const on = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  // A running receiver's running light starts where the newest message arrives at it (choreography.ts).
  const handovers = new Map<string, { id: number; start: number; delay: number }>();
  for (const w of p.links.waves) {
    const trip = tripOf({ wave: w, edges, ports, rects, model });
    if (trip?.handover !== undefined) handovers.set(w.to, { id: w.id, start: ringStart(trip.handover.angle), delay: trip.handover.delay });
  }
  const mains = model.blocks.filter((b) => b.type === "main" && b.motion !== "ended");
  const running = mains.filter((b) => b.motion === "running").length;
  const waiting = mains.filter((b) => b.motion === "waiting").length;
  const world = bounds([...rects.values()]);
  const worldW = Math.max(world.x + world.w + 200, 400);
  const worldH = Math.max(world.y + world.h + 200, 300);
  const empty = p.loaded !== false && shown.length === 0;

  return (
    <section className="cv" aria-label={S.canvas} data-hidden={hidden || undefined} onKeyDown={(e) => { if (e.key === "Escape") { setOpen(undefined); setPanel(undefined); } }}>
      <header className="cv-bar">
        <button type="button" className="cv-plus" aria-expanded={panel !== undefined} aria-haspopup="dialog" onClick={plus}>{S.plus}</button>
        <span className="cv-summary" role="status">{S.summary(mains.length, running, waiting)}</span>
        {folded.length > 0 && (
          <button type="button" className="cv-folded" aria-pressed={showEnded} onClick={() => setShowEnded((s) => !s)}>
            {showEnded ? S.hideEnded : S.endedCount(folded.length)}
          </button>
        )}
        <span className="cv-zoom" role="group" aria-label={S.fitLong}>
          <button type="button" className="cv-icon" aria-label={S.zoomOut} onClick={() => { const { w, h } = size(); zoomAt(v.k / 1.2, w / 2, h / 2); }}>−</button>
          <button type="button" className="cv-fit" aria-label={S.fitLong} onClick={() => fit()}>{S.fit}</button>
          <button type="button" className="cv-icon" aria-label={S.zoomIn} onClick={() => { const { w, h } = size(); zoomAt(v.k * 1.2, w / 2, h / 2); }}>+</button>
        </span>
      </header>
      <div className="cv-stage">
      {panel !== undefined && (
        <NewSessionPanel
          rows={p.rows}
          here={p.here}
          recent={panel.recent}
          folders={panel.folders}
          starter={p.starter}
          onStarted={(session) => { setPanel(undefined); p.onOpenTab(session); }}
          onClose={() => setPanel(undefined)}
          {...(p.initial?.step !== undefined ? { initialStep: p.initial.step } : {})}
        />
      )}
      <div
        className="cv-viewport"
        ref={viewport}
        style={{ backgroundSize: `${22 * v.k}px ${22 * v.k}px`, backgroundPosition: `${v.x}px ${v.y}px` }}
        onPointerDown={onViewportDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {empty && (
          <div className="cv-empty">
            <p className="cv-empty__title">{S.emptyTitle}</p>
            <p className="cv-empty__detail">{S.emptyDetail}</p>
          </div>
        )}
        <div className="cv-world" style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.k})`, width: worldW, height: worldH } as CSSProperties}>
          <svg className="cv-lines" width={worldW} height={worldH} aria-hidden="true">
            {edges.map((e) => {
              const [pa, pb] = ports.get(e.id)!;
              return <path key={e.id} className="cv-line" data-kind={e.kind} data-edge={e.id} data-links={p.links.heard[e.id] ?? 0} d={curve(portAt(rects.get(e.a)!, pa), pa, portAt(rects.get(e.b)!, pb), pb)} />;
            })}
          </svg>
          <ul className="cv-blocks" aria-label={S.blocks}>
            {shown.map((b) => (
              <BlockView
                key={b.id}
                block={b}
                rect={rects.get(b.id)!}
                {...(b.backend !== undefined && p.backends.has(b.backend) ? { look: p.backends.get(b.backend)! } : {})}
                open={open === b.id}
                joined={joined.get(b.id) ?? NONE}
                dragging={drag?.id === b.id}
                {...(handovers.get(b.id) !== undefined ? { handover: handovers.get(b.id)! } : {})}
                {...(p.links.heard[`to:${b.id}`] !== undefined ? { heard: p.links.heard[`to:${b.id}`]! } : {})}
                {...(b.session !== undefined && lines[b.session] !== undefined ? { line: lines[b.session] } : {})}
                onToggle={toggle}
                onClose={() => setOpen(undefined)}
                onHeadPointerDown={onHeadDown}
                onSend={p.onSend}
                onOpenTab={p.onOpenTab}
                onOpenInMoss={p.onOpenInMoss}
              />
            ))}
          </ul>
          <svg className="cv-over" width={worldW} height={worldH} aria-hidden="true">
            {p.links.waves.map((w) => <Trip key={w.id} wave={w} edges={edges} ports={ports} rects={rects} model={model} onDone={p.onWaveDone} />)}
          </svg>
        </div>
      </div>
      </div>
    </section>
  );
}

const NONE: ReadonlySet<Port> = new Set();

interface WaveGeometry { wave: Wave; edges: readonly Edge[]; ports: ReadonlyMap<string, [Port, Port]>; rects: ReadonlyMap<string, Rect>; model: CanvasModel }

/** Where a wave leaves and arrives: the sending block and its point on the line, the receiving block and its point; for
 *  the person's message only the receiver, at its left point. Undefined when its line or blocks are not shown. */
export function waveEnds(g: Omit<WaveGeometry, "model">): { from?: { id: string; at: Point; port: Port }; to: { id: string; at: Point; port: Port } } | undefined {
  const w = g.wave;
  if (w.edge === undefined) {
    const r = g.rects.get(w.to);
    return r === undefined ? undefined : { to: { id: w.to, at: portAt(r, "l"), port: "l" } };
  }
  const e = g.edges.find((x) => x.id === w.edge);
  const pr = e === undefined ? undefined : g.ports.get(e.id);
  if (e === undefined || pr === undefined) return undefined;
  const sendA = w.from === e.a;
  const [fromId, toId] = sendA ? [e.a, e.b] : [e.b, e.a];
  const [fp, tp] = sendA ? pr : [pr[1], pr[0]];
  const rf = g.rects.get(fromId);
  const rt = g.rects.get(toId);
  if (rf === undefined || rt === undefined) return undefined;
  return { from: { id: fromId, at: portAt(rf, fp), port: fp }, to: { id: toId, at: portAt(rt, tp), port: tp } };
}

/** A wave's colours as the blocks': the sender's (`--brand`, `--brand2`) and the receiver's (`--to`, `--to2`); none for a
 *  black-and-white brand (the text colour then). */
const waveColours = (w: Wave): Record<string, string> => ({
  ...(w.color !== undefined ? { "--brand": w.color } : {}), ...(w.color2 !== undefined ? { "--brand2": w.color2 } : {}),
  ...(w.toColor !== undefined ? { "--to": w.toColor } : {}), ...(w.toColor2 !== undefined ? { "--to2": w.toColor2 } : {}),
});

const radiusOf = (b: Block | undefined) => (b?.type === "bot" ? 14 : OUTLINE_RADIUS);

/** A wave's whole trip (choreography.ts), or undefined when its blocks are not shown. */
export function tripOf(g: WaveGeometry): Choreography | undefined {
  const ends = waveEnds(g);
  if (ends === undefined) return undefined;
  const receiver = g.model.byId.get(ends.to.id);
  const rr = g.rects.get(ends.to.id)!;
  const input: TripInput = { receiver: { rect: rr, port: ends.to.port, radius: radiusOf(receiver), running: receiver?.motion === "running" } };
  if (ends.from !== undefined) {
    const rf = g.rects.get(ends.from.id)!;
    input.sender = { rect: rf, port: ends.from.port, radius: radiusOf(g.model.byId.get(ends.from.id)) };
    input.line = { d: curve(ends.from.at, ends.from.port, ends.to.at, ends.to.port), length: curveLength(ends.from.at, ends.from.port, ends.to.at, ends.to.port), from: ends.from.at, to: ends.to.at };
  }
  return choreograph(input);
}

const sec = (s: number) => `${Math.round(s * 1000) / 1000}s`;

/** A message's trip, drawn over the blocks: one bright crest leaving the sender's outline through its point, down the
 *  line, through the receiver's point and round its outline, turning into the receiver's colour. The trip ends (and the
 *  wave goes) when its last stretch's animation ends. */
function Trip(g: WaveGeometry & { onDone(id: number): void }) {
  const c = tripOf(g);
  useEffect(() => { if (c === undefined) g.onDone(g.wave.id); }, [c === undefined]); // eslint-disable-line react-hooks/exhaustive-deps
  if (c === undefined) return null;
  const last = c.segments.reduce((a, s, i) => (s.delay + s.duration > c.segments[a]!.delay + c.segments[a]!.duration ? i : a), 0);
  const id = g.wave.id;
  return (
    <g className="cv-trip" data-wave={id} style={waveColours(g.wave) as CSSProperties}>
      {c.segments.map((s, i) => {
        const grad = `cv-trip-${id}-${i}`;
        const style = { "--len": `${s.length}px`, "--crest": `${CREST}px`, "--dur": sec(s.duration), "--delay": sec(s.delay) } as CSSProperties;
        return (
          <g key={s.kind} data-segment={s.kind}>
            <linearGradient id={grad} gradientUnits="userSpaceOnUse" x1={s.from.x} y1={s.from.y} x2={s.to.x} y2={s.to.y}>
              <stop className={s.morph ? "cv-trip__from-sender" : "cv-trip__c1"} offset="0" />
              <stop className={s.morph ? "cv-trip__to-receiver" : "cv-trip__c2"} offset="1" />
            </linearGradient>
            <path className="cv-seg cv-seg--glow" d={s.d} stroke={`url(#${grad})`} style={style} />
            <path className="cv-seg cv-seg--light" d={s.d} stroke={`url(#${grad})`} style={style} {...(i === last ? { "data-last": "" } : {})} onAnimationEnd={i === last ? () => g.onDone(id) : undefined} />
          </g>
        );
      })}
      {c.dots.map((d) => (
        <circle key={d.role} className="cv-dotflash" data-dot={d.role} cx={d.at.x} cy={d.at.y} r={3} style={{ "--dur": sec(d.duration), "--delay": sec(d.delay) } as CSSProperties} />
      ))}
    </g>
  );
}
