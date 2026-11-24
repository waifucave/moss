// The link bookkeeping (spec revision 20, §9.5): what a `session_link` does to the canvas. Pure.
//
// * A message between two main sessions that no line joins yet draws a line between them (`peer`, dotted) the first time
//   either messages the other, and the line stays. Parent and child, and a bot and its sessions, are joined from the start
//   (model.ts).
// * Each link is a wave: the line brightens in the sender's colour, travelling from the sender's point to the receiver's,
//   and the receiver's point lights as it arrives. A link from the person has no block to start from: only the receiving
//   point lights.
// * A wave lives until its view says it ended (`done`, on the receiving point's `animationend`: no timer). So a window that
//   never paints them (hidden) can't pile them up, a new link also drops waves older than `WAVE_STALE_MS` by the links'
//   own times, and at most `WAVES_MAX` are kept.
import type { CanvasModel, Edge } from "./model";

/** A link as the engine sends it (`SessionLinkEvent`): who, to whom, its kind and when; never its words. */
export interface LinkEvent {
  type?: "session_link";
  ts: number;
  from: { end: "user" } | { end: "session"; session: string; kind: string; bot?: string };
  to: { session: string; kind: string; bot?: string };
  link: "message" | "spawn" | "report";
}

export interface Wave {
  id: number;
  /** The line it travels; absent for the person's message (only the point lights). */
  edge?: string;
  /** The sending block, when a block sent it. */
  from?: string;
  to: string;
  /** The sender's colour(s) (the receiver's for the person's message); none: the theme's text colour. */
  color?: string;
  color2?: string;
  /** The receiver's colour(s): the arriving light turns into them. */
  toColor?: string;
  toColor2?: string;
  ts: number;
  link: LinkEvent["link"];
}

export interface LinkState {
  /** The peer lines, in the order they first appeared. */
  peers: Edge[];
  waves: Wave[];
  seq: number;
  /** How many links each line carried (by edge id), and how many of the person's messages each block got (`to:<block>`)
   *  while the canvas was open: a steady mark beside the waves, which go once drawn. */
  heard: Readonly<Record<string, number>>;
  /** The lines whose last link (the engine's record, `session.links`) is newer than when the canvas was last seen: what
   *  crossed while it was away, marked once with a quiet highlight when it opens. */
  away: Readonly<Record<string, true>>;
}

export const EMPTY_LINKS: LinkState = { peers: [], waves: [], seq: 0, heard: {}, away: {} };
const count = (heard: Readonly<Record<string, number>>, key: string) => ({ ...heard, [key]: (heard[key] ?? 0) + 1 });
export const WAVE_STALE_MS = 10_000;
export const WAVES_MAX = 48;

const colours = (b: { brand?: string; brand2?: string }) => ({ ...(b.brand !== undefined ? { color: b.brand } : {}), ...(b.brand2 !== undefined ? { color2: b.brand2 } : {}) });
const toColours = (b: { brand?: string; brand2?: string }) => ({ ...(b.brand !== undefined ? { toColor: b.brand } : {}), ...(b.brand2 !== undefined ? { toColor2: b.brand2 } : {}) });

export const peerId = (a: string, b: string) => (a < b ? `peer:${a}|${b}` : `peer:${b}|${a}`);

/** The line joining two blocks, either way round: a parent's, a bot's, or a peer line already drawn. */
export function edgeBetween(model: CanvasModel, peers: readonly Edge[], x: string, y: string): Edge | undefined {
  return model.edges.find((e) => (e.a === x && e.b === y) || (e.a === y && e.b === x)) ?? peers.find((e) => e.id === peerId(x, y));
}

/** What one link does. A link whose receiver has no block (a session this canvas doesn't show) does nothing; a link
 *  between two sessions of one block (a bot's conversation and its side thread) does nothing. */
export function applyLink(state: LinkState, link: LinkEvent, model: CanvasModel): LinkState {
  const to = model.blockOfSession(link.to.session);
  if (to === undefined || !model.byId.has(to)) return state;
  const fresh = state.waves.filter((w) => w.ts >= link.ts - WAVE_STALE_MS);
  const id = state.seq + 1;
  if (link.from.end === "user") {
    const wave: Wave = { id, to, ...colours(model.byId.get(to)!), ...toColours(model.byId.get(to)!), ts: link.ts, link: link.link };
    return { ...state, waves: [...fresh, wave].slice(-WAVES_MAX), seq: id, heard: count(state.heard, `to:${to}`) };
  }
  const from = model.blockOfSession(link.from.session);
  if (from === undefined || from === to || !model.byId.has(from)) return { ...state, waves: fresh };
  let peers = state.peers;
  let edge = edgeBetween(model, peers, from, to);
  if (edge === undefined) {
    edge = { id: peerId(from, to), kind: "peer", a: from < to ? from : to, b: from < to ? to : from };
    peers = [...peers, edge];
  }
  const wave: Wave = { id, edge: edge.id, from, to, ...colours(model.byId.get(from)!), ...toColours(model.byId.get(to)!), ts: link.ts, link: link.link };
  return { ...state, peers, waves: [...fresh, wave].slice(-WAVES_MAX), seq: id, heard: count(state.heard, edge.id) };
}

/** A pair of sessions that have talked, as the engine's record keeps it (`SessionLinkPair`): who to whom, the last link's
 *  kind and time. */
export interface LinkPair {
  from: { end: "user" } | { end: "session"; session: string; kind: string; bot?: string };
  to: { session: string; kind: string; bot?: string };
  last: "message" | "spawn" | "report";
  lastAt: number;
  count: number;
}

/** The engine's record, read as the canvas opens: a line for each pair of blocks that have talked and no line joins yet
 *  (so the lines survive the canvas being closed), and a quiet mark on each line whose last link is newer than `seenAt`
 *  (when the canvas was last seen). No wave plays for an old link. */
export function applyPairs(state: LinkState, pairs: readonly LinkPair[], model: CanvasModel, seenAt: number | undefined): LinkState {
  let peers = state.peers;
  const away: Record<string, true> = { ...state.away };
  for (const p of pairs) {
    if (p.from.end !== "session") continue;
    const from = model.blockOfSession(p.from.session);
    const to = model.blockOfSession(p.to.session);
    if (from === undefined || to === undefined || from === to || !model.byId.has(from) || !model.byId.has(to)) continue;
    let edge = edgeBetween(model, peers, from, to);
    if (edge === undefined) {
      edge = { id: peerId(from, to), kind: "peer", a: from < to ? from : to, b: from < to ? to : from };
      peers = [...peers, edge];
    }
    if (seenAt !== undefined && p.lastAt > seenAt) away[edge.id] = true;
  }
  return { ...state, peers, away };
}

/** A wave's view says it ended. */
export function waveDone(state: LinkState, id: number): LinkState {
  return state.waves.some((w) => w.id === id) ? { ...state, waves: state.waves.filter((w) => w.id !== id) } : state;
}

/** Peer lines whose blocks are both still on the canvas. */
export function livePeers(state: LinkState, model: CanvasModel): Edge[] {
  return state.peers.filter((e) => model.byId.has(e.a) && model.byId.has(e.b));
}
