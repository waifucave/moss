import { describe, expect, test } from "bun:test";
import { PLACES_GAP_MS } from "../client/entry";
import { SEEN_GAP_MS } from "../client/source";
import { coalesced, RETRY_MS, type Timers } from "../client/writes";

/** A clock moved by hand: timers fire as it passes them. */
function clock(): Timers & { advance(ms: number): Promise<void> } {
  let now = 0;
  let queue: { at: number; fn: () => void; id: number }[] = [];
  let n = 0;
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return {
    now: () => now,
    after(ms, fn) {
      const id = ++n;
      queue.push({ at: now + ms, fn, id });
      return () => { queue = queue.filter((t) => t.id !== id); };
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await settle();
        const next = queue.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (next === undefined) break;
        queue = queue.filter((t) => t !== next);
        now = next.at;
        next.fn();
      }
      now = end;
      await settle();
    },
  };
}

describe("the canvas's setting writes, coalesced (one budget a minute is shared by every page of MOSS)", () => {
  test("thirty drags in a minute make a handful of writes, the last one the newest place", async () => {
    const c = clock();
    const written: string[] = [];
    const w = coalesced(async (v: string) => { written.push(v); }, PLACES_GAP_MS, c);
    for (let i = 1; i <= 30; i++) {
      w.put(`place ${i}`);
      await c.advance(2_000);
    }
    await c.advance(PLACES_GAP_MS);
    expect(written.length).toBeLessThanOrEqual(Math.ceil(60_000 / PLACES_GAP_MS) + 1);
    expect(written.length).toBeGreaterThan(1);
    expect(written.at(-1)).toBe("place 30");
    expect(w.waiting()).toBe(false);
  });

  test("the last place survives a close: what waits is written at once on flush", async () => {
    const c = clock();
    const written: string[] = [];
    const w = coalesced(async (v: string) => { written.push(v); }, PLACES_GAP_MS, c);
    w.put("a");
    await c.advance(100);
    w.put("b");
    w.put("c");
    expect(written).toEqual(["a"]);
    w.flush();
    await c.advance(0);
    expect(written).toEqual(["a", "c"]);
  });

  test("a refused write is kept and tried once more later, not dropped", async () => {
    const c = clock();
    const tries: number[] = [];
    let refuse = true;
    const w = coalesced(async (v: number) => {
      tries.push(v);
      if (refuse) throw new Error("moss's pages changed its settings 30 times this minute; try again in a moment");
    }, SEEN_GAP_MS, c);
    w.put(7);
    await c.advance(0);
    expect(tries).toEqual([7]);
    expect(w.waiting()).toBe(true);
    refuse = false;
    await c.advance(RETRY_MS);
    expect(tries).toEqual([7, 7]);
    expect(w.waiting()).toBe(false);
  });

  test("a newer value replaces a refused one before its retry", async () => {
    const c = clock();
    const tries: number[] = [];
    let refuse = true;
    const w = coalesced(async (v: number) => { tries.push(v); if (refuse) throw new Error("refused"); }, SEEN_GAP_MS, c);
    w.put(1);
    await c.advance(0);
    w.put(2);
    refuse = false;
    await c.advance(RETRY_MS);
    expect(tries).toEqual([1, 2]);
  });

  test("seen is written at most once a minute while open", async () => {
    const c = clock();
    const written: number[] = [];
    const w = coalesced(async (v: number) => { written.push(v); }, SEEN_GAP_MS, c);
    for (let i = 0; i < 20; i++) {
      w.put(c.now());
      await c.advance(3_000);
    }
    expect(written.length).toBeLessThanOrEqual(2);
  });
});
