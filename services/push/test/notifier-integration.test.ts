// The moss/push plugin's own notifier (plugins/moss/plugins/push/src/notifier.ts) against the real push Worker,
// inside workerd, with APNs and Web Push faked: what the core hands it never leaves the computer.

import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { PushNotifier } from "../../../plugins/moss/plugins/push/src/notifier";
import { CODE_TOKEN_PREFIX } from "./fake-log";
import { accountToken, apnsToken, call, fakeLog, ORIGIN, subscriptions, uniqueAccount } from "./helpers";

describe("the push plugin's notifier, against the Worker", () => {
  it("wakes the account's phone and browser with the count alone", async () => {
    const account = uniqueAccount();
    const phone = await accountToken({ account, device: "phone" });
    const browser = await accountToken({ account, device: "browser" });
    const token = apnsToken();
    expect((await call(phone, "PUT", "/v1/targets/self", { kind: "apns", app: "moss", token, env: "production" })).status).toBe(204);
    expect((await call(browser, "PUT", "/v1/targets/self", { kind: "webpush", ...subscriptions.fcm })).status).toBe(204);

    const computerToken = await accountToken({ account, device: "main-computer" });
    const notifier = new PushNotifier({
      origin: ORIGIN,
      // Stands in for the core's keyed fetch, which adds the computer's account token.
      fetch: (url, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${computerToken}`);
        return exports.default.fetch(new Request(url, { ...init, headers }));
      },
      debounceMs: 10,
    });
    const before = (await fakeLog()).length;
    await notifier.notify({ bot: "alpha", title: "Alpha", body: "your build failed: token sk-live-123" });
    await notifier.notify({ kind: "approval", text: "Allow rm -rf?" });
    await notifier.flush();

    const entries = (await fakeLog()).slice(before);
    const apns = entries.find((e) => e.token === token)!;
    expect(apns.status).toBe(200);
    expect((apns.payload as { aps: { badge: number } }).aps.badge).toBe(2);
    const web = entries.find((e) => e.service === "webpush" && e.subscription === "fcm")!;
    expect(web.decrypted).toEqual({ n: 2 });
    const everything = JSON.stringify(entries);
    for (const secret of ["alpha", "Alpha", "build failed", "sk-live-123", "rm -rf"]) expect(everything).not.toContain(secret);
  });

  it("wakes the phones the core names for an update first: a bot's update only the MOSS phone, then a session's the MOSS Code phone", async () => {
    const account = uniqueAccount();
    const mossPhone = await accountToken({ account, device: "moss0phone000000" });
    const codePhone = await accountToken({ account, device: "code0phone000000" });
    const mossToken = apnsToken();
    const codeToken = apnsToken(CODE_TOKEN_PREFIX);
    await call(mossPhone, "PUT", "/v1/targets/self", { kind: "apns", app: "moss", token: mossToken, env: "production" });
    await call(codePhone, "PUT", "/v1/targets/self", { kind: "apns", app: "code", token: codeToken, env: "production" });

    const computerToken = await accountToken({ account, device: "main-computer" });
    const notifier = new PushNotifier({
      origin: ORIGIN,
      fetch: (url, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${computerToken}`);
        return exports.default.fetch(new Request(url, { ...init, headers }));
      },
      debounceMs: 10,
    });
    const before = (await fakeLog()).length;
    await notifier.notify({ bot: "alpha", phones: ["moss0phone000000"] });
    await notifier.flush();
    await notifier.notify({ session: "s1", phones: ["code0phone000000"] });
    await notifier.flush();
    const tokens = (await fakeLog()).slice(before).filter((e) => e.service === "apns").map((e) => [e.token, e.topic]);
    expect(tokens).toEqual([[mossToken, env.APNS_TOPIC_MOSS], [codeToken, env.APNS_TOPIC_CODE]]);
  });
});
