// The account's deletion on this computer (the deletion lane, item 1) and sign-out's leave (item 2), against the sign-in
// stub and the stand-in account service: the wrong caller is refused, a deletion half done is finished, a device that
// learns of the deletion signs out once and never asks again, and what the account put here goes while the rest stays.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSignInStub } from "@waifucave/moss-test-harness/signin-stub";
import { MOSS_ERR } from "@waifucave/moss-protocol";
import { MemorySecretStore } from "../../contracts/fakes/secret-store";
import { Secret } from "../../contracts/secret-store";
import { syncAccountDevices } from "../../devices/account-devices";
import { FileDeviceRegistry } from "../../devices/registry";
import { accountDeletionMethods } from "../../deletion/account-rpc";
import type { CardOpener, MethodContext } from "../../devices/rpc";
import { ACCOUNT_SESSION_REF, AccountClient } from "../account";
import { deleteAccount, resumeAccountDeletion } from "../account-deletion";
import { startFakeAccountService } from "../account-fake";
import { BoxKey } from "../box-key";
import { DeviceKey } from "../device-key";

let stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.reverse()) s();
  stops = [];
});

const clock = { now: () => Date.now() };

function stack() {
  const auth = startSignInStub();
  stops.push(() => auth.stop());
  const service = startFakeAccountService({ authUrl: auth.url, anonKey: auth.anonKey });
  stops.push(() => service.stop());
  auth.addUser({ email: "someone@example.invalid", password: "correct horse" });
  return { auth, service };
}

async function device(s: ReturnType<typeof stack>, name: string) {
  const store = new MemorySecretStore();
  const key = await DeviceKey.loadOrCreate(store);
  const boxKey = await BoxKey.loadOrCreate(store);
  const home = mkdtempSync(join(tmpdir(), "moss-account-del-"));
  const registry = await FileDeviceRegistry.open({ home, key, clock, self: { name, os: "macos" } });
  const account = new AccountClient({ config: { authUrl: s.auth.url, anonKey: s.auth.anonKey, serviceUrl: s.service.url }, store, device: key, clock });
  stops.push(() => account.close());
  await account.signInWithPassword("someone@example.invalid", new Secret("correct horse"));
  await syncAccountDevices({ registry, account, device: key, boxKey });
  return { name, store, key, boxKey, registry, account, home };
}

const user = (client: "app" | "cli"): MethodContext => ({ caller: { kind: "user", client } as MethodContext["caller"] });
const noCard: CardOpener = async () => {
  throw new Error("no card expected");
};

describe("deleting the account", () => {
  test("deletes it at the service, then what it put here; conversations and other files stay", async () => {
    const s = stack();
    const studio = await device(s, "Studio");
    const laptop = await device(s, "Laptop");
    await syncAccountDevices({ registry: studio.registry, account: studio.account, device: studio.key, boxKey: studio.boxKey });
    expect(studio.registry.get(laptop.key.id)).toBeDefined();
    writeFileSync(join(studio.home, "conversation.ndjson"), "kept");
    const sub = (await studio.account.accountId())!;

    const out = await deleteAccount({ home: studio.home, account: studio.account, registry: studio.registry, clock });
    expect(out.pending).toEqual([]);
    expect(s.service.deleted.has(sub)).toBe(true);
    expect(await studio.store.get(ACCOUNT_SESSION_REF)).toBeNull();
    expect(await studio.account.status()).toEqual({ signedIn: false });
    // The laptop came in through the account alone: forgotten, not revoked (it can be paired again by code).
    expect(out.forgotten).toEqual([laptop.key.id]);
    expect(studio.registry.get(laptop.key.id)).toBeUndefined();
    expect(await studio.account.deletionMark()).toBeNull();
    expect(existsSync(join(studio.home, "conversation.ndjson"))).toBe(true);
    expect(await studio.account.tokens.current("push.waifucave.com")).toBeNull();
  });

  test("the other computer learns of it at its next contact, signs out once, and never asks again", async () => {
    const s = stack();
    const studio = await device(s, "Studio");
    const laptop = await device(s, "Laptop");
    let ended = 0;
    laptop.account.whenEnded(() => ended++);
    await deleteAccount({ home: studio.home, account: studio.account, registry: studio.registry, clock });

    const sync = await syncAccountDevices({ registry: laptop.registry, account: laptop.account, device: laptop.key, boxKey: laptop.boxKey }).catch((e: unknown) => e);
    expect(sync).toBeInstanceOf(Error);
    expect(ended).toBe(1);
    expect(await laptop.account.status()).toEqual({ signedIn: false });
    // Signed out: nothing more is asked of the service (no session to ask with), and no token is handed out.
    const calls = s.service.mints.length;
    expect(await laptop.account.mint("push.waifucave.com")).toBeNull();
    expect(await laptop.account.tokens.current("hooks.waifucave.com")).toBeNull();
    expect(s.service.mints.length).toBe(calls);
    expect(ended).toBe(1);
  });

  test("with the sign-in itself deleted (production), the other computer's refused refresh is checked with the sign-in project: the user is gone, so its account-only peers are forgotten", async () => {
    const s = stack();
    const studio = await device(s, "Studio");
    const laptop = await device(s, "Laptop");
    expect(laptop.registry.get(studio.key.id)).toBeDefined();
    const ends: string[] = [];
    laptop.account.whenEnded((why) => {
      ends.push(why);
      laptop.registry.dropAccountRevokeSteps();
      laptop.registry.forgetAccountDevices();
    });
    const sub = (await studio.account.accountId())!;
    // The account service's last step: GoTrue's admin delete, with the project's service-role key.
    const res = await fetch(`${s.auth.url}/auth/v1/admin/users/${sub}`, { method: "DELETE", headers: { apikey: s.auth.serviceRoleKey, authorization: `Bearer ${s.auth.serviceRoleKey}` } });
    expect(res.status).toBe(200);
    await syncAccountDevices({ registry: laptop.registry, account: laptop.account, device: laptop.key, boxKey: laptop.boxKey }).catch(() => undefined);
    expect(ends).toEqual(["deleted"]);
    expect(await laptop.account.status()).toEqual({ signedIn: false });
    expect(laptop.registry.get(studio.key.id)).toBeUndefined();
  });

  test("a refresh refused for any other reason (signed out everywhere on the web) only signs this computer out: the devices the account added stay", async () => {
    const s = stack();
    const studio = await device(s, "Studio");
    const laptop = await device(s, "Laptop");
    const ends: string[] = [];
    laptop.account.whenEnded((why) => {
      ends.push(why);
      laptop.registry.forgetAccountDevices();
    });
    // The user is still there; only every session ended (the stub's global logout, as the web's "sign out everywhere").
    const token = await laptop.account.accessToken();
    expect((await fetch(`${s.auth.url}/auth/v1/logout?scope=global`, { method: "POST", headers: { apikey: s.auth.anonKey, authorization: `Bearer ${token}` } })).ok).toBe(true);
    await syncAccountDevices({ registry: laptop.registry, account: laptop.account, device: laptop.key, boxKey: laptop.boxKey }).catch(() => undefined);
    expect(ends).toEqual([]);
    expect(laptop.registry.get(studio.key.id)).toBeDefined();
  });

  test("half done: the service accepted but this computer stopped before its own part; the next start finishes it here and sends nothing", async () => {
    const s = stack();
    const studio = await device(s, "Studio");
    s.service.pendingOnDelete = ["sign-in"];
    const sub = (await studio.account.accountId())!;
    await studio.account.deleteAccount();
    await studio.account.setDeletionMark({ account: sub, askedAt: Date.now(), answeredAt: Date.now() });
    const asked = s.service.deleteCalls;
    const out = await resumeAccountDeletion({ home: studio.home, account: studio.account, registry: studio.registry, clock });
    expect(out?.pending).toEqual([]);
    expect(s.service.deleteCalls).toBe(asked);
    expect(await studio.account.status()).toEqual({ signedIn: false });
    expect(await studio.account.deletionMark()).toBeNull();
  });

  test("the service can't be reached: nothing here changes and no marker is left; the next start sends nothing", async () => {
    const s = stack();
    const studio = await device(s, "Studio");
    s.service.stop();
    await expect(deleteAccount({ home: studio.home, account: studio.account, registry: studio.registry, clock })).rejects.toBeDefined();
    expect((await studio.account.status()).signedIn).toBe(true);
    expect(await studio.account.deletionMark()).toBeNull();
    expect(await resumeAccountDeletion({ home: studio.home, account: studio.account, registry: studio.registry, clock })).toBeUndefined();
    expect((await studio.account.status()).signedIn).toBe(true);
  });

  test("a marker the service never accepted (an older build's) is cleared at start without sending", async () => {
    const s = stack();
    const studio = await device(s, "Studio");
    const sub = (await studio.account.accountId())!;
    await studio.account.setDeletionMark({ account: sub, askedAt: Date.now() });
    expect(await resumeAccountDeletion({ home: studio.home, account: studio.account, registry: studio.registry, clock })).toBeUndefined();
    expect(s.service.deleted.size).toBe(0);
    expect(s.service.deleteCalls).toBe(0);
    expect((await studio.account.status()).signedIn).toBe(true);
    expect(await studio.account.deletionMark()).toBeNull();
  });

  test("account A's marker never touches account B: a sign-out and a sign-in each clear it, and a marker naming another account is dropped at start", async () => {
    const s = stack();
    s.auth.addUser({ email: "other@example.invalid", password: "battery staple" });
    const studio = await device(s, "Studio");
    const a = (await studio.account.accountId())!;
    await studio.account.setDeletionMark({ account: a, askedAt: Date.now(), answeredAt: Date.now() });
    await studio.account.signOut();
    expect(await studio.account.deletionMark()).toBeNull();
    await studio.account.setDeletionMark({ account: a, askedAt: Date.now(), answeredAt: Date.now() });
    await studio.account.signInWithPassword("other@example.invalid", new Secret("battery staple"));
    expect(await studio.account.deletionMark()).toBeNull();
    const b = (await studio.account.accountId())!;
    expect(b).not.toBe(a);
    // Even one written behind the sign-in's back: dropped, and B stays signed in and undeleted.
    await studio.account.setDeletionMark({ account: a, askedAt: Date.now(), answeredAt: Date.now() });
    expect(await resumeAccountDeletion({ home: studio.home, account: studio.account, registry: studio.registry, clock })).toBeUndefined();
    expect(s.service.deleteCalls).toBe(0);
    expect(await studio.account.accountId()).toBe(b);
    expect(await studio.account.deletionMark()).toBeNull();
  });

  test("a marker file planted in the home (a plugin can write there) never sends a deletion", async () => {
    const s = stack();
    const studio = await device(s, "Studio");
    const sub = (await studio.account.accountId())!;
    writeFileSync(join(studio.home, "account-deletion.json"), JSON.stringify({ v: 1, account: sub, askedAt: Date.now(), answeredAt: Date.now() }));
    expect(await resumeAccountDeletion({ home: studio.home, account: studio.account, registry: studio.registry, clock })).toBeUndefined();
    expect(s.service.deleteCalls).toBe(0);
    expect((await studio.account.status()).signedIn).toBe(true);
  });
});

describe("account.delete: who may ask", () => {
  async function methods() {
    const s = stack();
    const studio = await device(s, "Studio");
    const cards: { change?: string }[] = [];
    let answer: (yes: boolean) => void = () => undefined;
    const openCard: CardOpener = async (req) => {
      cards.push(req as { change?: string });
      return { card: "card_test123", allowed: new Promise<boolean>((r) => (answer = r)) };
    };
    const m = accountDeletionMethods({ home: studio.home, account: studio.account, registry: studio.registry, clock, openCard });
    return { s, studio, cards, answer: (yes: boolean) => answer(yes), call: (params: unknown, ctx: MethodContext) => m["account.delete"]!(params, ctx) };
  }

  for (const [who, caller] of [
    ["a bot's session", { kind: "session", sessionId: "b_alpha" }],
    ["a plugin", { kind: "plugin", pluginId: "acme/thing" }],
    ["a peer computer", { kind: "peer", device: "x" }],
    // The person, but through a paired phone or the web page: refused at the function too, not only by the role lists.
    ["a paired phone", { kind: "user", client: "ios", device: "x" }],
    ["an Android phone", { kind: "user", client: "android", device: "x" }],
    ["the web page", { kind: "user", client: "web" }],
  ] as const) {
    test(`${who} is refused, and nothing is deleted`, async () => {
      const t = await methods();
      const err = await t.call({ confirm: true, typed: "DELETE" }, { caller: caller as unknown as MethodContext["caller"] }).catch((e: unknown) => e);
      expect((err as { code?: number }).code).toBe(MOSS_ERR.NOT_THE_USER);
      expect(t.s.service.deleted.size).toBe(0);
      expect(t.cards).toHaveLength(0);
    });
  }

  test("the person's terminal without its confirmation: nothing happens", async () => {
    const t = await methods();
    await expect(t.call({}, user("cli"))).rejects.toBeDefined();
    expect(t.s.service.deleted.size).toBe(0);
  });

  test("the person's terminal with confirm alone, or a wrong word: nothing happens (a script must state the word)", async () => {
    const t = await methods();
    await expect(t.call({ confirm: true }, user("cli"))).rejects.toBeDefined();
    await expect(t.call({ confirm: true, typed: "delete" }, user("cli"))).rejects.toBeDefined();
    expect(t.s.service.deleteCalls).toBe(0);
  });

  test("the person's terminal with its confirmation and the typed word deletes at once", async () => {
    const t = await methods();
    expect(await t.call({ confirm: true, typed: "DELETE" }, user("cli"))).toEqual({ applied: true, pending: [] });
    expect(t.s.service.deleted.size).toBe(1);
  });

  test("an app gets the engine's card; only the yes deletes, a no deletes nothing", async () => {
    const t = await methods();
    const res = (await t.call({ confirm: true }, user("app"))) as { applied: boolean; card?: string };
    expect(res).toEqual({ applied: false, card: "card_test123" });
    expect(t.cards[0]?.change).toBe("account-delete");
    expect(t.s.service.deleted.size).toBe(0);
    t.answer(false);
    await Bun.sleep(20);
    expect(t.s.service.deleted.size).toBe(0);
    expect((await t.studio.account.status()).signedIn).toBe(true);
  });

  test("an app's card answered yes deletes", async () => {
    const t = await methods();
    await t.call({}, user("app"));
    t.answer(true);
    for (let i = 0; i < 50 && t.s.service.deleted.size === 0; i++) await Bun.sleep(10);
    expect(t.s.service.deleted.size).toBe(1);
  });
});

describe("signing out leaves the account", () => {
  test("the device's row goes at the service, so the next sign-in registers it again", async () => {
    const s = stack();
    const studio = await device(s, "Studio");
    const sub = (await studio.account.accountId())!;
    expect(s.service.devices(sub).map((d) => d.id)).toContain(studio.key.id);
    expect(await studio.account.signOut()).toEqual({ left: true });
    expect(s.service.devices(sub).map((d) => d.id)).not.toContain(studio.key.id);
    await studio.account.signInWithPassword("someone@example.invalid", new Secret("correct horse"));
    await syncAccountDevices({ registry: studio.registry, account: studio.account, device: studio.key, boxKey: studio.boxKey });
    expect(s.service.devices(sub).map((d) => d.id)).toContain(studio.key.id);
  });

  test("another device forgets a device the account no longer lists", async () => {
    const s = stack();
    const studio = await device(s, "Studio");
    const laptop = await device(s, "Laptop");
    await syncAccountDevices({ registry: studio.registry, account: studio.account, device: studio.key, boxKey: studio.boxKey });
    expect(studio.registry.get(laptop.key.id)).toBeDefined();
    await laptop.account.signOut();
    const out = await syncAccountDevices({ registry: studio.registry, account: studio.account, device: studio.key, boxKey: studio.boxKey });
    expect(out.dropped).toEqual([laptop.key.id]);
    expect(studio.registry.get(laptop.key.id)).toBeUndefined();
  });
});
void noCard;
