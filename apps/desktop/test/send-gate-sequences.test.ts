// Generated sequences over MOSS Code's SendGate (seeded): the stall watch changes nothing when every tick is on time, and with random
// stalls no gestured call is taken without a press that landed in its own frame, once per press, within the bound plus the cap.
import { describe, expect, test } from "bun:test";
import { StallWatch, STALL_CREDIT_MAX_MS, STALL_TICK_MS } from "@waifucave/moss-app-release/stall-watch";
import { PRESS_REPORT_MS, SEND_INPUT_WINDOW_MS, SendGate } from "../src/main/ui/brokers";

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const FRAMES = ["10:1", "10:2", "11:1"] as const;
const WINDOWS = [1, 2] as const;

function world() {
  const c = { now: 4_000_000, cpu: 0, sw: 0, tick: undefined as (() => void) | undefined };
  const watch = new StallWatch({ now: () => c.now, cpu: () => c.cpu, switches: () => c.sw, setTimer: (fn) => { c.tick = fn; return 1; }, clearTimer: () => { c.tick = undefined; } });
  const pass = (ms: number, cpu: number, tick: boolean, sw = 5): void => { c.now += ms; c.cpu += cpu; c.sw += sw; if (tick) c.tick?.(); };
  return { c, watch, pass };
}

describe("generated send-gate sequences", () => {
  test("with every tick on time, a gate with the watch answers every call as a gate without it does", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const w = world();
      const a = new SendGate(() => w.c.now, w.watch);
      const b = new SendGate(() => w.c.now);
      for (let step = 0; step < 60; step++) {
        const win = WINDOWS[Math.floor(r() * WINDOWS.length)]!;
        const frame = FRAMES[Math.floor(r() * FRAMES.length)]!;
        const op = Math.floor(r() * 7);
        const where = `seed ${seed} step ${step}`;
        if (op === 0) { a.press(win, { kind: "mouse", key: "left" }); b.press(win, { kind: "mouse", key: "left" }); }
        else if (op === 1) expect([where, a.seen(win, [frame])]).toEqual([where, b.seen(win, [frame])]);
        else if (op === 2) { a.press(win, { kind: "key", key: "a", frames: [frame] }); b.press(win, { kind: "key", key: "a", frames: [frame] }); }
        else if (op === 3) expect([where, a.takeIn(win, frame)]).toEqual([where, b.takeIn(win, frame)]);
        else if (op === 4) expect([where, a.take(win)]).toEqual([where, b.take(win)]);
        else { let left = Math.floor(r() * 2_200); while (left > 0) { const d = Math.min(left, STALL_TICK_MS); w.pass(d, Math.floor(d / 10), true); left -= d; } }
      }
    }
  });

  test("with random stalls: a call is taken only for a press that landed in its own frame, once, within the bound plus the cap", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed * 104729);
      const w = world();
      const g = new SendGate(() => w.c.now, w.watch);
      const latest = new Map<number, { at: number; frame?: string; seenAt?: number; spent: boolean }>();
      let presses = 0;
      let taken = 0;
      for (let step = 0; step < 60; step++) {
        const win = WINDOWS[Math.floor(r() * WINDOWS.length)]!;
        const frame = FRAMES[Math.floor(r() * FRAMES.length)]!;
        const op = Math.floor(r() * 6);
        const where = `seed ${seed} step ${step}`;
        if (op === 0) { g.press(win, { kind: "mouse", key: "left" }); latest.set(win, { at: w.c.now, spent: false }); presses++; }
        else if (op === 1) {
          if (g.seen(win, [frame])) {
            const p = latest.get(win);
            expect([where, p !== undefined && p.frame === undefined]).toEqual([where, true]); // first report only, on the latest press
            p!.frame = frame;
            p!.seenAt = w.c.now;
          }
        } else if (op === 2 || op === 3) {
          if (g.takeIn(win, frame)) {
            taken++;
            const p = latest.get(win);
            expect([where, p !== undefined && !p.spent, p?.frame]).toEqual([where, true, frame]);
            expect(w.c.now - p!.at).toBeLessThanOrEqual(SEND_INPUT_WINDOW_MS + STALL_CREDIT_MAX_MS);
            expect(p!.seenAt! - p!.at).toBeLessThanOrEqual(PRESS_REPORT_MS + STALL_CREDIT_MAX_MS);
            p!.spent = true;
          }
        } else {
          const kind = r();
          if (kind < 0.4) { let left = Math.floor(r() * 2_000); while (left > 0) { const d = Math.min(left, STALL_TICK_MS); w.pass(d, Math.floor(d / 10), true); left -= d; } }
          else { const ms = Math.floor(r() * 30_000); w.pass(STALL_TICK_MS + ms, kind < 0.8 ? Math.floor(r() * 50) : ms, r() < 0.5); }
        }
        expect([where, taken <= presses]).toEqual([where, true]);
      }
    }
  });

  test("settle's wait is not measured across a stall: a report queued behind the late timer is still waited for", async () => {
    const w = world();
    const g = new SendGate(() => w.c.now, w.watch);
    g.press(1, { kind: "mouse", key: "left" });
    let done = false;
    const waited = g.settle(1, 300).then(() => { done = true; });
    w.pass(STALL_TICK_MS + 4_000, 10, false); // the process was not running; the timer fires late, the report right behind it
    await new Promise((res) => setTimeout(res, 350)); // past the first timer, before the second
    expect(done).toBe(false);
    expect(g.seen(1, ["10:1"])).toBe(true);
    await waited;
    expect(done).toBe(true);
    // No stall: the wait ends at its timer, with no report.
    const calm = world();
    const h = new SendGate(() => calm.c.now, calm.watch);
    h.press(1, { kind: "mouse", key: "left" });
    const t0 = Date.now();
    await h.settle(1, 300);
    expect(Date.now() - t0).toBeLessThan(550);
  });
});
