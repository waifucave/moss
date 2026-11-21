// The canvas's automatic layout: stable, so a new block never makes another move (spec revision 20, §9.5). Pure.
//
// Blocks sit in a grid of slots. A slot, once given, is never taken back or changed: placing only ever adds. So nothing
// on the canvas jumps when a session starts, ends, or is folded away (an ended block's slot stays reserved).
// * A block with a parent (a child session, a subagent, a bot's session) goes one column to its parent's right, in the
//   first free row at or below its parent's.
// * A block with none (a session the person started, a bot) starts a band below everything in its group: a group is
//   `GROUP_COLS` columns wide (a session, its children, theirs) and takes up to `GROUP_ROWS` rows of bands; the next band
//   then opens a new group to the right. Thirty sessions are five groups side by side, not one column thirty tall.
// * A block the person dragged sits where they put it (`moved`); its slot stays reserved, and nothing new is placed
//   over where it now is.
import type { BlockType } from "./model";

export const SIZE: Readonly<Record<BlockType, { w: number; h: number }>> = {
  main: { w: 252, h: 86 },
  sub: { w: 212, h: 68 },
  bot: { w: 176, h: 64 },
};
export const COL_W = 320;
export const ROW_H = 112;
export const PAD = 48;
export const GROUP_ROWS = 6;
export const GROUP_COLS = 3;
/** Space kept clear around a new block. */
const GAP = 12;

export interface Slot { col: number; row: number }
export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

export interface Layout {
  /** Every block's slot, never changed once given. */
  readonly slots: Readonly<Record<string, Slot>>;
  /** The group the next band opens in. */
  readonly group: number;
}

export const EMPTY_LAYOUT: Layout = { slots: {}, group: 0 };

export interface LayoutBlock {
  id: string;
  type: BlockType;
  parent?: string;
  startedAt: number;
}

/** Where a slot puts a block of `type` (a smaller block sits centred on the row). */
export function slotRect(slot: Slot, type: BlockType): Rect {
  const { w, h } = SIZE[type];
  return { x: PAD + slot.col * COL_W, y: PAD + slot.row * ROW_H + Math.round((SIZE.main.h - h) / 2), w, h };
}

/** Where a block is now: where the person put it, else its slot. */
export function rectOf(layout: Layout, id: string, type: BlockType, moved: Readonly<Record<string, Point>>): Rect | undefined {
  const at = moved[id];
  const slot = layout.slots[id];
  if (at !== undefined) return { x: at.x, y: at.y, ...SIZE[type] };
  return slot === undefined ? undefined : slotRect(slot, type);
}

export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/** `prev` with a slot for every block in `blocks` that has none. Existing slots are copied as they are. `types` gives
 *  the type of a block placed earlier that `blocks` no longer lists (still reserved). */
export function place(prev: Layout, blocks: readonly LayoutBlock[], moved: Readonly<Record<string, Point>> = {}, types: ReadonlyMap<string, BlockType> = new Map()): Layout {
  const fresh = blocks.filter((b) => prev.slots[b.id] === undefined);
  if (fresh.length === 0) return prev;
  const slots: Record<string, Slot> = { ...prev.slots };
  let group = prev.group;
  const typeOf = new Map(types);
  for (const b of blocks) typeOf.set(b.id, b.type);
  const taken = new Set(Object.values(slots).map((s) => `${s.col}:${s.row}`));
  const rects: Rect[] = [];
  for (const id of Object.keys(slots)) {
    const r = rectOf({ slots, group }, id, typeOf.get(id) ?? "main", moved);
    if (r !== undefined) rects.push(r);
  }
  for (const [id, at] of Object.entries(moved)) if (slots[id] === undefined && typeOf.has(id)) rects.push({ ...at, ...SIZE[typeOf.get(id)!] });

  const free = (slot: Slot, type: BlockType) => {
    if (taken.has(`${slot.col}:${slot.row}`)) return false;
    const r = slotRect(slot, type);
    return !rects.some((o) => overlaps(r, o, GAP));
  };
  const give = (id: string, slot: Slot, type: BlockType) => {
    slots[id] = slot;
    taken.add(`${slot.col}:${slot.row}`);
    rects.push(slotRect(slot, type));
  };
  const firstFree = (col: number, row: number, type: BlockType): Slot => {
    let r = row;
    while (!free({ col, row: r }, type)) r++;
    return { col, row: r };
  };
  const bandRow = (g: number) => {
    let bottom = -1;
    for (const s of Object.values(slots)) if (s.col >= g * GROUP_COLS && s.col < (g + 1) * GROUP_COLS) bottom = Math.max(bottom, s.row);
    return bottom + 1;
  };

  // Parents before their children; otherwise oldest first. A parent not on the canvas makes a block a root.
  const ids = new Set(blocks.map((b) => b.id));
  const pending = [...fresh].sort((x, y) => x.startedAt - y.startedAt || x.id.localeCompare(y.id));
  while (pending.length > 0) {
    const i = pending.findIndex((b) => b.parent === undefined || !ids.has(b.parent) || slots[b.parent] !== undefined);
    // A cycle (a parent waiting on its own child) can't come from the engine; break it by placing the oldest as a root.
    const b = pending.splice(i < 0 ? 0 : i, 1)[0]!;
    const parentSlot = b.parent !== undefined && i >= 0 ? slots[b.parent] : undefined;
    if (parentSlot !== undefined) {
      give(b.id, firstFree(parentSlot.col + 1, parentSlot.row, b.type), b.type);
      continue;
    }
    let row = bandRow(group);
    if (row >= GROUP_ROWS) {
      group += 1;
      row = bandRow(group);
    }
    give(b.id, firstFree(group * GROUP_COLS, row, b.type), b.type);
  }
  return { slots, group };
}

/** The box around `rects`, for the fit control and the world's size. */
export function bounds(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.w));
  const bottom = Math.max(...rects.map((r) => r.y + r.h));
  return { x, y, w: right - x, h: bottom - y };
}
