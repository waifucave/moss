// The waifucave push notifier: one push per burst, only a count, retries for passing failures, and the count
// kept in the synced store.

import { describe, expect, test } from "bun:test";

import { PushNotifier, type Clock } from "../src/notifier";

class FakeClock implements Clock {
  t = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private id = 0;
  now() {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number) {
    this.id += 1;
    this.timers.set(this.id, { at: this.t + ms, fn });
    return this.id;
  }
  clearTimeout(handle: unknown) {
    this.timers.delete(handle as number);
  }
  async advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      let due: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of this.timers) if (entry[1].at <= target && (!due || entry[1].at < due[1].at)) due = entry;
      if (!due) break;
      this.timers.delete(due[0]);
      this.t = due[1].at;
      due[1].fn();
      await settle();
    }
    this.t = target;
    await settle();
  }
}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Response statuses in order; 0 is a network error, -1 a request that never answers, -2 "no account". */
function setup(responses: number[] = [], stored?: number) {
  const clock = new FakeClock();
  const requests: { url: string; body: string; method: string }[] = [];
  const logs: string[] = [];
  let saved = stored;
  const notifier = new PushNotifier({
    origin: "https://push.test",
    fetch: async (url, init = {}) => {
      requests.push({ url, body: String(init.body), method: init.method ?? "GET" });
      const status = responses.shift() ?? 200;
      if (status === 0) throw new Error("network down");
      if (status === -2) throw Object.assign(new Error("no waifucave account is signed in"), { code: "no_account" });
      if (status === -1) {
        return new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")));
        });
      }
      return new Response(status === 200 ? '{"sent":1,"removed":0,"failed":0}' : "{}", { status });
    },
    store: { get: async () => saved, set: async (n) => void (saved = n) },
    clock,
    log: (level, message) => logs.push(`${level}: ${message}`),
    requestTimeoutMs: 30,
  });
  return { clock, requests, notifier, logs, saved: () => saved };
}

describe("waifucave push notifier", () => {
  test("a burst of notifications becomes one push of the count, after a short wait", async () => {
    const t = setup();
    await t.notifier.notify({ title: "Alpha", body: "the secret plan" });
    await t.notifier.notify({ title: "Alpha", body: "more" });
    await t.notifier.notify({ kind: "approval" });
    expect(t.requests).toHaveLength(0);
    await t.clock.advance(2_000);
    expect(t.requests).toEqual([{ url: "https://push.test/v1/notify", method: "POST", body: '{"badge":3}' }]);
  });

  test("sends nothing but the count", async () => {
    const t = setup();
    await t.notifier.notify({ title: "Alpha replied", body: "deploy the thing", bot: "alpha", session: "s1" });
    await t.clock.advance(2_000);
    expect(JSON.parse(t.requests[0]!.body)).toEqual({ badge: 1 });
  });

  test("takes the core's own count when it has one", async () => {
    const t = setup();
    await t.notifier.notify({ unseen: 7 });
    await t.clock.advance(2_000);
    expect(t.requests.map((r) => r.body)).toEqual(['{"badge":7}']);
  });

  test("clearing sends a zero promptly; an unchanged count is not sent again", async () => {
    const t = setup();
    await t.notifier.notify();
    await t.clock.advance(2_000);
    await t.notifier.clear();
    await t.clock.advance(0);
    await t.notifier.clear();
    await t.clock.advance(5_000);
    expect(t.requests.map((r) => r.body)).toEqual(['{"badge":1}', '{"badge":0}']);
  });

  test("retries a passing failure with backoff, then gives up until the next notification", async () => {
    const t = setup([503, 0, 429, 503, 503]);
    await t.notifier.notify();
    await t.clock.advance(2_000); // 503
    await t.clock.advance(5_000); // network error
    await t.clock.advance(10_000); // 429
    await t.clock.advance(20_000); // 503
    await t.clock.advance(40_000); // 503: the fifth try
    expect(t.requests).toHaveLength(5);
    await t.clock.advance(600_000);
    expect(t.requests).toHaveLength(5);
    expect(t.logs.some((l) => l.includes("gave up"))).toBe(true);
    await t.notifier.notify();
    await t.clock.advance(2_000);
    expect(t.requests.at(-1)!.body).toBe('{"badge":2}');
  });

  test("does not retry a refusal", async () => {
    const t = setup([401]);
    await t.notifier.notify();
    await t.clock.advance(300_000);
    expect(t.requests).toHaveLength(1);
    expect(t.logs.some((l) => l.startsWith("error"))).toBe(true);
  });

  test("keeps the count in the store across restarts", async () => {
    const first = setup([], 4);
    await first.notifier.notify();
    expect(first.saved()).toBe(5);
    const again = setup([], first.saved());
    await again.notifier.notify();
    await again.clock.advance(2_000);
    expect(again.requests[0]!.body).toBe('{"badge":6}');
  });

  test("abandons a push that never answers, and is not stuck: the retry goes out", async () => {
    const t = setup([-1]);
    await t.notifier.notify();
    await t.clock.advance(2_000);
    await new Promise((r) => setTimeout(r, 80)); // the request's own timeout runs on real time
    await t.clock.advance(5_000);
    expect(t.requests.map((r) => r.body)).toEqual(['{"badge":1}', '{"badge":1}']);
  });

  test("with no account signed in it neither sends nor retries, and says so once", async () => {
    const t = setup([-2, -2]);
    await t.notifier.notify();
    await t.clock.advance(2_000);
    await t.clock.advance(600_000);
    expect(t.requests).toHaveLength(1);
    await t.notifier.notify();
    await t.clock.advance(2_000);
    expect(t.requests).toHaveLength(2);
    expect(t.logs.filter((l) => l.includes("no waifucave account"))).toHaveLength(1);
    expect(t.saved()).toBe(2);
    await t.notifier.notify();
    await t.clock.advance(2_000);
    expect(t.requests.at(-1)!.body).toBe('{"badge":3}');
  });

  test("stop cancels a pending push", async () => {
    const t = setup();
    await t.notifier.notify();
    t.notifier.stop();
    await t.clock.advance(10_000);
    expect(t.requests).toHaveLength(0);
  });
});

// Which phones a push is for: the core names them with each update (`phones`), and the notifier asks the service to prefer
// them, never to wake only them. A burst for different phones is one push to all of them.
const MOSS_PHONE = "m".repeat(20);
const CODE_PHONE = "c".repeat(20);
const OLD_PHONE = "o".repeat(20);
type Sent = { badge: number; phones?: string[] };

function routed(o: { statuses?: (index: number) => number } = {}) {
  const clock = new FakeClock();
  const requests: Sent[] = [];
  let held: Promise<void> | null = null;
  let release: (() => void) | undefined;
  const notifier = new PushNotifier({
    origin: "https://push.test",
    fetch: async (_url, init = {}) => {
      const index = requests.length;
      requests.push(JSON.parse(String(init.body)) as Sent);
      if (held) await held;
      const status = o.statuses?.(index) ?? 200;
      return new Response("{}", { status });
    },
    clock, debounceMs: 2_000, retryMinMs: 5_000, retryMaxMs: 120_000, maxAttempts: 5, requestTimeoutMs: 600_000,
  });
  return {
    clock, requests, notifier,
    hold() { held = new Promise<void>((r) => (release = r)); },
    open() { release?.(); held = null; },
  };
}

describe("waifucave push notifier: which phones", () => {
  test("an update for the MOSS phones asks the service to prefer them; the body holds ids and the count, nothing else", async () => {
    const t = routed();
    await t.notifier.notify({ title: "Luna", body: "your build failed: sk-live-1", bot: "luna", phones: [MOSS_PHONE] });
    await t.clock.advance(2_000);
    expect(t.requests).toEqual([{ badge: 1, phones: [MOSS_PHONE] }]);
  });

  test("an update that names no phones, or an empty list, is for every phone: the body has none", async () => {
    for (const phones of [undefined, [], "x", [7], ["short"], null] as const) {
      const t = routed();
      await t.notifier.notify({ phones: phones as never });
      await t.clock.advance(2_000);
      expect(t.requests).toEqual([{ badge: 1 }]);
    }
  });

  test("a burst for MOSS and for MOSS Code is one push, to both", async () => {
    const t = routed();
    await t.notifier.notify({ phones: [MOSS_PHONE] });
    await t.notifier.notify({ phones: [CODE_PHONE] });
    await t.clock.advance(2_000);
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]!.badge).toBe(2);
    expect([...t.requests[0]!.phones!].sort()).toEqual([CODE_PHONE, MOSS_PHONE]);
  });

  test("an update for every phone in a burst makes the push one for every phone", async () => {
    const t = routed();
    await t.notifier.notify({ phones: [MOSS_PHONE] });
    await t.notifier.notify({});
    await t.clock.advance(2_000);
    expect(t.requests).toEqual([{ badge: 2 }]);
  });

  test("the same count is sent again when it is for phones the last push wasn't", async () => {
    const t = routed();
    await t.notifier.notify({ unseen: 1, phones: [MOSS_PHONE] });
    await t.clock.advance(2_000);
    await t.notifier.notify({ unseen: 1, phones: [CODE_PHONE] });
    await t.clock.advance(2_000);
    // The same count for phones it already reached is not.
    await t.notifier.notify({ unseen: 1, phones: [CODE_PHONE] });
    await t.clock.advance(2_000);
    expect(t.requests).toEqual([{ badge: 1, phones: [MOSS_PHONE] }, { badge: 1, phones: [CODE_PHONE] }]);
    // A push to every phone covers any later one for some, at the same count.
    await t.notifier.notify({ unseen: 1 });
    await t.clock.advance(2_000);
    await t.notifier.notify({ unseen: 1, phones: [OLD_PHONE] });
    await t.clock.advance(2_000);
    expect(t.requests).toEqual([{ badge: 1, phones: [MOSS_PHONE] }, { badge: 1, phones: [CODE_PHONE] }, { badge: 1 }]);
  });

  test("an update that comes while a push is out is sent after it, for its own phones", async () => {
    const t = routed();
    await t.notifier.notify({ phones: [MOSS_PHONE] });
    t.hold();
    await t.clock.advance(2_000);
    expect(t.requests).toEqual([{ badge: 1, phones: [MOSS_PHONE] }]);
    await t.notifier.notify({ phones: [CODE_PHONE] });
    t.open();
    await t.clock.advance(0);
    await t.clock.advance(2_000);
    expect(t.requests).toEqual([{ badge: 1, phones: [MOSS_PHONE] }, { badge: 2, phones: [CODE_PHONE] }]);
  });

  test("a push that failed for a passing reason is retried for the same phones, and with those that came meanwhile", async () => {
    const t = routed({ statuses: (i) => (i === 0 ? 503 : 200) });
    await t.notifier.notify({ phones: [MOSS_PHONE] });
    await t.clock.advance(2_000);
    await t.notifier.notify({ phones: [CODE_PHONE] });
    await t.clock.advance(5_000);
    expect(t.requests).toHaveLength(2);
    expect(t.requests[1]!.badge).toBe(2);
    expect([...t.requests[1]!.phones!].sort()).toEqual([CODE_PHONE, MOSS_PHONE]);
  });

  test("clearing goes to every phone", async () => {
    const t = routed();
    await t.notifier.notify({ phones: [MOSS_PHONE] });
    await t.clock.advance(2_000);
    await t.notifier.clear();
    await t.clock.advance(0);
    expect(t.requests).toEqual([{ badge: 1, phones: [MOSS_PHONE] }, { badge: 0 }]);
  });
});

// Generated sequences (a seeded generator, so a failure names its seed): updates for one phone, the other and every phone,
// waiting, an in-flight push and passing failures in any order. Each update's phones are in a push that went out after it
// came (a push already out when it came doesn't count) or in a push to every phone, once the last one is let through.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe("waifucave push notifier: generated sequences", () => {
  const audiences: (string[] | undefined)[] = [[MOSS_PHONE], [CODE_PHONE], [OLD_PHONE], [MOSS_PHONE, CODE_PHONE], undefined];
  for (let seed = 1; seed <= 80; seed++) {
    test(`every update's phones are woken after it came (seed ${seed})`, async () => {
      const next = rng(seed);
      // Failures are passing and short, so the retries (five tries) always get through in the time given.
      const failures = new Set<number>();
      for (let i = 0; i < 12; i++) if (next() < 0.25) failures.add(i * 3);
      const t = routed({ statuses: (i) => (failures.has(i) ? 503 : 200) });
      const came: { audience: string[] | undefined; after: number }[] = [];
      let held = false;
      const ops = 4 + Math.floor(next() * 12);
      for (let i = 0; i < ops; i++) {
        const r = next();
        if (r < 0.55) {
          const audience = audiences[Math.floor(next() * audiences.length)];
          came.push({ audience, after: t.requests.length });
          await t.notifier.notify({ bot: "luna", ...(audience ? { phones: audience } : {}) });
        } else if (r < 0.8) {
          await t.clock.advance(Math.floor(next() * 3_000));
        } else if (r < 0.9 && !held) {
          t.hold();
          held = true;
        } else if (held) {
          t.open();
          held = false;
        }
      }
      if (held) t.open();
      for (let i = 0; i < 4; i++) await t.clock.advance(60_000);
      const label = `seed ${seed}`;
      for (const [n, update] of came.entries()) {
        const covered = t.requests.slice(update.after).some((req) => req.phones === undefined || (update.audience !== undefined && update.audience.every((id) => req.phones!.includes(id))));
        // A push already out when the update came may be the one in flight: only pushes begun after it count.
        expect([label, n, JSON.stringify(update.audience), covered]).toEqual([label, n, JSON.stringify(update.audience), true]);
      }
    });
  }
});
