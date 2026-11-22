import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createThrowawaySecretStore, throwawaySecretStoreAvailable } from "@waifucave/moss-test-harness";
import { KeychainSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority, TOKEN_NAMES } from "../../src/auth/tokens";
import { ContractError } from "../../src/contracts/common";
import { fileSecretsBackend, itemKey, movedMarkKey, moveOsStoreItems, type SecretsBackend } from "../../src/secrets/file-backend";
import { EncryptedFileValues, MossSecretStore, memoryVault, openMossSecretStore, vaultKey, type Vault } from "../../src/secrets/moss-secret-store";
import { encryptedFileStatus } from "../../src/contracts/secret-store";
import { LOCK_STALE_MS, lockToOwner, withSecretsLock, writePrivateFile } from "../../src/secrets/private-file";
import { SECRETS_FILE_NAME } from "../../src/secrets/secret-files";

// The flat-name store on Windows and Linux (spec §9.1; lane SF): every item in the one encrypted file, the key in the OS
// store. Throwaway homes, throwaway keys and in-memory vaults; the real OS store only where a test makes its own
// throwaway service and removes it (the last describe).

const home = () => mkdtempSync(join(tmpdir(), "moss-sfb-"));
const SVC = "svc";
const os = process.platform === "win32" ? "windows" : "linux";
const VALUE = ["sk", "file", Math.random().toString(36).slice(2)].join("-");
const raw = (h: string) => readFileSync(join(h, SECRETS_FILE_NAME));

/** A backend over `h`'s file whose key sits in `keys` (an in-memory vault), with no move from an OS store. */
const backendOn = (h: string, keys: Vault, extra: Partial<Parameters<typeof fileSecretsBackend>[0]> = {}) =>
  fileSecretsBackend({ home: h, service: SVC, os: "linux", vault: () => keys, moveFrom: null, ...extra });

describe("the flat-name backend over the secrets file", () => {
  test("a value round-trips, never sits in the file in the clear, and the rules of Bun.secrets hold", async () => {
    const h = home();
    const b = backendOn(h, memoryVault());
    expect(await b.get({ service: SVC, name: "anthropic:default" })).toBeNull();
    await b.set({ service: SVC, name: "anthropic:default", value: VALUE });
    expect(await b.get({ service: SVC, name: "anthropic:default" })).toBe(VALUE);
    expect(raw(h).includes(Buffer.from(VALUE))).toBe(false);
    expect(raw(h).includes(Buffer.from("anthropic:default"))).toBe(false); // names are inside the ciphertext too
    expect(await b.delete({ service: SVC, name: "anthropic:default" })).toBe(true);
    expect(await b.delete({ service: SVC, name: "anthropic:default" })).toBe(false);
    await b.set({ service: SVC, name: "k", value: "v" });
    await b.set({ service: SVC, name: "k", value: "" }); // an empty value deletes
    expect(await b.get({ service: SVC, name: "k" })).toBeNull();
    // Another service's item of the same name is another item.
    await b.set({ service: "other", name: "k", value: "o" });
    await b.set({ service: SVC, name: "k", value: "s" });
    expect([await b.get({ service: "other", name: "k" }), await b.get({ service: SVC, name: "k" })]).toEqual(["o", "s"]);
  });

  test("a second backend on the same home and the same key reads what the first wrote (a restart)", async () => {
    const h = home(), keys = memoryVault();
    await backendOn(h, keys).set({ service: SVC, name: "a", value: VALUE });
    expect(await backendOn(h, keys).get({ service: SVC, name: "a" })).toBe(VALUE);
  });

  test("the key gone: every call says locked, nothing is made new, the file is not touched (never a silent empty store)", async () => {
    const h = home(), keys = memoryVault();
    await backendOn(h, keys).set({ service: SVC, name: "harness-token", value: VALUE });
    const before = raw(h);
    keys.items.clear(); // the keyring lost the key
    const lost = backendOn(h, keys);
    for (const call of [() => lost.get({ service: SVC, name: "harness-token" }), () => lost.set({ service: SVC, name: "x", value: "y" }), () => lost.delete({ service: SVC, name: "harness-token" })]) {
      const e = await call().then(() => undefined, (err: unknown) => err);
      expect(e).toBeInstanceOf(ContractError);
      expect((e as ContractError).code).toBe("locked");
      expect(String((e as Error).message)).not.toContain(VALUE);
    }
    expect(keys.items.size).toBe(0); // no key was made over the lost one
    expect(raw(h).equals(before)).toBe(true);
  });

  test("a store that can't be opened makes the pairing tokens throw, never mint new ones that would unpair every device", async () => {
    const h = home(), keys = memoryVault();
    const minted = await new TokenAuthority(new KeychainSecretStore(backendOn(h, keys), SVC)).ensureTokens();
    const before = raw(h);
    const realKey = keys.items.get("secrets-file-key")!;
    keys.items.clear();
    const e = await new TokenAuthority(new KeychainSecretStore(backendOn(h, keys), SVC)).ensureTokens().then(() => undefined, (err: unknown) => err);
    expect((e as ContractError).code).toBe("locked");
    expect(raw(h).equals(before)).toBe(true);
    // A wrong key in its place is no better: the file can't be opened, and nothing is minted over it.
    keys.items.set("secrets-file-key", Buffer.alloc(32).toString("base64"));
    const wrong = await new TokenAuthority(new KeychainSecretStore(backendOn(h, keys), SVC)).ensureTokens().then(() => undefined, (err: unknown) => err);
    expect((wrong as ContractError).code).toBe("invalid");
    expect(raw(h).equals(before)).toBe(true);
    // The real key back: the same tokens, not new ones.
    keys.items.set("secrets-file-key", realKey);
    expect(await new TokenAuthority(new KeychainSecretStore(backendOn(h, keys), SVC)).ensureTokens()).toEqual(minted);
  });

  test("a locked keyring is asked again at the next call, not remembered", async () => {
    const h = home(), keys = memoryVault();
    let locked = true;
    const vault: Vault = {
      get: async (n) => keys.get(n),
      set: async (n, v) => { if (locked) throw new Error("the collection is locked"); await keys.set(n, v); },
      delete: async (n) => keys.delete(n),
    };
    const b = fileSecretsBackend({ home: h, service: SVC, os: "linux", vault: () => vault, interactive: true, moveFrom: null });
    await expect(b.set({ service: SVC, name: "a", value: VALUE })).rejects.toMatchObject({ code: "locked" });
    expect(existsSync(join(h, SECRETS_FILE_NAME))).toBe(false);
    locked = false;
    await b.set({ service: SVC, name: "a", value: VALUE });
    expect(await b.get({ service: SVC, name: "a" })).toBe(VALUE);
  });

  test("the contract store and the flat-name store keep their items in one file, one key, and never meet", async () => {
    const h = home(), keys = memoryVault();
    const flat = backendOn(h, keys);
    const contract = await openMossSecretStore({ home: h, service: SVC, os, vault: () => keys, ...(os === "linux" ? { interactive: false, systemdCreds: null } : {}) });
    await flat.set({ service: SVC, name: "anthropic:default", value: "flat-value" });
    await contract.set({ owner: { kind: "core" }, name: "anthropic:default" }, "contract-value");
    await contract.set({ owner: { kind: "device" }, name: "ed25519" }, "device-key");
    expect(await flat.get({ service: SVC, name: "anthropic:default" })).toBe("flat-value");
    expect((await contract.get({ owner: { kind: "core" }, name: "anthropic:default" }))?.value.reveal()).toBe("contract-value");
    expect(keys.items.size).toBe(1); // one key for the one file
    expect(existsSync(join(h, SECRETS_FILE_NAME))).toBe(true);
  });

  test("burst writes from one process all land", async () => {
    const h = home();
    const b = backendOn(h, memoryVault());
    await Promise.all(Array.from({ length: 25 }, (_, i) => b.set({ service: SVC, name: `k${i}`, value: `v${i}` })));
    for (let i = 0; i < 25; i++) expect(await b.get({ service: SVC, name: `k${i}` })).toBe(`v${i}`);
  });

  test("two backends on one file (two stores in one process) lose no write", async () => {
    const h = home(), keys = memoryVault();
    const a = backendOn(h, keys), b = backendOn(h, keys);
    await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).set({ service: SVC, name: `k${i}`, value: `v${i}` })));
    for (let i = 0; i < 20; i++) expect(await a.get({ service: SVC, name: `k${i}` })).toBe(`v${i}`);
  });

  test("separate processes (the daemon and the CLI) writing at once lose no write, and the first key made is the one kept", async () => {
    const h = home();
    const writer = join(import.meta.dir, "fixtures", "file-writer.ts");
    const kids = ["a", "b", "c", "d"].map((tag) => Bun.spawn([process.execPath, writer, h, tag, "12"], { stdout: "ignore", stderr: "pipe" }));
    const codes = await Promise.all(kids.map((k) => k.exited));
    expect(codes).toEqual([0, 0, 0, 0]);
    const none: Vault = { get: async () => null, set: async () => { throw new Error("org.freedesktop.DBus.Error.ServiceUnknown"); }, delete: async () => false };
    const reader = fileSecretsBackend({ home: h, service: SVC, os: "linux", vault: () => none, interactive: false, systemdCreds: null, moveFrom: null });
    for (const tag of ["a", "b", "c", "d"]) for (let i = 0; i < 12; i++) expect(await reader.get({ service: SVC, name: `${tag}-${i}` })).toBe(`${tag}-value-${i}`);
    expect(existsSync(join(h, "run", "secrets-file.lock"))).toBe(false); // every lock let go
  }, 60_000);
});

describe("the one-time move out of the OS store", () => {
  const osStore = (items: Record<string, string>) => {
    const m = new Map(Object.entries(items));
    const backend: SecretsBackend = {
      get: (async ({ name }: { name: string }) => m.get(name) ?? null) as SecretsBackend["get"],
      set: (async ({ name, value }: { name: string; value: string }) => { m.set(name, value); }) as SecretsBackend["set"],
      delete: (async ({ name }: { name: string }) => m.delete(name)) as SecretsBackend["delete"],
    };
    return { m, backend };
  };

  test("what the OS store holds moves into the file, the originals go, and it is done once", async () => {
    const h = home(), keys = memoryVault();
    const { m, backend: from } = osStore({ "harness-token": "t1", "anthropic:default": VALUE, "unrelated": "stays" });
    const b = backendOn(h, keys, { moveFrom: from, names: () => ["harness-token", "anthropic:default", "exa-api-key"], log: () => {} });
    expect(await b.get({ service: SVC, name: "harness-token" })).toBe("t1");
    expect(await b.get({ service: SVC, name: "anthropic:default" })).toBe(VALUE);
    expect([...m.keys()]).toEqual(["unrelated"]); // the moved ones are gone, nothing else was touched
    expect(raw(h).includes(Buffer.from(VALUE))).toBe(false);
    // A value put in the OS store afterwards is not taken again: the move is done.
    m.set("exa-api-key", "late");
    const again = backendOn(h, keys, { moveFrom: from, names: () => ["exa-api-key"], log: () => {} });
    expect(await again.get({ service: SVC, name: "exa-api-key" })).toBeNull();
  });

  test("an OS store that does not answer leaves no note, so the next start tries again", async () => {
    const h = home(), keys = memoryVault();
    const down: SecretsBackend = { get: (async () => { throw new Error("org.freedesktop.DBus.Error.ServiceUnknown"); }) as SecretsBackend["get"], set: (async () => {}) as SecretsBackend["set"], delete: (async () => false) as SecretsBackend["delete"] };
    const b = backendOn(h, keys, { moveFrom: down, names: () => ["harness-token"], log: () => {} });
    expect(await b.get({ service: SVC, name: "harness-token" })).toBeNull();
    const values = new EncryptedFileValues(join(h, SECRETS_FILE_NAME), vaultKey(keys, join(h, SECRETS_FILE_NAME)), "secret-service");
    expect(await values.get(movedMarkKey(SVC))).toBeNull();
    // Back up: the next start moves it.
    const { backend: up } = osStore({ "harness-token": "t2" });
    expect(await backendOn(h, keys, { moveFrom: up, names: () => ["harness-token"], log: () => {} }).get({ service: SVC, name: "harness-token" })).toBe("t2");
  });

  test("safe to stop anywhere: a copy already in the file with the original still in the OS store ends as one item", async () => {
    const h = home(), keys = memoryVault();
    const file = join(h, SECRETS_FILE_NAME);
    const values = new EncryptedFileValues(file, vaultKey(keys, file), "secret-service");
    await values.set(itemKey(SVC, "a"), "same");
    await values.set(itemKey(SVC, "b"), "newer-in-file");
    const { m, backend: from } = osStore({ a: "same", b: "older-in-os-store" });
    const r = await moveOsStoreItems({ values, from, service: SVC, names: ["a", "b"], log: () => {} });
    expect(r).toBe("moved");
    expect(await values.get(itemKey(SVC, "b"))).toBe("newer-in-file"); // the file's value is the one kept
    expect([...m.keys()]).toEqual(["b"]); // the differing original is left, not destroyed
  });

  test("an item that can't be read leaves the move unfinished (no note), the rest moved", async () => {
    const h = home(), keys = memoryVault();
    const file = join(h, SECRETS_FILE_NAME);
    const values = new EncryptedFileValues(file, vaultKey(keys, file), "secret-service");
    const m = new Map([["a", "1"], ["bad", "2"]]);
    const from: SecretsBackend = {
      get: (async ({ name }: { name: string }) => { if (name === "bad") throw new Error("denied"); return m.get(name) ?? null; }) as SecretsBackend["get"],
      set: (async () => {}) as SecretsBackend["set"],
      delete: (async ({ name }: { name: string }) => m.delete(name)) as SecretsBackend["delete"],
    };
    expect(await moveOsStoreItems({ values, from, service: SVC, names: ["a", "bad"], log: () => {} })).toBe("partial");
    expect(await values.get(itemKey(SVC, "a"))).toBe("1");
    expect(await values.get(movedMarkKey(SVC))).toBeNull();
  });
});

describe("the file on the disk", () => {
  test("a private file is the user's alone from its first byte, and replaced whole", async () => {
    const h = home();
    const p = join(h, "x", "secret.bin");
    await writePrivateFile(p, Buffer.from("one"));
    await writePrivateFile(p, Buffer.from("two"));
    expect(readFileSync(p, "utf8")).toBe("two");
    if (process.platform !== "win32") {
      expect(statSync(p).mode & 0o777).toBe(0o600);
      expect(statSync(join(h, "x")).mode & 0o777).toBe(0o700);
    }
    expect(existsSync(`${p}.tmp`)).toBe(false);
  });

  test.skipIf(process.platform !== "win32")("Windows: the ACL is the user's alone, the inherited entries dropped (read back from icacls)", async () => {
    const h = home();
    const p = join(h, "secret.bin");
    await writePrivateFile(p, Buffer.from("x"));
    const out = Bun.spawnSync(["icacls", p]).stdout.toString();
    const entries = out.split(/\r?\n/).map((l) => l.replace(p, "").trim()).filter((l) => /:\(/.test(l));
    const user = Bun.spawnSync(["whoami"]).stdout.toString().trim().toLowerCase().split("\\").pop()!;
    // One entry, the user's, full control: nothing inherited from the folder, no Everyone, Users, Administrators or SYSTEM.
    expect(entries.length).toBe(1);
    expect(entries[0]!.toLowerCase()).toContain(user);
    expect(out).not.toMatch(/Everyone|BUILTIN|NT AUTHORITY/i);
    await lockToOwner(p); // again: idempotent
  });

  test("the lock: one holder at a time; a holder that is gone is taken over; a stuck one makes the writer say so", async () => {
    const h = home();
    const lock = join(h, "run", "secrets-file.lock");
    const order: string[] = [];
    await Promise.all(["a", "b", "c"].map((n) => withSecretsLock(lock, async () => { order.push(`${n}+`); await new Promise((r) => setTimeout(r, 20)); order.push(`${n}-`); })));
    expect(order.filter((_, i) => i % 2 === 0).every((x) => x.endsWith("+"))).toBe(true);
    for (let i = 0; i < order.length; i += 2) expect(order[i]!.slice(0, 1)).toBe(order[i + 1]!.slice(0, 1)); // never interleaved
    // A crashed holder: a pid that is not running.
    mkdirSync(join(h, "run"), { recursive: true });
    const dead = Bun.spawn([process.execPath, "-e", "0"]);
    await dead.exited;
    writeFileSync(lock, `${dead.pid}\n${Date.now()}\n`);
    expect(await withSecretsLock(lock, async () => "took over", 2_000)).toBe("took over");
    // A live holder that is not finishing: the waiter gives up with `locked`.
    writeFileSync(lock, `${process.pid}\n${Date.now()}\n`);
    await expect(withSecretsLock(lock, async () => "never", 150)).rejects.toMatchObject({ code: "locked" });
    // One far older than any write takes, though its pid answers, is judged gone.
    writeFileSync(lock, `${process.pid}\n${Date.now() - LOCK_STALE_MS - 1_000}\n`);
    expect(await withSecretsLock(lock, async () => "old one taken", 2_000)).toBe("old one taken");
    rmSync(h, { recursive: true, force: true });
  });

  test("the contract store and the flat-name store share the file without seeing each other's items", async () => {
    const h = home(), keys = memoryVault();
    const file = join(h, SECRETS_FILE_NAME);
    const contract = new MossSecretStore({ home: h, values: new EncryptedFileValues(file, vaultKey(keys, file), "secret-service"), status: encryptedFileStatus("secret-service") });
    await contract.set({ owner: { kind: "core" }, name: "a" }, "1");
    expect(await backendOn(h, keys).get({ service: SVC, name: "a" })).toBeNull(); // different namespaces
    await backendOn(h, keys).set({ service: SVC, name: "a", value: "2" });
    expect((await contract.get({ owner: { kind: "core" }, name: "a" }))?.value.reveal()).toBe("1");
  });
});

// The REAL OS store: libsecret on a private session bus (Linux, under scripts/with-private-secret-service.sh) or Credential
// Manager under a throwaway service (Windows). The test makes its own service, and removes what it set. Never on macOS (it
// has the Keychain path, tested elsewhere); on a CI Linux runner a missing private bus is a failure, not a skip.
const realStore = process.platform === "darwin" ? "skip" : throwawaySecretStoreAvailable() ? "run" : process.env.CI !== undefined && process.platform === "linux" ? "missing" : "skip";
describe.skipIf(realStore === "skip")("the real OS store holds the key", () => {
  test("a private Secret Service (Linux) or Credential Manager (Windows) is there for this run", () => {
    expect(realStore).toBe("run");
  });

  test("key in the real store: items round-trip across a restart, the key is the one item the store holds, and losing it locks", async () => {
    if (realStore !== "run") return;
    const store = createThrowawaySecretStore({ id: `sf-${process.pid}` });
    const h = home();
    const vault = (): Vault => ({ get: (n) => store.get(n), set: (n, v) => store.set(n, v), delete: (n) => store.delete(n) });
    try {
      const mk = () => fileSecretsBackend({ home: h, service: store.service, os, vault, interactive: false, systemdCreds: null, moveFrom: null });
      await mk().set({ service: store.service, name: "anthropic:default", value: VALUE });
      expect(await store.get("secrets-file-key")).not.toBeNull(); // the key is in the real store
      expect(await store.get("anthropic:default")).toBeNull(); // the item is not
      expect(raw(h).includes(Buffer.from(VALUE))).toBe(false);
      expect(await mk().get({ service: store.service, name: "anthropic:default" })).toBe(VALUE);
      // The recorded key source is the OS store's, not a key file.
      expect(existsSync(join(h, "secrets.key"))).toBe(false);
      await store.delete("secrets-file-key");
      const e = await mk().get({ service: store.service, name: "anthropic:default" }).then(() => undefined, (err: unknown) => err);
      expect((e as ContractError).code).toBe("locked");
      expect(await store.get("secrets-file-key")).toBeNull(); // no key made over the lost one
    } finally {
      await store.dispose();
      rmSync(h, { recursive: true, force: true });
    }
  }, 60_000);

  test("the move reads the real OS store: an item put there as an older build did comes into the file and leaves the store", async () => {
    if (realStore !== "run") return;
    const store = createThrowawaySecretStore({ id: `sf-move-${process.pid}` });
    const h = home();
    const keyVault: Vault = { get: (n) => store.get(`key:${n}`), set: (n, v) => store.set(`key:${n}`, v), delete: (n) => store.delete(`key:${n}`) };
    try {
      await store.set("harness-token", "old-token");
      const from: SecretsBackend = {
        get: (async ({ name }: { name: string }) => store.get(name)) as SecretsBackend["get"],
        set: (async ({ name, value }: { name: string; value: string }) => store.set(name, value)) as SecretsBackend["set"],
        delete: (async ({ name }: { name: string }) => store.delete(name)) as SecretsBackend["delete"],
      };
      const b = fileSecretsBackend({ home: h, service: store.service, os, vault: () => keyVault, interactive: false, systemdCreds: null, moveFrom: from, names: () => ["harness-token"], log: () => {} });
      expect(await b.get({ service: store.service, name: "harness-token" })).toBe("old-token");
      expect(await store.get("harness-token")).toBeNull();
    } finally {
      await store.dispose();
      rmSync(h, { recursive: true, force: true });
    }
  }, 60_000);
});
