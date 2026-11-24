// The account's deletion at push (services/accounts PROTOCOL.md, "Deleting the account"): only the account service's
// erase token wipes the account's targets, a device's own token never does, an erase token does nothing else, and a
// token minted before the deletion can't put anything back while it lives.

import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { b64u, sha256, utf8 } from "../../shared/encoding";
import { ERASED_KEEP_MS, type PushDO } from "../src/push-do";
import { accountToken, apnsToken, call, device, uniqueAccount } from "./helpers";

const erase = (account: string) => accountToken({ account, device: "account-erase", erase: true });
const objectOf = async (account: string) => env.PUSH.getByName(b64u(await sha256(utf8(`push-account|${account}`))));

describe("deleting the account", () => {
  it("an erase token wipes every target and the revocations; the account's old tokens are refused after", async () => {
    const account = uniqueAccount();
    const phone = await device(account, "phone-1");
    expect((await call(phone.token, "PUT", "/v1/targets/self", { kind: "apns", app: "moss", token: apnsToken(), env: "production" })).status).toBe(204);
    expect((await call(phone.token, "DELETE", "/v1/devices/old-phone")).status).toBe(204);

    expect((await call(await erase(account), "DELETE", "/v1/account")).status).toBe(204);
    const rows = await runInDurableObject(await objectOf(account), (_i: PushDO, state) => ({
      targets: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM targets").one().n,
      revoked: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM revoked").one().n,
    }));
    expect(rows).toEqual({ targets: 0, revoked: 0 });
    // A token the phone held from before: it can't register again or notify while it lives.
    expect((await call(phone.token, "PUT", "/v1/targets/self", { kind: "apns", app: "moss", token: apnsToken(), env: "production" })).status).toBe(410);
    expect((await call(phone.token, "POST", "/v1/notify", { badge: 1 })).status).toBe(410);
    expect((await call(phone.token, "GET", "/v1/targets")).status).toBe(410);
    // Again: the same answer, nothing to do.
    expect((await call(await erase(account), "DELETE", "/v1/account")).status).toBe(204);
  });

  it("a device's own token can't wipe the account", async () => {
    const account = uniqueAccount();
    const phone = await device(account, "phone-1");
    expect((await call(phone.token, "PUT", "/v1/targets/self", { kind: "apns", app: "moss", token: apnsToken(), env: "production" })).status).toBe(204);
    expect((await call(phone.token, "DELETE", "/v1/account")).status).toBe(401);
    expect(((await (await call(phone.token, "GET", "/v1/targets")).json()) as { targets: unknown[] }).targets).toHaveLength(1);
  });

  it("an erase token does nothing but the wipe", async () => {
    const account = uniqueAccount();
    const token = await erase(account);
    expect((await call(token, "GET", "/v1/targets")).status).toBe(401);
    expect((await call(token, "PUT", "/v1/targets/self", { kind: "apns", app: "moss", token: apnsToken(), env: "production" })).status).toBe(401);
    expect((await call(token, "POST", "/v1/notify", { badge: 1 })).status).toBe(401);
    expect((await call(token, "DELETE", "/v1/devices/phone-1")).status).toBe(401);
  });

  it("an erase token for another account wipes only that one", async () => {
    const mine = uniqueAccount();
    const phone = await device(mine, "phone-1");
    expect((await call(phone.token, "PUT", "/v1/targets/self", { kind: "apns", app: "moss", token: apnsToken(), env: "production" })).status).toBe(204);
    expect((await call(await erase(uniqueAccount()), "DELETE", "/v1/account")).status).toBe(204);
    expect(((await (await call(phone.token, "GET", "/v1/targets")).json()) as { targets: unknown[] }).targets).toHaveLength(1);
  });

  it("once every older token has ended, the object forgets the account entirely", async () => {
    const account = uniqueAccount();
    const phone = await device(account, "phone-1");
    expect((await call(phone.token, "PUT", "/v1/targets/self", { kind: "apns", app: "moss", token: apnsToken(), env: "production" })).status).toBe(204);
    expect((await call(await erase(account), "DELETE", "/v1/account")).status).toBe(204);
    const object = await objectOf(account);
    // The alarm is set for the end of the keep window; moved into the past, it clears the object.
    await runInDurableObject(object, async (_i: PushDO, state) => {
      state.storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'erased'", String(Date.now() - ERASED_KEEP_MS - 1));
    });
    expect(await runDurableObjectAlarm(object)).toBe(true);
    const left = await runInDurableObject(object, (_i: PushDO, state) => ({
      meta: state.storage.sql.exec<{ k: string }>("SELECT k FROM meta ORDER BY k").toArray().map((r) => r.k),
      targets: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM targets").one().n,
    }));
    // Only the schema's own version is left: no owner, no mark that the account was here.
    expect(left).toEqual({ meta: ["schema"], targets: 0 });
  });
});
