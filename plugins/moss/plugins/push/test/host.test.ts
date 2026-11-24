// The push plugin's host half on the plugin API's own members: a revoked phone or browser is removed from push before the
// next push (the service would otherwise wake it with every push that names no phone), only from a list that names this
// computer, only devices this computer saw, never a computer; a revocation the service didn't take is tried again; and the
// origin setting can only point at https or this computer's loopback.

import { afterEach, describe, expect, test } from "bun:test";

import { DEFAULT_ORIGIN, originFrom, start, stop } from "../host/index";
import type { HostApi } from "../host/api";
import { PushNotifier } from "../src/notifier";
import { RevocationSweep, type DeviceEntry } from "../src/revoked";

const PHONE = "phone0000000000aa";
const BROWSER = "browser00000000bb";
const OTHER_COMPUTER = "laptop000000000cc";
const SELF = { id: "desk00000000000dd", runsCore: true, isThis: true };

function memoryStore() {
  let value: unknown;
  return { get: async () => value, set: async (v: { known: string[]; pending: string[] }) => void (value = v), peek: () => value };
}

function sweepWith(lists: (readonly DeviceEntry[] | Error)[], answers: (boolean | Error)[] = []) {
  const store = memoryStore();
  const revoked: string[] = [];
  const sweep = new RevocationSweep({
    list: async () => {
      const next = lists.length > 1 ? lists.shift()! : lists[0]!;
      if (next instanceof Error) throw next;
      return next;
    },
    store,
    revoke: async (id) => {
      revoked.push(id);
      const a = answers.shift() ?? true;
      if (a instanceof Error) throw a;
      return a;
    },
  });
  return { sweep, revoked, store };
}

const phone = (id: string): DeviceEntry => ({ id, runsCore: false, isThis: false });

describe("the revocation sweep", () => {
  test("a phone or browser gone from the list is revoked at the service, once; a computer gone is not", async () => {
    const { sweep, revoked } = sweepWith([
      [SELF, phone(PHONE), phone(BROWSER), { id: OTHER_COMPUTER, runsCore: true, isThis: false }],
      [SELF, phone(BROWSER)],
    ]);
    await sweep.sweep();
    expect(revoked).toEqual([]);
    await sweep.sweep();
    expect(revoked).toEqual([PHONE]);
    await sweep.sweep();
    expect(revoked).toEqual([PHONE]);
  });

  test("a list that doesn't name this computer (the registry not up yet), or that fails, revokes nothing", async () => {
    const { sweep, revoked } = sweepWith([[SELF, phone(PHONE)], [], new Error("links not up"), [phone(BROWSER)], [SELF, phone(PHONE)]]);
    for (let i = 0; i < 5; i++) await sweep.sweep();
    expect(revoked).toEqual([]);
  });

  test("a phone this computer never saw is never revoked from here", async () => {
    const { sweep, revoked } = sweepWith([[SELF], [SELF]]);
    await sweep.sweep();
    await sweep.sweep();
    expect(revoked).toEqual([]);
  });

  test("a revocation the service didn't take is kept, in the synced store too, and tried again", async () => {
    const noAccount = Object.assign(new Error("no waifucave account is signed in"), { code: "no_account" });
    const { sweep, revoked, store } = sweepWith([[SELF, phone(PHONE)], [SELF]], [noAccount, false, true]);
    await sweep.sweep();
    await sweep.sweep();
    expect(revoked).toEqual([PHONE]);
    expect(store.peek()).toEqual({ known: [], pending: [PHONE] });
    await sweep.sweep();
    await sweep.sweep();
    expect(revoked).toEqual([PHONE, PHONE, PHONE]);
    expect(store.peek()).toEqual({ known: [], pending: [] });
  });

  test("ids from the store that aren't device ids are dropped, and at most 64 are kept", async () => {
    const store = memoryStore();
    await store.set({ known: ["../../v1/notify", 7 as unknown as string, PHONE], pending: ["a/b"] });
    const revoked: string[] = [];
    const sweep = new RevocationSweep({ list: async () => [SELF], store, revoke: async (id) => (revoked.push(id), true) });
    await sweep.sweep();
    expect(revoked).toEqual([PHONE]);
    const many = Array.from({ length: 100 }, (_, i) => phone(`p${String(i).padStart(15, "0")}`));
    const s2 = sweepWith([[SELF, ...many]]);
    await s2.sweep.sweep();
    expect((s2.store.peek() as { known: string[] }).known).toHaveLength(64);
  });
});

describe("the notifier sweeps before each push", () => {
  test("beforeSend runs before the push, and a failing one never stops it", async () => {
    const order: string[] = [];
    const n = new PushNotifier({
      origin: "https://push.test",
      fetch: async (url) => (order.push(`fetch ${new URL(url).pathname}`), new Response(null, { status: 200 })),
      beforeSend: async () => {
        order.push("sweep");
        throw new Error("boom");
      },
      debounceMs: 0,
    });
    await n.notify({ unseen: 1 });
    await n.flush();
    expect(order).toEqual(["sweep", "fetch /v1/notify"]);
    n.stop();
  });
});

describe("the host half", () => {
  afterEach(() => stop());

  function fakeApi(devices: () => readonly DeviceEntry[], settings: Record<string, unknown> = {}) {
    const requests: { url: string; method: string; auth: unknown }[] = [];
    const synced = new Map<string, unknown>();
    const watchers: (() => void)[] = [];
    const api = {
      plugin: { id: "moss/push", namespace: "moss", version: "0.0.0", computer: "desk" },
      settings: { get: async (k: string) => settings[k] },
      storage: { synced: { get: async (k: string) => synced.get(k), set: async (k: string, v: unknown) => void synced.set(k, v) } },
      devices: { list: async () => devices(), watch: (fn: () => void) => (watchers.push(fn), () => {}) },
      net: {
        fetch: async (url: string, init?: RequestInit, opts?: { auth?: string }) => {
          requests.push({ url, method: init?.method ?? "GET", auth: opts?.auth });
          return new Response(null, { status: 204 });
        },
      },
    } as unknown as HostApi;
    return { api, requests, watchers, synced };
  }

  async function settle() {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  }

  test("a revoked phone is removed from push through the keyed fetch, with the account token, as soon as the devices change", async () => {
    let list: readonly DeviceEntry[] = [SELF, phone(PHONE)];
    const { api, requests, watchers, synced } = fakeApi(() => list, { origin: "http://127.0.0.1:8787/x" });
    await start(api);
    await settle();
    expect(requests).toEqual([]);
    list = [SELF];
    for (const w of watchers) w();
    await settle();
    expect(requests).toEqual([{ url: `http://127.0.0.1:8787/v1/devices/${PHONE}`, method: "DELETE", auth: "waifucave" }]);
    // What it saw is kept per computer.
    expect(synced.get("devices:desk")).toEqual({ known: [], pending: [] });
  });

  test("the origin setting is an https origin or this computer's loopback; anything else is the default", () => {
    expect(originFrom(undefined)).toBe(DEFAULT_ORIGIN);
    expect(originFrom("")).toBe(DEFAULT_ORIGIN);
    expect(originFrom("https://push.example.test/a?b")).toBe("https://push.example.test");
    expect(originFrom("http://localhost:9000")).toBe("http://localhost:9000");
    expect(originFrom("http://push.example.test")).toBe(DEFAULT_ORIGIN);
    expect(originFrom("https://user:pw@push.example.test")).toBe(DEFAULT_ORIGIN);
    expect(originFrom("file:///etc/passwd")).toBe(DEFAULT_ORIGIN);
    expect(originFrom("not a url")).toBe(DEFAULT_ORIGIN);
    expect(originFrom(42)).toBe(DEFAULT_ORIGIN);
  });
});
