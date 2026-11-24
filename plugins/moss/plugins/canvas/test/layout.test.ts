import { describe, expect, test } from "bun:test";
import { SAMPLE_SESSION_SCENE, sceneAt } from "@waifucave/moss-plugin-sdk/ui/testing";
import type { BlockType } from "../client/model";
import { buildModel } from "../client/model";
import { COL_W, EMPTY_LAYOUT, GROUP_COLS, GROUP_ROWS, overlaps, place, rectOf, slotRect, type Layout, type LayoutBlock, type Point } from "../client/layout";
import { BACKENDS } from "../gallery/fixtures";

/** A small seeded PRNG (mulberry32), so a failing sequence can be replayed by its seed. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the layout is stable", () => {
  test("generated sequences: adding, ending, subagents and drags never move a block already placed, and nothing new lands on another", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = prng(seed);
      let layout: Layout = EMPTY_LAYOUT;
      const blocks = new Map<string, LayoutBlock>();
      const ended = new Set<string>();
      const moved: Record<string, Point> = {};
      const types = new Map<string, BlockType>();
      let n = 0;
      for (let step = 0; step < 60; step++) {
        const r = rnd();
        const live = [...blocks.values()].filter((b) => !ended.has(b.id));
        if (r < 0.35 || live.length === 0) {
          const type: BlockType = rnd() < 0.15 ? "bot" : "main";
          const b = { id: `b${++n}`, type, startedAt: step };
          blocks.set(b.id, b);
          types.set(b.id, type);
        } else if (r < 0.7) {
          const parent = live[Math.floor(rnd() * live.length)]!;
          const type: BlockType = rnd() < 0.5 ? "sub" : "main";
          const b = { id: `b${++n}`, type, parent: parent.id, startedAt: step };
          blocks.set(b.id, b);
          types.set(b.id, type);
        } else if (r < 0.85) {
          ended.add(live[Math.floor(rnd() * live.length)]!.id);
        } else {
          const b = live[Math.floor(rnd() * live.length)]!;
          moved[b.id] = { x: Math.round(rnd() * 2_000), y: Math.round(rnd() * 1_500) };
        }
        // The canvas places what it shows: ended blocks fold away (their slots stay reserved).
        const before = layout;
        const shown = [...blocks.values()].filter((b) => !ended.has(b.id));
        layout = place(before, shown, moved, types);
        for (const [id, slot] of Object.entries(before.slots)) expect([seed, step, id, layout.slots[id]]).toEqual([seed, step, id, slot]);
        const fresh = Object.keys(layout.slots).filter((id) => before.slots[id] === undefined);
        const cells = Object.values(layout.slots).map((s) => `${s.col}:${s.row}`);
        expect([seed, step, new Set(cells).size]).toEqual([seed, step, cells.length]);
        for (const id of fresh) {
          const mine = slotRect(layout.slots[id]!, types.get(id)!);
          for (const other of Object.keys(layout.slots)) {
            if (other === id) continue;
            const theirs = rectOf(layout, other, types.get(other)!, moved)!;
            if (overlaps(mine, theirs)) throw new Error(`seed ${seed} step ${step}: ${id} was placed on ${other}`);
          }
        }
      }
    }
  });

  test("children go to their parent's right, at or below its row; a bot's sessions to the bot's right", () => {
    const looks = new Map(BACKENDS.map((b) => [b.id, b]));
    const model = buildModel(sceneAt(SAMPLE_SESSION_SCENE, 20_000).sessions, looks);
    const layout = place(EMPTY_LAYOUT, model.blocks);
    for (const b of model.blocks) {
      if (b.parent === undefined) continue;
      expect([b.id, layout.slots[b.id]!.col]).toEqual([b.id, layout.slots[b.parent]!.col + 1]);
      expect(layout.slots[b.id]!.row).toBeGreaterThanOrEqual(layout.slots[b.parent]!.row);
    }
  });

  test("the sample scene played as it happens: each block keeps the slot it got when it appeared", () => {
    const looks = new Map(BACKENDS.map((b) => [b.id, b]));
    let live = EMPTY_LAYOUT;
    const first: Record<string, unknown> = {};
    for (const step of SAMPLE_SESSION_SCENE) {
      live = place(live, buildModel(sceneAt(SAMPLE_SESSION_SCENE, step.at).sessions, looks).blocks);
      for (const [id, slot] of Object.entries(live.slots)) first[id] ??= slot;
    }
    expect(live.slots).toEqual(first as Layout["slots"]);
    expect(Object.keys(live.slots).length).toBe(6);
  });

  test("thirty sessions the person started wrap into groups side by side, not one column thirty tall", () => {
    const roots: LayoutBlock[] = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, type: "main", startedAt: i }));
    const layout = place(EMPTY_LAYOUT, roots);
    const rows = Object.values(layout.slots).map((s) => s.row);
    expect(Math.max(...rows)).toBe(GROUP_ROWS - 1);
    expect(new Set(Object.values(layout.slots).map((s) => s.col))).toEqual(new Set([0, 1, 2, 3].map((g) => g * GROUP_COLS)));
    expect(slotRect(layout.slots.r29!, "main").x).toBe(48 + 3 * GROUP_COLS * COL_W);
  });
});
