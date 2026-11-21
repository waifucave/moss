// The canvas (spec revision 20, §9.5): every session as a block, the lines between them, the waves of messages, and the
// + button. It pans (drag the background, two-finger scroll) and zooms (pinch, or the control key with the wheel), with
// a fit control. Nothing in it ticks: what moves is CSS, only on a block that runs or waits and on a line a message is
// crossing, and it all pauses while the window is hidden.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { BlockView, type BlockReaction, type Port } from "./Block";
import { crestIn, LINE_LIGHTS, lightPieces, planMessage, ringStartAt, type MessagePlan, type MessageStyle, type Reaction } from "./message";
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
  /** How a message crossing looks (message.ts): the owner picks one of three. */
  messageStyle?: MessageStyle;
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

  // ---- A message crossing (message.ts): planned once, when its wave is first seen ----
  // The sender's running light is read where it is now (variant B leaves as its crest passes the point). A receiver that
  // starts running with the message (even when its status lands a moment after the link) starts its running light with
  // the crest at its point as the message arrives.
  const style: MessageStyle = p.messageStyle ?? "A";
  const runningSince = useRef(new Map<string, number>());
  const handovers = useRef(new Map<string, { start: number; delay: number; id: number }>());
  const messages = useRef(new Map<number, Planned>());
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  for (const b of model.blocks) {
    if (b.motion === "running") { if (!runningSince.current.has(b.id)) runningSince.current.set(b.id, now); }
    else { runningSince.current.delete(b.id); handovers.current.delete(b.id); }
  }
  for (const w of p.links.waves) {
    let planned = messages.current.get(w.id);
    if (planned === undefined) {
      const ends = waveEnds({ wave: w, edges, ports, rects });
      if (ends === undefined) continue;
      const sender = ends.from === undefined ? undefined : model.byId.get(ends.from.id);
      const receiver = model.byId.get(ends.to.id);
      let crest: number | undefined;
      if (sender?.motion === "running" && ends.from !== undefined) crest = crestIn(ringRotation(viewport.current, sender.id), ends.from.port);
      const line = ends.from === undefined ? undefined : { d: curve(ends.from.at, ends.from.port, ends.to.at, ends.to.port), length: curveLength(ends.from.at, ends.from.port, ends.to.at, ends.to.port) };
      const plan = planMessage({
        style,
        line: line?.length ?? 0,
        ...(ends.from !== undefined ? { sender: { port: ends.from.port, ...(crest !== undefined ? { crestIn: crest } : {}) } } : {}),
        receiver: { port: ends.to.port, waiting: receiver?.motion === "waiting" },
      });
      planned = { plan, seen: now, ends, ...(line !== undefined ? { line } : {}) };
      messages.current.set(w.id, planned);
    }
    // The receiver starts running with it: its running light starts at its point as the message arrives.
    const since = runningSince.current.get(w.to);
    const elapsed = (now - planned.seen) / 1000;
    if (planned.handed !== true && since !== undefined && since >= planned.seen - 100 && elapsed < planned.plan.arrive + 0.05 && !handovers.current.has(w.to)) {
      planned.handed = true;
      handovers.current.set(w.to, { start: ringStartAt(planned.ends.to.port), delay: Math.max(0, planned.plan.arrive - elapsed), id: w.id });
    }
  }
  for (const id of [...messages.current.keys()]) if (!p.links.waves.some((w) => w.id === id)) messages.current.delete(id);
  // Each block's reactions to the messages crossing now: its own colour, or the sender's turning into its own.
  const reacts = new Map<string, BlockReaction[]>();
  for (const w of p.links.waves) {
    const m = messages.current.get(w.id);
    if (m === undefined) continue;
    const add = (id: string, list: readonly Reaction[], from: boolean) => {
      const out = reacts.get(id) ?? [];
      list.forEach((r, i) => out.push({ ...r, key: `${w.id}-${from ? "r" : "s"}${i}`, ...(from && r.morph ? { from: w.color ?? "var(--moss-color-text)" } : {}) }));
      reacts.set(id, out);
    };
    if (m.ends.from !== undefined) add(m.ends.from.id, m.plan.sender, false);
    add(m.ends.to.id, m.plan.receiver, true);
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
                {...(p.links.heard[`to:${b.id}`] !== undefined ? { heard: p.links.heard[`to:${b.id}`]! } : {})}
                {...(b.session !== undefined && lines[b.session] !== undefined ? { line: lines[b.session] } : {})}
                onToggle={toggle}
                onClose={() => setOpen(undefined)}
                onHeadPointerDown={onHeadDown}
                onSend={p.onSend}
                onOpenTab={p.onOpenTab}
                onOpenInMoss={p.onOpenInMoss}
                {...(handovers.current.get(b.id) !== undefined ? { handover: handovers.current.get(b.id)! } : {})}
                {...(reacts.get(b.id) !== undefined ? { reacts: reacts.get(b.id)! } : {})}
              />
            ))}
          </ul>
          <svg className="cv-over" width={worldW} height={worldH} aria-hidden="true">
            {p.links.waves.map((w) => {
              const m = messages.current.get(w.id);
              return m === undefined ? <Gone key={w.id} id={w.id} onDone={p.onWaveDone} /> : <MessageView key={w.id} wave={w} m={m} onDone={p.onWaveDone} />;
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

interface WaveGeometry { wave: Wave; edges: readonly Edge[]; ports: ReadonlyMap<string, [Port, Port]>; rects: ReadonlyMap<string, Rect> }
type Ends = { from?: { id: string; at: Point; port: Port }; to: { id: string; at: Point; port: Port } };
interface Planned { plan: MessagePlan; seen: number; ends: Ends; line?: { d: string; length: number }; handed?: boolean }

/** Where a wave leaves and arrives: the sending block and its point on the line, the receiving block and its point; for
 *  the person's message only the receiver, at its left point. Undefined when its line or blocks are not shown. */
export function waveEnds(g: WaveGeometry): Ends | undefined {
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

/** The turn a block's running light is at now, degrees (its turning layer's animation; 0 when it can't be read). */
function ringRotation(root: HTMLElement | null, id: string): number {
  const ring = root?.querySelector(`[data-block="${CSS.escape(id)}"] .cv-ring`) as (HTMLElement & { getAnimations?: (o?: { subtree?: boolean }) => Animation[] }) | null | undefined;
  if (ring == null) return 0;
  const a0 = parseFloat(ring.style.getPropertyValue("--a0")) || 0;
  const spin = ring.getAnimations?.({ subtree: true }).find((a) => (a as CSSAnimation).animationName === "cv-spin");
  const progress = spin?.effect?.getComputedTiming().progress;
  return a0 + (typeof progress === "number" ? progress * 360 : 0);
}

const sec = (s: number) => `${Math.round(s * 1000) / 1000}s`;
const px = (v: number) => `${Math.round(v * 10) / 10}px`;

/** A message's light on its line, in the running light's look (message.ts `LINE_LIGHTS`): its dashes, tail to head, at
 *  one speed, and a blurred glow; the points it passes light as it does; an unseen timer ends the wave. */
function MessageView({ wave, m, onDone }: { wave: Wave; m: Planned; onDone(id: number): void }) {
  const light = LINE_LIGHTS[m.plan.style];
  const colours = { ...(wave.color !== undefined ? { "--brand": wave.color } : {}), ...(wave.color2 !== undefined ? { "--brand2": wave.color2 } : {}) };
  const dashes = m.line === undefined ? [] : lightPieces(light);
  const travel = m.line === undefined ? 0 : m.line.length + light.length;
  const peak = light.profile.reduce((a, q) => (q.a > a.a ? q : a));
  const glow = { length: light.length * 0.4, back: Math.max(0, (1 - peak.at) * light.length - light.length * 0.2) };
  const dash = (d: { length: number; back: number }, extra: Record<string, string | number>) => ({
    "--pl": px(d.length + 0.6), "--gap": px(travel + 2 * light.length), "--o0": px(d.length + d.back), "--o1": px(d.length + d.back - travel),
    "--dur": sec(travel / light.speed), "--delay": sec(m.plan.depart), ...extra,
  }) as CSSProperties;
  return (
    <g className="cv-msg" data-wave={wave.id} data-style={m.plan.style} style={colours as CSSProperties}>
      {m.line !== undefined && (
        <>
          <path className="cv-mlight cv-mlight--glow" d={m.line.d} style={dash(glow, { "--a": light.glow })} />
          {dashes.map((d, i) => <path key={i} className="cv-mlight" d={m.line!.d} style={dash(d, { "--a": d.a, "--pc": d.mix <= 0 ? "var(--c1)" : `color-mix(in srgb, var(--c2) ${Math.round(d.mix * 100)}%, var(--c1))` })} />)}
          <path className="cv-part" d={m.line.d} style={{ "--delay": sec(m.plan.depart) } as CSSProperties} />
          <circle className="cv-dotflash" data-dot="sender" cx={m.ends.from!.at.x} cy={m.ends.from!.at.y} r={3} style={{ "--delay": sec(m.plan.depart), "--dur": sec((light.length * 0.6) / light.speed) } as CSSProperties} />
        </>
      )}
      <circle className="cv-dotflash" data-dot="receiver" cx={m.ends.to.at.x} cy={m.ends.to.at.y} r={3} style={{ "--delay": sec(Math.max(0, m.plan.arrive - 0.05)), "--dur": sec((light.length * 0.6) / light.speed) } as CSSProperties} />
      <circle className="cv-msg__timer" data-last="" r={0} style={{ "--dur": sec(m.plan.end) } as CSSProperties} onAnimationEnd={(e) => { if (e.animationName === "cv-timer") onDone(wave.id); }} />
    </g>
  );
}
