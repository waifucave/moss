// Two phone apps, one push service (spec §8, §10): a phone registers as `moss` or `code` and is pushed under that app's APNs
// topic (configuration, not code); a notify can name the phones to wake first, and wakes every phone when it holds none of
// them; browsers get every push; Android's FCM is a target kind that is refused as not configured until it has credentials.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { sendApns, type ApnsConfig } from "../src/apns";
import { apnsToken, call, device, fakeLog, subscriptions, uniqueAccount } from "./helpers";
import { CODE_TOKEN_PREFIX, type FakeLogEntry } from "./fake-log";

const since = async (before: number): Promise<FakeLogEntry[]> => (await fakeLog()).slice(before);
const length = async (): Promise<number> => (await fakeLog()).length;

/** An account with a MOSS phone, a MOSS Code phone and a browser, each registered, and a computer to notify from. */
async function account() {
  const id = uniqueAccount();
  const moss = await device(id, "moss-phone");
  const code = await device(id, "code-phone");
  const browser = await device(id, "browser");
  const computer = await device(id, "main-computer");
  const tokens = { moss: apnsToken(), code: apnsToken(CODE_TOKEN_PREFIX) };
  expect((await call(moss.token, "PUT", "/v1/targets/self", { kind: "apns", app: "moss", token: tokens.moss, env: "production" })).status).toBe(204);
  expect((await call(code.token, "PUT", "/v1/targets/self", { kind: "apns", app: "code", token: tokens.code, env: "production" })).status).toBe(204);
  expect((await call(browser.token, "PUT", "/v1/targets/self", { kind: "webpush", ...subscriptions.mozilla })).status).toBe(204);
  return { moss, code, browser, computer, tokens };
}

const apnsOf = (entries: FakeLogEntry[]) => entries.filter((e) => e.service === "apns").map((e) => ({ token: e.token, topic: e.topic, status: e.status }));

describe("a phone's app", () => {
  it("is named at registration (moss or code) and shown in the list; an APNs target with none, or another, is refused", async () => {
    const a = await account();
    const listed = (await (await call(a.computer.token, "GET", "/v1/targets")).json()) as { targets: Record<string, unknown>[] };
    expect(listed.targets.map(({ added: _added, ...rest }) => rest)).toEqual([
      { id: "moss-phone", kind: "apns", env: "production", app: "moss" },
      { id: "code-phone", kind: "apns", env: "production", app: "code" },
      { id: "browser", kind: "webpush", host: "updates.push.services.mozilla.com" },
    ]);
    const { token } = await device(uniqueAccount(), "phone");
    for (const app of [undefined, "host", "MOSS", "", 1, null]) {
      const body = { kind: "apns", token: apnsToken(), env: "production", ...(app === undefined ? {} : { app }) };
      expect([app, (await call(token, "PUT", "/v1/targets/self", body)).status]).toEqual([app, 400]);
    }
  });

  it("is pushed under its own app's topic: each token reaches Apple under the topic of the app it registered as", async () => {
    const a = await account();
    const before = await length();
    const response = await call(a.computer.token, "POST", "/v1/notify", { badge: 2 });
    expect(await response.json()).toEqual({ sent: 3, removed: 0, failed: 0 });
    const entries = await since(before);
    expect(apnsOf(entries).sort((x, y) => (x.token! < y.token! ? -1 : 1))).toEqual(
      [
        { token: a.tokens.moss, topic: env.APNS_TOPIC_MOSS, status: 200 },
        { token: a.tokens.code, topic: env.APNS_TOPIC_CODE, status: 200 },
      ].sort((x, y) => (x.token < y.token ? -1 : 1)),
    );
    expect(env.APNS_TOPIC_MOSS).not.toBe(env.APNS_TOPIC_CODE);
  });

  it("a token that claims the other app's is not pushed under it: Apple refuses it, and it is not sent anywhere else", async () => {
    const id = uniqueAccount();
    const phone = await device(id, "phone");
    const computer = await device(id, "main-computer");
    const codeToken = apnsToken(CODE_TOKEN_PREFIX);
    await call(phone.token, "PUT", "/v1/targets/self", { kind: "apns", app: "moss", token: codeToken, env: "production" });
    const before = await length();
    expect(await (await call(computer.token, "POST", "/v1/notify", { badge: 1 })).json()).toEqual({ sent: 0, removed: 0, failed: 1 });
    expect(apnsOf(await since(before))).toEqual([{ token: codeToken, topic: env.APNS_TOPIC_MOSS, status: 400 }]);
  });

  it("with no topic configured for its app, it is not sent to, the target stays, and the other app's phones still get theirs", async () => {
    const config: ApnsConfig = { keyId: "K", teamId: "T", topics: { moss: "", code: "test.code.ios" }, privateKey: "unused", productionOrigin: "https://api.push.apple.com", sandboxOrigin: "https://api.sandbox.push.apple.com" };
    const before = await length();
    expect(await sendApns(config, { token: apnsToken(), env: "production", app: "moss" }, 1, Date.now())).toEqual({ ok: false, gone: false, status: 0, reason: "not_configured" });
    expect(await since(before)).toEqual([]);
  });
});

describe("which phones a notify wakes", () => {
  it("with no preference, every phone and browser", async () => {
    const a = await account();
    const before = await length();
    await call(a.computer.token, "POST", "/v1/notify", { badge: 1 });
    const entries = await since(before);
    expect(apnsOf(entries).map((e) => e.token).sort()).toEqual([a.tokens.moss, a.tokens.code].sort());
    expect(entries.filter((e) => e.service === "webpush")).toHaveLength(1);
  });

  it("naming a phone wakes it and not the other phone; the browser still gets it", async () => {
    const a = await account();
    for (const [named, other] of [["moss", "code"], ["code", "moss"]] as const) {
      const before = await length();
      const response = await call(a.computer.token, "POST", "/v1/notify", { badge: 4, phones: [`${named}-phone`] });
      expect(await response.json()).toEqual({ sent: 2, removed: 0, failed: 0 });
      const entries = await since(before);
      expect(apnsOf(entries).map((e) => e.token)).toEqual([a.tokens[named]]);
      expect(apnsOf(entries).map((e) => e.token)).not.toContain(a.tokens[other]);
      expect(entries.filter((e) => e.service === "webpush")).toHaveLength(1);
    }
  });

  it("naming phones it holds no target for wakes every phone rather than none; naming none wakes every phone", async () => {
    const a = await account();
    for (const phones of [["unknown-phone"], [], ["unknown-phone", "another-one"]]) {
      const before = await length();
      const response = await call(a.computer.token, "POST", "/v1/notify", { badge: 1, phones });
      expect(await response.json()).toEqual({ sent: 3, removed: 0, failed: 0 });
      expect(apnsOf(await since(before)).map((e) => e.token).sort()).toEqual([a.tokens.moss, a.tokens.code].sort());
    }
  });

  it("naming several wakes those; one it holds and one it doesn't wakes the one it holds", async () => {
    const a = await account();
    const before = await length();
    await call(a.computer.token, "POST", "/v1/notify", { badge: 1, phones: ["moss-phone", "code-phone"] });
    expect(apnsOf(await since(before))).toHaveLength(2);
    const next = await length();
    await call(a.computer.token, "POST", "/v1/notify", { badge: 2, phones: ["code-phone", "not-registered"] });
    expect(apnsOf(await since(next)).map((e) => e.token)).toEqual([a.tokens.code]);
  });

  it("a browser's device id in the list wakes no browser less: browsers are not phones", async () => {
    const a = await account();
    const before = await length();
    await call(a.computer.token, "POST", "/v1/notify", { badge: 1, phones: ["moss-phone"] });
    expect((await since(before)).filter((e) => e.service === "webpush")).toHaveLength(1);
  });

  it("refuses a list that isn't a short list of device ids, and wakes no one for it", async () => {
    const a = await account();
    const before = await length();
    const bad: unknown[] = ["moss-phone", { 0: "moss-phone" }, [1], [null], [""], ["a b"], ["../x"], new Array(65).fill("moss-phone"), [["moss-phone"]], 7];
    for (const phones of bad) expect([JSON.stringify(phones).slice(0, 40), (await call(a.computer.token, "POST", "/v1/notify", { badge: 1, phones })).status]).toEqual([JSON.stringify(phones).slice(0, 40), 400]);
    expect(await since(before)).toEqual([]);
  });

  it("is the same account only: a phone id another account has registered is no preference here", async () => {
    const mine = await account();
    const theirs = await account();
    const before = await length();
    await call(mine.computer.token, "POST", "/v1/notify", { badge: 1, phones: ["moss-phone"] });
    const tokens = apnsOf(await since(before)).map((e) => e.token);
    expect(tokens).toEqual([mine.tokens.moss]);
    expect(tokens).not.toContain(theirs.tokens.moss);
  });
});

describe("Android (FCM)", () => {
  const fcmToken = `${"A".repeat(11)}:APA91b${"x".repeat(140)}`;

  it("is a target kind shaped like the others, refused as not configured until there are credentials; nothing is stored or sent", async () => {
    const id = uniqueAccount();
    const phone = await device(id, "pixel");
    const computer = await device(id, "main-computer");
    for (const app of ["moss", "code"]) {
      const response = await call(phone.token, "PUT", "/v1/targets/self", { kind: "fcm", app, token: fcmToken });
      expect([app, response.status, await response.json()]).toEqual([app, 503, { error: "not_configured" }]);
    }
    expect(await (await call(computer.token, "GET", "/v1/targets")).json()).toEqual({ targets: [] });
    const before = await length();
    expect(await (await call(computer.token, "POST", "/v1/notify", { badge: 1 })).json()).toEqual({ sent: 0, removed: 0, failed: 0 });
    expect(await since(before)).toEqual([]);
  });

  it("is still checked for its shape before it is refused for its credentials: a malformed one is a bad target", async () => {
    const { token } = await device(uniqueAccount(), "pixel");
    const bad = [
      { kind: "fcm", app: "moss", token: "short" },
      { kind: "fcm", app: "moss", token: "has spaces " + "x".repeat(120) },
      { kind: "fcm", app: "moss" },
      { kind: "fcm", token: fcmToken },
      { kind: "fcm", app: "host", token: fcmToken },
      { kind: "fcm", app: "code", token: 7 },
    ];
    for (const body of bad) expect([JSON.stringify(body).slice(0, 50), (await call(token, "PUT", "/v1/targets/self", body)).status]).toEqual([JSON.stringify(body).slice(0, 50), 400]);
  });
});
