// Generated sequences over MOSS's press record (seeded, so a failure replays from its seed and step): what the stall watch must never
// change when the machine kept up, and what it must never allow when it did not.
//   1. With every tick on time, a record WITH the watch answers every write exactly as the strict `take` answers it on a twin
//      record fed the same events (the bounds did not widen).
//   2. With random stalls (the OS leaving the process waiting, or the process busy), random tick order, random frames:
//      no accepted write without a press of that frame in that window; one write per press; the accepted write's press is never
//      older than PRESS_MS + the cap, nor its report later than REPORT_MS + the cap; the strict `take` never takes more than its
//      own bounds.
import { describe, expect, test } from "bun:test";
import { StallWatch, STALL_CREDIT_MAX_MS, STALL_TICK_MS } from "@waifucave/moss-app-release/stall-watch";
import { PRESS_MS, PressRecord, REPORT_MS } from "../src/main/press";

/** A small seeded generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const FRAMES = ["11:1", "11:2", "12:1"] as const;
const WINDOWS = [7, 8] as const;

function world() {
  const c = { now: 3_000_000, cpu: 0, tick: undefined as (() => void) | undefined };
  const watch = new StallWatch({ now: () => c.now, cpu: () => c.cpu, setTimer: (fn) => { c.tick = fn; return 1; }, clearTimer: () => { c.tick = undefined; } });
  const pass = (ms: number, cpu: number, tick: boolean): void => { c.now += ms; c.cpu += cpu; if (tick) c.tick?.(); };
  return { c, watch, pass };
}

describe("generated press sequences", () => {
  test("with every tick on time, the watch changes nothing: every write answers as the strict take does", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const w = world();
      const withWatch = new PressRecord(() => w.c.now, w.watch);
      const strict = new PressRecord(() => w.c.now);
      for (let step = 0; step < 60; step++) {
        const win = WINDOWS[Math.floor(r() * WINDOWS.length)]!;
        const frame = FRAMES[Math.floor(r() * FRAMES.length)]!;
        const op = Math.floor(r() * 7);
        const where = `seed ${seed} step ${step}`;
        if (op === 0) { withWatch.mouseDown(win); strict.mouseDown(win); }
        else if (op === 1) { withWatch.frameSaw(win, frame); strict.frameSaw(win, frame); }
        else if (op === 2) { withWatch.keyDown(win, frame); strict.keyDown(win, frame); }
        else if (op === 3 || op === 4) {
          const got = withWatch.takeWrite(win, frame);
          const want = strict.take(win, frame);
          expect([where, got.ok, got.ok ? got.how : undefined]).toEqual([where, want !== undefined, want]);
        } else {
          // Time passes, the timer beating on time (a gap of any length, in beats).
          let left = Math.floor(r() * 2_200);
          while (left > 0) { const d = Math.min(left, STALL_TICK_MS); w.pass(d, Math.floor(d / 10), true); left -= d; }
        }
      }
    }
  });

  test("with random stalls, busy lags and late ticks: no write without its own press, one write per press, ages within bound plus the cap", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed * 7919);
      const w = world();
      const rec = new PressRecord(() => w.c.now, w.watch);
      // The model: per window, the latest mouse down and the latest key down, with what was reported for them.
      const downs = new Map<number, { at: number; report?: { frame: string; at: number }; spent: boolean }>();
      const keys = new Map<number, { at: number; frame: string; spent: boolean }>();
      let presses = 0;
      let writes = 0;
      for (let step = 0; step < 60; step++) {
        const win = WINDOWS[Math.floor(r() * WINDOWS.length)]!;
        const frame = FRAMES[Math.floor(r() * FRAMES.length)]!;
        const op = Math.floor(r() * 8);
        const where = `seed ${seed} step ${step}`;
        if (op === 0) { rec.mouseDown(win); downs.set(win, { at: w.c.now, spent: false }); presses++; }
        else if (op === 1) {
          rec.frameSaw(win, frame);
          const d = downs.get(win);
          if (d !== undefined && d.report === undefined) d.report = { frame, at: w.c.now };
        } else if (op === 2) { rec.keyDown(win, frame); keys.set(win, { at: w.c.now, frame, spent: false }); presses++; }
        else if (op === 3 || op === 4) {
          const got = rec.takeWrite(win, frame);
          if (got.ok) {
            writes++;
            const d = downs.get(win);
            const k = keys.get(win);
            if (got.how === "click") {
              expect([where, d !== undefined && !d.spent]).toEqual([where, true]);
              expect([where, d!.report?.frame]).toEqual([where, frame]); // the press the page's own report named, in that frame only
              expect(w.c.now - d!.at).toBeLessThanOrEqual(PRESS_MS + STALL_CREDIT_MAX_MS);
              expect(d!.report!.at - d!.at).toBeLessThanOrEqual(REPORT_MS + STALL_CREDIT_MAX_MS);
              d!.spent = true;
            } else {
              expect([where, k !== undefined && !k.spent, k?.frame]).toEqual([where, true, frame]);
              expect(w.c.now - k!.at).toBeLessThanOrEqual(PRESS_MS + STALL_CREDIT_MAX_MS);
              k!.spent = true;
            }
          }
        } else if (op === 5) {
          // The strict take (sealed buttons) never takes beyond its own bounds, whatever the stalls.
          const how = rec.take(win, frame);
          if (how === "click") {
            const d = downs.get(win)!;
            expect([where, d.report?.frame, w.c.now - d.at <= PRESS_MS, d.report!.at - d.at <= REPORT_MS]).toEqual([where, frame, true, true]);
            d.spent = true;
          } else if (how === "key") {
            const k = keys.get(win)!;
            expect([where, k.frame, w.c.now - k.at <= PRESS_MS]).toEqual([where, frame, true]);
            k.spent = true;
          }
        } else {
          // Time passes: calm beats, or a stall (waited or worked), the late tick sometimes before the next event and sometimes after.
          const kind = r();
          if (kind < 0.4) { let left = Math.floor(r() * 2_000); while (left > 0) { const d = Math.min(left, STALL_TICK_MS); w.pass(d, Math.floor(d / 10), true); left -= d; } }
          else { const ms = Math.floor(r() * 30_000); w.pass(STALL_TICK_MS + ms, kind < 0.8 ? Math.floor(r() * 50) : ms, r() < 0.5); }
        }
        expect([where, writes <= presses]).toEqual([where, true]); // never more writes than presses
      }
    }
  });
});
