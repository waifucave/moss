// The account's deletion, a device leaving at sign-out, and how long a revoked device's row is kept (PROTOCOL.md,
// "Deleting the account", "Leaving", "Revocation"). Written for the wrong caller first and for a deletion that only
// half happened.

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, test } from "vitest";

import type { AccountDO } from "../src/account-do";
import { ERASE_DEVICE } from "../src/deletion";
import { deleteStatement, leaveStatement, LIMITS, mintStatement } from "../src/wire";
import { call, mintFor, newDevice, register, registration, signIn, type Session, type TestDevice } from "./helpers";

interface Erase {
  host: string;
  path: string;
  method: string;
  claims: Record<string, unknown>;
}

const erases = async (): Promise<Erase[]> => (await (await fetch("https://push.test/__erases")).json()) as Erase[];
const setServicesDown = async (down: boolean) => void (await fetch("https://push.test/__down", { method: "POST", body: JSON.stringify({ down }) }));
const setAdminDown = async (down: boolean) => void (await fetch("https://auth.test/__admin-down", { method: "POST", body: JSON.stringify({ down }) }));

async function deleteBody(session: Session, device: TestDevice, options: { t?: number; signer?: TestDevice; statement?: Uint8Array } = {}) {
  const t = options.t ?? Date.now();
  const sig = await (options.signer ?? device).sign(options.statement ?? deleteStatement(session.account, device.id, t));
  return { dev: device.id, t, sig };
}

const askDelete = async (session: Session | string, body: unknown) => call("POST", "/v1/account/delete", { session, body });

async function account(): Promise<{ session: Session; studio: TestDevice; laptop: TestDevice }> {
  const session = await signIn();
  const studio = await newDevice();
  const laptop = await newDevice();
  expect((await register(session, studio)).status).toBe(201);
  expect((await register(session, laptop, { name: "laptop" })).status).toBe(201);
  return { session, studio, laptop };
}

beforeEach(async () => {
  await setServicesDown(false);
  await setAdminDown(false);
});

describe("deleting the account", () => {
  test("a device of the account deletes it: every row goes, each service is told with an erase token, then the sign-in", async () => {
    const { session, studio } = await account();
    const before = (await erases()).length;
    const res = await askDelete(session, await deleteBody(session, studio));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deletion: { pending: string[] } }).deletion.pending).toEqual([]);
    const sent = (await erases()).slice(before);
    expect(sent.map((e) => `${e.method} ${e.host}${e.path}`)).toEqual([
      "DELETE hooks.test/v1/account",
      "DELETE push.test/v1/account",
      "DELETE handshake.test/v1/accounts/self",
      `DELETE auth.test/auth/v1/admin/users/${session.account}`,
    ]);
    for (const e of sent.slice(0, 3)) {
      expect(e.claims).toMatchObject({ sub: session.account, dev: ERASE_DEVICE, erase: true });
      expect(Number(e.claims.exp) - Number(e.claims.iat)).toBeLessThanOrEqual(300);
    }
    expect(sent.slice(0, 3).map((e) => e.claims.aud)).toEqual(["hooks.waifucave.com", "push.waifucave.com", "handshake.waifucave.com"]);
    // The sign-in is gone, so the session is refused; and the object kept nothing.
    expect((await call("GET", "/v1/devices", { session })).status).toBe(401);
    const left = await runInDurableObject(env.ACCOUNTS.getByName(session.account), (_o: AccountDO, state) => ({
      devices: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM devices").one().n,
      meta: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM meta").one().n,
    }));
    expect(left).toEqual({ devices: 0, meta: 0 });
  });

  test("an ordinary mint never carries the erase claim", async () => {
    const { session, studio } = await account();
    const res = await mintFor(session, studio);
    const { token } = (await res.json()) as { token: string };
    const claims = JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    expect(claims.erase).toBeUndefined();
  });

  describe("the wrong caller", () => {
    test("no session, or one Supabase refuses", async () => {
      const { session, studio } = await account();
      const body = await deleteBody(session, studio);
      expect((await call("POST", "/v1/account/delete", { body })).status).toBe(401);
      expect((await askDelete("not-a-session", body)).status).toBe(401);
      expect((await call("GET", "/v1/devices", { session })).status).toBe(200);
    });

    test("a session alone, with no device's signature, or another device's", async () => {
      const { session, studio, laptop } = await account();
      expect((await askDelete(session, { dev: studio.id, t: Date.now(), sig: "A".repeat(86) })).status).toBe(403);
      expect((await askDelete(session, await deleteBody(session, studio, { signer: laptop }))).status).toBe(403);
      expect((await call("GET", "/v1/devices", { session })).status).toBe(200);
    });

    test("a mint's or a registration's signature never passes as a deletion", async () => {
      const { session, studio } = await account();
      const t = Date.now();
      const asMint = await deleteBody(session, studio, { t, statement: mintStatement(session.account, "push.waifucave.com", studio.id, t) });
      expect((await askDelete(session, asMint)).status).toBe(403);
      const reg = await registration(session, studio, { t });
      expect((await askDelete(session, { dev: studio.id, t, sig: reg.sig })).status).toBe(403);
      // A delete statement for another account doesn't delete this one.
      const other = await signIn();
      const forOther = await deleteBody(session, studio, { t, statement: deleteStatement(other.account, studio.id, t) });
      expect((await askDelete(session, forOther)).status).toBe(403);
      expect((await call("GET", "/v1/devices", { session })).status).toBe(200);
    });

    test("another account's session with this account's device", async () => {
      const { session, studio } = await account();
      const other = await signIn();
      expect((await askDelete(other, await deleteBody(other, studio))).status).toBe(403);
      expect((await call("GET", "/v1/devices", { session })).status).toBe(200);
    });

    test("a revoked device", async () => {
      const { session, studio, laptop } = await account();
      expect((await call("DELETE", `/v1/devices/${laptop.id}`, { session })).status).toBe(204);
      expect((await askDelete(session, await deleteBody(session, laptop))).status).toBe(403);
      expect((await call("GET", "/v1/devices", { session })).status).toBe(200);
      void studio;
    });

    test("a statement outside the time window", async () => {
      const { session, studio } = await account();
      expect((await askDelete(session, await deleteBody(session, studio, { t: Date.now() - LIMITS.statementWindowMs - 60_000 }))).status).toBe(400);
    });
  });

  describe("half done", () => {
    test("with the services down, the account is refused at once and the steps stay pending until they answer", async () => {
      const { session, studio, laptop } = await account();
      await setServicesDown(true);
      const res = await askDelete(session, await deleteBody(session, studio));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { deletion: { pending: string[] } }).deletion.pending).toEqual(["hooks", "push", "handshake", "sign-in"]);
      // Nothing of the account works any more: no device can list, mint, register or revoke.
      expect((await call("GET", "/v1/devices", { session })).status).toBe(410);
      expect((await mintFor(session, laptop)).status).toBe(410);
      expect((await register(session, await newDevice())).status).toBe(410);
      expect((await call("DELETE", `/v1/devices/${laptop.id}`, { session })).status).toBe(410);
      // The sign-in wasn't touched before the services were done.
      expect((await erases()).some((e) => e.path.endsWith(session.account))).toBe(false);

      // The object's alarm finishes it on its own once the services answer.
      await setServicesDown(false);
      const object = env.ACCOUNTS.getByName(session.account);
      await runInDurableObject(object, (_o: AccountDO, state) => {
        const v = JSON.parse(state.storage.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'deleting'").one().v) as { next: number };
        state.storage.sql.exec("UPDATE meta SET v = ? WHERE k = 'deleting'", JSON.stringify({ ...v, next: 0 }));
      });
      expect(await runDurableObjectAlarm(object)).toBe(true);
      expect((await erases()).some((e) => e.path === `/auth/v1/admin/users/${session.account}`)).toBe(true);
      expect((await call("GET", "/v1/devices", { session })).status).toBe(401);
    });

    test("asked again while it runs, any session of the account learns how far it got and the steps are tried again", async () => {
      const { session, studio } = await account();
      await setAdminDown(true);
      const first = (await (await askDelete(session, await deleteBody(session, studio))).json()) as { deletion: { pending: string[]; deletedAt: number } };
      expect(first.deletion.pending).toEqual(["sign-in"]);
      // The device's row is gone, so the body's signature can't be checked: the answer is only the deletion's state.
      const again = (await (await askDelete(session, await deleteBody(session, studio))).json()) as { deletion: { pending: string[]; deletedAt: number } };
      expect(again.deletion).toEqual(first.deletion);
      await setAdminDown(false);
      const done = (await (await askDelete(session, await deleteBody(session, studio))).json()) as { deletion: { pending: string[] } };
      expect(done.deletion.pending).toEqual([]);
    });
  });
});

describe("leaving at sign-out", () => {
  async function leaveBody(session: Session, device: TestDevice, t = Date.now(), signer = device) {
    return { dev: device.id, t, sig: await signer.sign(leaveStatement(session.account, device.id, t)) };
  }

  test("a device leaves with its own signature: its row goes, and it can register again", async () => {
    const { session, studio } = await account();
    expect((await call("POST", "/v1/devices/leave", { session, body: await leaveBody(session, studio) })).status).toBe(204);
    const listed = (await (await call("GET", "/v1/devices", { session })).json()) as { devices: { id: string }[] };
    expect(listed.devices.map((d) => d.id)).not.toContain(studio.id);
    expect((await register(session, studio)).status).toBe(201);
  });

  test("another device's signature can't make a device leave, and a leave can't be sent again after a new registration", async () => {
    const { session, studio, laptop } = await account();
    expect((await call("POST", "/v1/devices/leave", { session, body: await leaveBody(session, studio, Date.now(), laptop) })).status).toBe(403);
    const captured = await leaveBody(session, studio);
    expect((await call("POST", "/v1/devices/leave", { session, body: captured })).status).toBe(204);
    expect((await register(session, studio, { t: Date.now() + 1 })).status).toBe(201);
    expect((await call("POST", "/v1/devices/leave", { session, body: captured })).status).toBe(409);
  });

  test("a revoked device can't leave: its revoke stays", async () => {
    const { session, laptop } = await account();
    expect((await call("DELETE", `/v1/devices/${laptop.id}`, { session })).status).toBe(204);
    expect((await call("POST", "/v1/devices/leave", { session, body: await leaveBody(session, laptop) })).status).toBe(403);
    expect((await register(session, laptop)).status).toBe(403);
  });
});

describe("a revoked device's row", () => {
  test("is listed for 30 days, then cut to its id, which still refuses the device's key", async () => {
    const { session, laptop } = await account();
    expect((await call("DELETE", `/v1/devices/${laptop.id}`, { session })).status).toBe(204);
    const object = env.ACCOUNTS.getByName(session.account);
    const listed = async () => ((await (await call("GET", "/v1/devices", { session })).json()) as { devices: { id: string; revokedAt?: number }[] }).devices;
    expect((await listed()).find((d) => d.id === laptop.id)?.revokedAt).toBeTypeOf("number");
    await runInDurableObject(object, (_o: AccountDO, state) => {
      state.storage.sql.exec("UPDATE devices SET revoked_at = ? WHERE id = ?", Date.now() - LIMITS.revokedRowKeepMs - 1, laptop.id);
    });
    expect(await runDurableObjectAlarm(object)).toBe(true);
    const kept = await runInDurableObject(object, (_o: AccountDO, state) => ({
      row: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE id = ?", laptop.id).one().n,
      id: state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM revoked_ids WHERE id = ?", laptop.id).one().n,
    }));
    expect(kept).toEqual({ row: 0, id: 1 });
    expect((await listed()).map((d) => d.id)).not.toContain(laptop.id);
    // Its name, keys, kind and system are gone; its key still can't come back.
    expect((await register(session, laptop)).status).toBe(403);
    expect((await mintFor(session, laptop)).status).toBe(403);
    expect((await call("DELETE", `/v1/devices/${laptop.id}`, { session })).status).toBe(204);
  });

});
