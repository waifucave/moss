import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptedFileStatus, type SecretRef } from "../../src/contracts/secret-store";
import { DEVICE_KEY_REF, DeviceKey } from "../../src/identity/device-key";
import { EncryptedFileValues, KeychainValues, MossSecretStore, keyFileKey, memoryVault, vaultKey, type ValueBackend } from "../../src/secrets/moss-secret-store";

// The contract store's index (`credentials/index.json`: each item's owner, name, generation and time, never a value) on
// every OS (lane SE). The values are the authority: a damaged, short or missing index never makes a stored value read as
// "nothing there", so nothing that mints on a missing item (the device key, a routine's webhook key) makes a new one over
// the old. A damaged index is read from its previous whole copy; with none, a write or a listing is refused with a plain
// reason and nothing is written over it. The index is written as the secrets file is (owner-only from its first byte,
// flushed, renamed, its previous copy kept), and one writer at a time across this user's processes.

const INDEX = (h: string) => join(h, "credentials", "index.json");
const INDEX_BAK = (h: string) => join(h, "credentials", "index.json.bak");
const MEMORY = { backend: "memory" as const, plaintext: false, state: "unlocked" as const };
const home = () => mkdtempSync(join(tmpdir(), "moss-sidx-"));

/** The two value backends, each reopenable over the same values (a restart): the Keychain's (macOS) and the file's. */
const backends: [string, () => (h: string) => ValueBackend][] = [
  ["the Keychain's values (macOS)", () => { const v = memoryVault(); const values = new KeychainValues(v); return () => values; }],
  ["the encrypted file's values (Windows, Linux)", () => { const keys = memoryVault(); return (h) => new EncryptedFileValues(join(h, "secrets.enc"), vaultKey(keys, join(h, "secrets.enc")), "secret-service"); }],
];

const plugin = (name: string): SecretRef => ({ owner: { kind: "plugin", pluginId: "fish" }, name });

for (const [label, make] of backends) {
  describe(`the index, over ${label}`, () => {
    const world = async () => {
      const h = home();
      const values = make();
      const open = (log?: (line: string) => void) => new MossSecretStore({ home: h, values: values(h), status: MEMORY, ...(log ? { log } : {}) });
      const first = await DeviceKey.loadOrCreate(open());
      await open().set(plugin("FISH_KEY"), "fish-value");
      return { h, open, firstId: first.id };
    };

    test("a fresh home is empty, and its first item makes the index", async () => {
      const h = home();
      const store = new MossSecretStore({ home: h, values: make()(h), status: MEMORY });
      expect(await store.list()).toEqual([]);
      expect(await store.get(plugin("none"))).toBeNull();
      await store.set(plugin("a"), "1");
      expect(existsSync(INDEX(h))).toBe(true);
      expect((await store.list()).map((m) => m.ref.name)).toEqual(["a"]);
    });

    test("an index cut short at any length, or with a byte changed, never hides a stored value: the device key is not made anew", async () => {
      const w = await world();
      const whole = readFileSync(INDEX(w.h));
      const damaged: Buffer[] = [];
      for (let n = 0; n < whole.length; n += Math.max(1, Math.floor(whole.length / 12))) damaged.push(whole.subarray(0, n));
      for (const at of [0, 1, Math.floor(whole.length / 2), whole.length - 1]) { const b = Buffer.from(whole); b[at] = b[at]! ^ 0x5a; damaged.push(b); }
      rmSync(INDEX_BAK(w.h)); // no second copy to fall back on: the values alone answer
      for (const bytes of damaged) {
        writeFileSync(INDEX(w.h), bytes);
        const store = w.open(() => {});
        expect((await DeviceKey.loadOrCreate(store)).id).toBe(w.firstId);
        expect((await store.get(plugin("FISH_KEY")))?.value.reveal()).toBe("fish-value");
      }
    });

    test("a damaged or deleted index is read from its second copy, and said once; the next write puts a whole one back", async () => {
      for (const harm of ["damaged", "missing"] as const) {
        const w = await world();
        expect(existsSync(INDEX_BAK(w.h))).toBe(true);
        if (harm === "damaged") writeFileSync(INDEX(w.h), "{\"version\":1,\"ite"); else rmSync(INDEX(w.h));
        const lines: string[] = [];
        const store = w.open((l) => lines.push(l));
        expect((await store.list()).map((m) => m.ref.name).sort()).toEqual(["FISH_KEY", "device:link-key"]);
        expect((await store.get(plugin("FISH_KEY")))?.generation).toBe(1);
        await store.list();
        expect(lines.length).toBe(1);
        expect(lines[0]).toContain(harm);
        expect(lines[0]).not.toContain("fish-value");
        await store.set(plugin("NEW"), "n");
        expect(JSON.parse(readFileSync(INDEX(w.h), "utf8")).items["plugin:fish/FISH_KEY"].generation).toBe(1);
        expect(readFileSync(INDEX(w.h)).equals(readFileSync(INDEX_BAK(w.h)))).toBe(true);
      }
    });

    test("a damaged index with no second copy refuses a write, a removal and a listing, plainly, and nothing is written over it", async () => {
      const h = home();
      const values = make();
      const store = () => new MossSecretStore({ home: h, values: values(h), status: MEMORY });
      await store().set(plugin("only"), "v");
      rmSync(INDEX_BAK(h)); // the second copy lost too
      writeFileSync(INDEX(h), "{\"version\":1,\"items\":{\"plugin:fish/on");
      const before = readFileSync(INDEX(h));
      await expect(store().set(plugin("other"), "w")).rejects.toMatchObject({ code: "invalid" });
      await expect(store().list()).rejects.toThrow(/index\.json/);
      await expect(store().delete(plugin("only"))).rejects.toMatchObject({ code: "invalid" });
      expect(readFileSync(INDEX(h)).equals(before)).toBe(true);
      // The value is still there to read.
      expect((await store().get(plugin("only")))?.value.reveal()).toBe("v");
    });

    test("an index deleted after one was made: the values still read, the device key is the same, and a write or listing is refused", async () => {
      const w = await world();
      rmSync(INDEX(w.h));
      rmSync(INDEX_BAK(w.h), { force: true });
      const store = w.open();
      expect((await DeviceKey.loadOrCreate(store)).id).toBe(w.firstId);
      await expect(store.list()).rejects.toMatchObject({ code: "locked" });
      await expect(store.set(plugin("x"), "y")).rejects.toMatchObject({ code: "locked" });
    });

    test("a crash after the value was written and before the index: the value reads, and nothing is made over it", async () => {
      const h = home();
      const values = make();
      // What a crash between the two writes leaves: the device key's value, no entry in the index.
      await new MossSecretStore({ home: h, values: values(h), status: MEMORY }).set(plugin("seed"), "s"); // an index exists
      const key = (await import("../../src/identity/keys")).generateEd25519();
      await values(h).set("device/device:link-key", key.seed().reveal());
      const store = new MossSecretStore({ home: h, values: values(h), status: MEMORY });
      const got = await store.get(DEVICE_KEY_REF);
      expect(got?.value.reveal()).toBe(key.seed().reveal());
      expect((await DeviceKey.loadOrCreate(store)).id).toBe((await DeviceKey.fromKey(key)).id);
    });
  });
}

describe("the index on the disk", () => {
  test("owner-only, no half-made copy beside it, and no value in it", async () => {
    const h = home();
    const store = new MossSecretStore({ home: h, values: make0(h), status: MEMORY });
    await store.set(plugin("a"), "value-a-123");
    await store.set(plugin("b"), "value-b-456");
    for (const f of [INDEX(h), INDEX_BAK(h)]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/value-[ab]/);
      if (process.platform !== "win32") expect(statSync(f).mode & 0o777).toBe(0o600);
    }
    expect(readdirSync(join(h, "credentials")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("separate processes writing through the contract store at once lose no item from the index", async () => {
    const h = home();
    const file = join(h, "secrets.enc");
    const mk = () => new MossSecretStore({ home: h, values: new EncryptedFileValues(file, keyFileKey(join(h, "secrets.key"), file), "key-file"), status: encryptedFileStatus("key-file") });
    await mk().set(plugin("seed"), "s"); // the key and the first index exist before the writers start
    const writer = join(import.meta.dir, "fixtures", "index-writer.ts");
    const kids = ["a", "b", "c", "d"].map((tag) => Bun.spawn([process.execPath, writer, h, tag, "10"], { stdout: "ignore", stderr: "pipe" }));
    const codes = await Promise.all(kids.map((k) => k.exited));
    expect(codes).toEqual([0, 0, 0, 0]);
    const names = (await mk().list()).map((m) => m.ref.name);
    for (const tag of ["a", "b", "c", "d"]) for (let i = 0; i < 10; i++) expect([tag, i, names.includes(`${tag}-${i}`)]).toEqual([tag, i, true]);
    for (const tag of ["a", "b", "c", "d"]) for (let i = 0; i < 10; i++) expect((await mk().get({ owner: { kind: "core" }, name: `${tag}-${i}` }))?.generation).toBe(1);
  }, 60_000);
});

function make0(h: string): ValueBackend {
  return new EncryptedFileValues(join(h, "secrets.enc"), vaultKey(memoryVault(), join(h, "secrets.enc")), "secret-service");
}
