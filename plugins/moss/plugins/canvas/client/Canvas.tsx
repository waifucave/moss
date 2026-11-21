// The canvas (spec revision 20, §9.5): every session as a block, the lines between them, the waves of messages, and the
// + button. It pans (drag the background, two-finger scroll) and zooms (pinch, or the control key with the wheel), with
// a fit control. Nothing in it ticks: what moves is CSS, only on a block that runs or waits and on a line a message is
// crossing, and it all pauses while the window is hidden.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { BlockView, type Port } from "./Block";
import { headAfter, loopPath, OUTLINE_RADIUS, perimeter, trip, type Trip, type TripInput } from "./choreography";
import { glowPiece, LIGHT_LENGTH, LIGHT_SPEED, lightPieces } from "./light";
import { bounds, EMPTY_LAYOUT, place, rectOf, SIZE, type Layout, type Point, type Rect } from "./layout";
import { livePeers, type LinkState, type Wave } from "./links";
import type { BackendLook, BotState } from "./look";
import { buildModel, type Block, type BotFacePins, type CanvasModel, type Edge } from "./model";
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
  botFaces?: ReadonlyMap<string, BotFacePins>;
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

/** Points along the line's curve, from one point to the other (24 steps). */
export function curvePoints(from: Point, fp: Port, to: Point, tp: Port): Point[] {
  const [c1, c2] = controls(from, fp, to, tp);
  return Array.from({ length: 25 }, (_, i) => {
    const t = i / 24;
    const u = 1 - t;
    return { x: u * u * u * from.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * to.x, y: u * u * u * from.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * to.y };
  });
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
  const model = useMemo<CanvasModel>(() => buildModel(p.sessions, p.backends, p.botNames, p.botStates, p.botFaces), [p.sessions, p.backends, p.botNames, p.botStates, p.botFaces]);

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

  // ---- The one light: each running block's loop, each message's trip ----
  // A trip is planned once, when its wave is first seen: from where the sender's own light is at that moment (read from
  // its loop's animation); and when the receiver starts running with this message, its loop light is planned to take
  // the message's light's place (kept while it runs, so its timing never changes under it).
  const loopEls = useRef(new Map<string, SVGGElement>());
  const loopFrom = useRef(new Map<string, { start: number; delay: number; id: number }>());
  const runningSince = useRef(new Map<string, number>());
  const trips = useRef(new Map<number, Trip>());
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  for (const b of model.blocks) {
    if (b.motion === "running") { if (!runningSince.current.has(b.id)) runningSince.current.set(b.id, now); }
    else { runningSince.current.delete(b.id); loopFrom.current.delete(b.id); }
  }
  for (const w of p.links.waves) {
    if (trips.current.has(w.id)) continue;
    const ends = waveEnds({ wave: w, edges, ports, rects });
    if (ends === undefined) continue;
    const sender = ends.from === undefined ? undefined : model.byId.get(ends.from.id);
    const receiver = model.byId.get(ends.to.id);
    let head: number | undefined;
    if (sender?.motion === "running") {
      const el = loopEls.current.get(sender.id);
      const piece = el?.querySelector(".cv-light") as (SVGPathElement & { getAnimations?: () => Animation[] }) | null | undefined;
      const progress = piece?.getAnimations?.()[0]?.effect?.getComputedTiming().progress;
      const r = rects.get(sender.id)!;
      const start = Number(el?.dataset.start ?? 0);
      head = typeof progress === "number" ? headAfter(r, start, (progress * perimeter(r, radiusOf(sender))) / LIGHT_SPEED, radiusOf(sender)) : start;
    }
    const since = receiver === undefined ? undefined : runningSince.current.get(receiver.id);
    const handover = receiver?.motion === "running" && since !== undefined && now - since < 100 && !loopFrom.current.has(receiver.id);
    const t = tripOf({ wave: w, edges, ports, rects, model }, head, handover);
    if (t === undefined) continue;
    trips.current.set(w.id, t);
    if (t.loopStart !== undefined) loopFrom.current.set(w.to, { start: t.loopStart.at, delay: t.loopStart.delay, id: w.id });
  }
  for (const id of [...trips.current.keys()]) if (!p.links.waves.some((w) => w.id === id)) trips.current.delete(id);

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
            {/* The wire: every block's outline in the lines' own stroke (an open block draws its own). */}
            {shown.filter((b) => b.id !== open).map((b) => <path key={`o-${b.id}`} className="cv-wire" data-wire={b.id} d={loopPath(rects.get(b.id)!, radiusOf(b)).d} />)}
            {shown.filter((b) => b.motion === "running" && b.id !== open).map((b) => {
              const from = loopFrom.current.get(b.id);
              return <Loop key={`l-${b.id}-${from?.id ?? 0}`} block={b} rect={rects.get(b.id)!} {...(from !== undefined ? { from } : {})} onEl={(el) => { if (el) loopEls.current.set(b.id, el); else loopEls.current.delete(b.id); }} />;
            })}
            {p.links.waves.map((w) => {
              const t = trips.current.get(w.id);
              return t === undefined ? <Gone key={w.id} id={w.id} onDone={p.onWaveDone} /> : <TripView key={w.id} wave={w} t={t} onDone={p.onWaveDone} />;
            })}
          </svg>
        </div>
      </div>
      </div>
    </section>
  );
}

const NONE: ReadonlySet<Port> = new Set();

/** A wave whose blocks aren't shown: it ends at once. */
function Gone({ id, onDone }: { id: number; onDone(id: number): void }) {
  useEffect(() => onDone(id), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

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

/** A wave's colours: the sender's (`--brand`, `--brand2`) and the receiver's (`--to`, `--to2`); none for a black-and-white
 *  brand (the text colour then). */
const waveColours = (w: Wave): Record<string, string> => ({
  ...(w.color !== undefined ? { "--brand": w.color } : {}), ...(w.color2 !== undefined ? { "--brand2": w.color2 } : {}),
  ...(w.toColor !== undefined ? { "--to": w.toColor } : {}), ...(w.toColor2 !== undefined ? { "--to2": w.toColor2 } : {}),
});

export const radiusOf = (b: Block | undefined) => (b?.type === "bot" ? 14 : OUTLINE_RADIUS);

/** A wave's trip (choreography.ts): `head` is where the sender's running light is now (undefined: idle), `handover`
 *  whether the receiver's own light starts from the arrival. Undefined when its blocks are not shown. */
export function tripOf(g: WaveGeometry, head: number | undefined, handover: boolean): Trip | undefined {
  const ends = waveEnds(g);
  if (ends === undefined) return undefined;
  const input: TripInput = { receiver: { rect: g.rects.get(ends.to.id)!, port: ends.to.port, radius: radiusOf(g.model.byId.get(ends.to.id)), handover } };
  if (ends.from !== undefined) {
    input.sender = { rect: g.rects.get(ends.from.id)!, port: ends.from.port, radius: radiusOf(g.model.byId.get(ends.from.id)), ...(head !== undefined ? { head } : {}) };
    input.line = curvePoints(ends.from.at, ends.from.port, ends.to.at, ends.to.port);
  }
  return trip(input);
}

const sec = (s: number) => `${Math.round(s * 1000) / 1000}s`;
const px = (v: number) => `${Math.round(v * 10) / 10}px`;
const mixOf = (a: string, b: string, m: number) => (m <= 0 ? `var(${a})` : m >= 1 ? `var(${b})` : `color-mix(in srgb, var(${b}) ${Math.round(m * 100)}%, var(${a}))`);

/** The ONE light (light.ts) walking a path: its dashes, tail to head, moving together at the light's one speed, and its
 *  glow. On a loop (`loop`) it circulates for ever with its head starting at `start`; on a trip it walks the path once
 *  from before its start, `travel` px, and is hidden again after. `morph` turns each dash from the sender's colours to
 *  the receiver's as it passes the receiver's point. */
function Light({ d, length, travel, loop, start = 0, delay = 0, morph, onEnd }: { d: string; length: number; travel: number; loop?: boolean; start?: number; delay?: number; morph?: number; onEnd?: () => void }) {
  const dashes = [...lightPieces().map((p, i) => ({ ...p, key: String(i), glow: false })), { ...glowPiece(), a: 1, mix: 1, key: "glow", glow: true }];
  return (
    <>
      {dashes.map((p, i) => {
        const o0 = p.length + p.back - start;
        const style = {
          "--pl": px(p.length + 0.6), "--gap": px(loop ? Math.max(0, length - p.length - 0.6) : length + 2 * LIGHT_LENGTH), "--a": p.a,
          "--o0": px(o0), "--o1": px(o0 - travel), "--dur": sec(travel / LIGHT_SPEED), "--delay": sec(delay),
          "--pc": mixOf("--c1", "--c2", p.mix), "--rc": mixOf("--r1", "--r2", p.mix),
          ...(morph !== undefined ? { "--morph-at": sec(morph + p.back / LIGHT_SPEED), "--morph-dur": sec((p.length + LIGHT_LENGTH * 0.25) / LIGHT_SPEED) } : {}),
        } as CSSProperties;
        const last = !loop && i === 0;
        return (
          <path
            key={p.key}
            className={`cv-light${p.glow ? " cv-light--glow" : ""}${loop ? " cv-light--loop" : ""}${morph !== undefined ? " cv-light--morph" : ""}`}
            d={d}
            style={style}
            {...(last ? { "data-last": "" } : {})}
            onAnimationEnd={last ? (e) => { if (e.animationName === "cv-run") onEnd?.(); } : undefined}
          />
        );
      })}
    </>
  );
}

/** A block's own circulating light while it runs: the same light as a message's, on its own loop of wire. One that
 *  started with a message starts where that message's light is on its loop, the moment the message's light is wholly on
 *  it, so it takes its place on the same spot. */
function Loop({ block, rect, from, onEl }: { block: Block; rect: Rect; from?: { start: number; delay: number }; onEl(el: SVGGElement | null): void }) {
  const loop = loopPath(rect, radiusOf(block));
  const style = { ...(block.brand !== undefined ? { "--brand": block.brand } : {}), ...(block.brand2 !== undefined ? { "--brand2": block.brand2 } : {}), "--on": sec(from?.delay ?? 0) } as CSSProperties;
  return (
    <g className="cv-loop" data-loop={block.id} data-start={Math.round((from?.start ?? 0) * 10) / 10} data-from={from !== undefined || undefined} style={style} ref={onEl}>
      <Light d={loop.d} length={loop.length} travel={loop.length} loop start={from?.start ?? 0} delay={from?.delay ?? 0} />
    </g>
  );
}

/** A message's trip: the one light on one path (the sender's loop to its point, the line, the receiver's loop), turning
 *  into the receiver's colours on its loop; it becomes the receiver's own light, or laps once and eases out to nothing. */
function TripView({ wave, t, onDone }: { wave: Wave; t: Trip; onDone(id: number): void }) {
  const style = { ...waveColours(wave), "--gather": sec(t.gather), ...(t.fade !== undefined ? { "--fade-at": sec(t.fade.at), "--fade": sec(t.fade.dur) } : {}) } as CSSProperties;
  return (
    <g className="cv-trip" data-wave={wave.id} data-handover={t.handover || undefined} style={style}>
      <g className="cv-trip__gather" data-gather={t.gather > 0 || undefined}>
        <g className="cv-trip__fade" data-fade={t.fade !== undefined || undefined}>
          <Light d={t.d} length={t.length} travel={t.travel} morph={t.arrive} onEnd={() => onDone(wave.id)} />
        </g>
      </g>
      {t.dots.map((d) => (
        <circle key={d.role} className="cv-dotflash" data-dot={d.role} cx={d.at.x} cy={d.at.y} r={3} style={{ "--delay": sec(Math.max(0, d.time - 12 / LIGHT_SPEED)), "--dur": sec((LIGHT_LENGTH * 0.4) / LIGHT_SPEED) } as CSSProperties} />
      ))}
      {t.parts.map((p) => <path key={p.kind} className="cv-part" data-part={p.kind} d={p.d} style={{ "--delay": sec(p.time) } as CSSProperties} />)}
    </g>
  );
}
