// The moss/push plugin's host half itself (plugins/moss/plugins/push/host/index.ts), started on the plugin API's own
// members, against the real push Worker inside workerd with APNs and Web Push faked. What the engine hands it is built
// the engine's way: the phones from `phonesToWake` (packages/protocol push-routing.ts), a revoked phone among them.
//
// It proves, for a card waiting on the user:
//   * the push reaches the phone of the right app (MOSS for a bot's card), and only it among the phones;
//   * it carries the count alone: nothing of the card, the bot or the session reaches APNs or Web Push;
//   * a phone the user revoked gets nothing afterwards, not from a push that names it, nor from one that names no phone
//     (the badge clearing, a plugin's notice), and can't register again.

import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";

import { phonesToWake, type PairedPhone } from "../../../packages/protocol/src/push-routing";
import { notifier, start, stop } from "../../../plugins/moss/plugins/push/host/index";
import type { HostApi } from "../../../plugins/moss/plugins/push/host/api";
import { apnsPayload } from "../src/apns";
import { CODE_TOKEN_PREFIX, type FakeLogEntry } from "./fake-log";
import { accountToken, apnsToken, call, fakeLog, ORIGIN, subscriptions, uniqueAccount } from "./helpers";

const MOSS_PHONE = "moss0phone0host01";
const CODE_PHONE = "code0phone0host02";
const LOST_PHONE = "lost0phone0host03";
const BROWSER = "web00browser0host4";
const COMPUTER = "main0computer0hst";

interface Device {
  id: string;
  runsCore: boolean;
  isThis: boolean;
}

/** What `devices.list` gives the plugin: the unrevoked devices, this computer among them. */
function listOf(registry: (PairedPhone & { kind: "phone" | "browser" })[]): Device[] {
  return [
    { id: COMPUTER, runsCore: true, isThis: true },
    ...registry.filter((d) => d.revokedAt === undefined).map((d) => ({ id: d.id, runsCore: false, isThis: false })),
  ];
}

async function until(read: () => Promise<FakeLogEntry[]>, done: (entries: FakeLogEntry[]) => boolean, ms = 8_000): Promise<FakeLogEntry[]> {
  const end = Date.now() + ms;
  for (;;) {
    const entries = await read();
    if (done(entries) || Date.now() > end) return entries;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("the push plugin's host half, against the Worker", () => {
  afterEach(() => stop());

  it("a waiting card wakes the right app's phone with the count alone; a revoked phone gets nothing after, and can't come back", async () => {
    const account = uniqueAccount();
    const tokens = {
      moss: apnsToken(),
      code: apnsToken(CODE_TOKEN_PREFIX),
      lost: apnsToken(),
    };
    const phoneToken = async (id: string) => accountToken({ account, device: id });
    expect((await call(await phoneToken(MOSS_PHONE), "PUT", "/v1/targets/self", { kind: "apns", app: "moss", token: tokens.moss, env: "production" })).status).toBe(204);
    expect((await call(await phoneToken(CODE_PHONE), "PUT", "/v1/targets/self", { kind: "apns", app: "code", token: tokens.code, env: "production" })).status).toBe(204);
    expect((await call(await phoneToken(LOST_PHONE), "PUT", "/v1/targets/self", { kind: "apns", app: "moss", token: tokens.lost, env: "production" })).status).toBe(204);
    expect((await call(await phoneToken(BROWSER), "PUT", "/v1/targets/self", { kind: "webpush", ...subscriptions.fcm })).status).toBe(204);

    // The engine's registry: two MOSS phones (one about to be lost), a MOSS Code phone, a browser.
    const registry: (PairedPhone & { kind: "phone" | "browser" })[] = [
      { id: MOSS_PHONE, app: "moss", kind: "phone" },
      { id: CODE_PHONE, app: "code", kind: "phone" },
      { id: LOST_PHONE, app: "moss", kind: "phone" },
      { id: BROWSER, kind: "browser" },
    ];
    const watchers: (() => void)[] = [];
    const computerToken = await accountToken({ account, device: COMPUTER });
    const requests: string[] = [];
    const synced = new Map<string, unknown>();
    const api = {
      plugin: { id: "moss/push", namespace: "moss", version: "0.0.0", computer: "main" },
      settings: { get: async (key: string) => (key === "origin" ? ORIGIN : undefined) },
      storage: { synced: { get: async (k: string) => synced.get(k), set: async (k: string, v: unknown) => void synced.set(k, v) } },
      devices: {
        list: async () => listOf(registry),
        revoked: async () => registry.flatMap((d) => (d.revokedAt === undefined ? [] : [{ id: d.id, revokedAt: d.revokedAt }])),
        watch: (fn: () => void) => (watchers.push(fn), () => {}),
      },
      // The core's keyed fetch: the computer's account token, added by the core, never seen by the plugin.
      net: {
        fetch: (url: string, init: RequestInit = {}, opts?: { auth?: string }) => {
          expect(opts?.auth).toBe("waifucave");
          requests.push(`${init.method ?? "GET"} ${new URL(url).pathname}`);
          const headers = new Headers(init.headers);
          headers.set("authorization", `Bearer ${computerToken}`);
          return exports.default.fetch(new Request(url, { ...init, headers }));
        },
      },
    } as unknown as HostApi;
    await start(api);
    // Its first look at the devices is done once it has noted them.
    for (let i = 0; i < 100 && !synced.has("devices:main"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(synced.get("devices:main")).toEqual({ known: [MOSS_PHONE, CODE_PHONE, LOST_PHONE, BROWSER], pending: [] });

    // The user revokes the lost phone: the engine's registry marks it, and the device list changes.
    registry.find((d) => d.id === LOST_PHONE)!.revokedAt = Date.now();
    for (const w of watchers) w();

    // A card from the bot Alpha now waits: the engine's update, with the phones it picks, and words the plugin must drop.
    const before = (await fakeLog()).length;
    const phones = phonesToWake({ bot: "alpha" }, registry.filter((d) => d.kind === "phone"));
    expect(phones).toEqual([MOSS_PHONE]);
    await notifier.notify({
      seq: 1, kind: "card", unseen: 1, at: Date.now(), bot: "alpha", session: "sess-secret-1", phones,
      sender: { pluginId: "moss", name: "MOSS", bundled: true },
      title: "Alpha asks: Allow rm -rf ~/Documents?", body: "token sk-live-123",
    });
    const first = (await until(fakeLog, (e) => e.slice(before).some((x) => x.service === "apns") && e.slice(before).some((x) => x.service === "webpush"))).slice(before);
    // The revocation reached the service before the push went out.
    expect(requests.slice(0, 2)).toEqual([`DELETE /v1/devices/${LOST_PHONE}`, "POST /v1/notify"]);
    const apns = first.filter((e) => e.service === "apns");
    expect(apns.map((e) => [e.token, e.topic])).toEqual([[tokens.moss, env.APNS_TOPIC_MOSS]]);
    // The whole body is the service's fixed, localised "N updates" with the count: nothing else.
    expect(apns[0]!.payload).toEqual(apnsPayload(1));
    const web = first.filter((e) => e.service === "webpush");
    expect(web.map((e) => e.decrypted)).toEqual([{ n: 1 }]);
    const everything = JSON.stringify(first);
    for (const secret of ["alpha", "Alpha", "rm -rf", "Documents", "sk-live-123", "sess-secret-1"]) expect(everything).not.toContain(secret);

    // The user catches up: the badge goes to every phone, never the revoked one.
    const mid = (await fakeLog()).length;
    await notifier.clear();
    const second = (await until(fakeLog, (e) => e.slice(mid).filter((x) => x.service === "apns").length >= 2)).slice(mid);
    expect(second.filter((e) => e.service === "apns").map((e) => e.token).sort()).toEqual([tokens.code, tokens.moss].sort());
    expect(everythingAbout(second, tokens.lost)).toBe(false);

    // A plugin's notice names no phone: every phone the service holds, still never the revoked one.
    const late = (await fakeLog()).length;
    await notifier.notify({ seq: 2, kind: "notification", unseen: 3, at: Date.now(), sender: { pluginId: "x/y", name: "Y", bundled: false } });
    const third = (await until(fakeLog, (e) => e.slice(late).filter((x) => x.service === "apns").length >= 2)).slice(late);
    expect(everythingAbout(third, tokens.lost)).toBe(false);

    // The revoked phone can't put its target back.
    expect((await call(await phoneToken(LOST_PHONE), "PUT", "/v1/targets/self", { kind: "apns", app: "moss", token: tokens.lost, env: "production" })).status).toBe(403);
  });
});

function everythingAbout(entries: FakeLogEntry[], token: string): boolean {
  return entries.some((e) => e.token === token);
}
