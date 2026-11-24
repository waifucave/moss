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
import { ACCOUNT_DELETION_FILE, deleteAccount, resumeAccountDeletion } from "../account-deletion";
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
    expect(existsSync(join(studio.home, ACCOUNT_DELETION_FILE))).toBe(false);
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

  test("half done: a crash after the marker and before the answer is finished at the next start", async () => {
    const s = stack();
    const studio = await device(s, "Studio");
    const sub = (await studio.account.accountId())!;
    writeFileSync(join(studio.home, ACCOUNT_DELETION_FILE), JSON.stringify({ v: 1, account: sub, askedAt: Date.now() }));
    const out = await resumeAccountDeletion({ home: studio.home, account: studio.account, registry: studio.registry, clock });
    expect(out?.pending).toEqual([]);
    expect(s.service.deleted.has(sub)).toBe(true);
    expect(await studio.account.status()).toEqual({ signedIn: false });
    expect(existsSync(join(studio.home, ACCOUNT_DELETION_FILE))).toBe(false);
  });

  test("half done: the service answered but this computer stopped before its own part; the next start finishes it", async () => {
    const s = stack();
    const studio = await device(s, "Studio");
    s.service.pendingOnDelete = ["sign-in"];
    const sub = (await studio.account.accountId())!;
    // The service got it (as if the answer was lost on the way back).
    await studio.account.deleteAccount();
    writeFileSync(join(studio.home, ACCOUNT_DELETION_FILE), JSON.stringify({ v: 1, account: sub, askedAt: Date.now() }));
    const out = await resumeAccountDeletion({ home: studio.home, account: studio.account, registry: studio.registry, clock });
    expect(out?.pending).toEqual(["sign-in"]);
    expect(await studio.account.status()).toEqual({ signedIn: false });
  });

  test("the service can't be reached: nothing here changes, and the marker stays for the next try", async () => {
    const s = stack();
    const studio = await device(s, "Studio");
    s.service.stop();
    await expect(deleteAccount({ home: studio.home, account: studio.account, registry: studio.registry, clock })).rejects.toBeDefined();
    expect((await studio.account.status()).signedIn).toBe(true);
    expect(existsSync(join(studio.home, ACCOUNT_DELETION_FILE))).toBe(true);
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
  ] as const) {
    test(`${who} is refused, and nothing is deleted`, async () => {
      const t = await methods();
      const err = await t.call({ confirm: true }, { caller: caller as unknown as MethodContext["caller"] }).catch((e: unknown) => e);
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

  test("the person's terminal with its confirmation deletes at once", async () => {
    const t = await methods();
    expect(await t.call({ confirm: true }, user("cli"))).toEqual({ applied: true, pending: [] });
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
