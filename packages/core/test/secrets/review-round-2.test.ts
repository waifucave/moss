import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptedFileStatus, type SecretRef } from "../../src/contracts/secret-store";
import type { ApiCallContext } from "../../src/plugin-host/api/router";
import { keysApi } from "../../src/plugin-host/api/keys";
import { EncryptedFileValues, MossSecretStore, memoryVault, vaultKey } from "../../src/secrets/moss-secret-store";
import { setWindowsAclForTests, withSecretsLock, writePrivateFile, type PrivateFileStep } from "../../src/secrets/private-file";

// The second review of lane SE (2026-11-24): each fix with the test that failed before it.

const home = () => mkdtempSync(join(tmpdir(), "moss-review2-"));
const MAIN = (h: string) => join(h, "secrets.enc");
const BAK = (h: string) => join(h, "credentials", "secrets.enc.bak");
const MEMORY = { backend: "memory" as const, plaintext: false, state: "unlocked" as const };
const ref = (name: string): SecretRef => ({ owner: { kind: "plugin", pluginId: "fish" }, name });

function fileWorld() {
  const h = home();
  const keys = memoryVault();
  let crashAt: { step: PrivateFileStep; n: number } | undefined;
  const step = (s: PrivateFileStep) => { if (crashAt && s === crashAt.step && --crashAt.n === 0) { crashAt = undefined; throw new Error("crash"); } };
  const values = () => new EncryptedFileValues(MAIN(h), vaultKey(keys, MAIN(h)), "secret-service", undefined, { step, log: () => {} });
  const open = () => new MossSecretStore({ home: h, values: values(), status: encryptedFileStatus("secret-service"), log: () => {} });
  return { h, keys, values, open, crash: (s: PrivateFileStep, n = 1) => { crashAt = { step: s, n }; } };
}

const cut = (p: string) => { if (existsSync(p)) writeFileSync(p, readFileSync(p).subarray(0, 20)); };
const readsAs = async (store: MossSecretStore, r: SecretRef): Promise<string | null | "error"> =>
  store.get(r).then((v) => v?.value.reveal() ?? null, () => "error");

describe("1: a plugin's sealing key is made once, even by two first calls at once", () => {
  test("two concurrent first keys.publicKey calls for one name get the same key, and it is the one kept", async () => {
    for (let round = 0; round < 5; round++) {
      const w = fileWorld();
      const api = keysApi({ secrets: w.open() });
      const ctx = { pluginId: "moss.forwarder" } as ApiCallContext;
      const [a, b, c] = await Promise.all([0, 1, 2].map(() => api["keys.publicKey"]!(ctx, ["hooks"]) as Promise<Uint8Array>));
      expect(Buffer.from(a!).equals(Buffer.from(b!))).toBe(true);
      expect(Buffer.from(a!).equals(Buffer.from(c!))).toBe(true);
      const later = await keysApi({ secrets: w.open() })["keys.publicKey"]!(ctx, ["hooks"]) as Uint8Array;
      expect(Buffer.from(later).equals(Buffer.from(a!))).toBe(true);
    }
  });
});

describe("2: a holder taken over while paused never writes over the new holder", () => {
  test("the file's lock taken over mid-write: the write is refused (locked) and the file is the new holder's, untouched", async () => {
    const w = fileWorld();
    await w.values().set("a", "1");
    const before = readFileSync(MAIN(w.h));
    const bakBefore = readFileSync(BAK(w.h));
    const lock = join(w.h, "run", "secrets-file.lock");
    // The change runs under the lock; meanwhile (the holder paused past the stale limit) another process took it over.
    const r = await w.values().mutate((all) => { writeFileSync(lock, `${process.pid}\n${Date.now()}\nthe-new-holder\n`); all.a = "stale"; return true; })
      .then(() => "written", (e: { code?: string }) => e.code);
    expect(r).toBe("locked");
    expect(readFileSync(MAIN(w.h)).equals(before)).toBe(true);
    expect(readFileSync(BAK(w.h)).equals(bakBefore)).toBe(true);
    expect(readFileSync(lock, "utf8")).toContain("the-new-holder"); // the new holder's lock, left alone
    rmSync(lock);
    expect(await w.values().get("a")).toBe("1");
  });

  test("the index's lock taken over mid-write: neither the item nor its index is written", async () => {
    const w = fileWorld();
    await w.open().set(ref("K"), "1");
    const lock = join(w.h, "run", "secrets-index.lock");
    const index = readFileSync(join(w.h, "credentials", "index.json"));
    const real = w.values();
    // The item's write begins after another process took the index's lock over (this one paused past the limit).
    const values = { get: (k: string) => real.get(k), delete: (k: string) => real.delete(k), set: async (k: string, v: string) => { writeFileSync(lock, `${process.pid}\n${Date.now()}\nsomeone\n`); await real.set(k, v); } };
    const store = new MossSecretStore({ home: w.h, values, status: MEMORY, log: () => {} });
    const r = await store.set(ref("K"), "2").then(() => "written", (e: { code?: string }) => e.code);
    expect(r).toBe("locked");
    expect(readFileSync(lock, "utf8")).toContain("someone");
    rmSync(lock);
    expect(await readsAs(w.open(), ref("K"))).toBe("1");
    expect(readFileSync(join(w.h, "credentials", "index.json")).equals(index)).toBe(true);
  });

  test("work started inside a lock and running after its release is not refused (the held-lock check ends with the hold)", async () => {
    const h = home();
    const lock = join(h, "run", "x.lock");
    let later: Promise<unknown> = Promise.resolve();
    await withSecretsLock(lock, async () => {
      // A watcher kicked off inside the hold, writing after it ends (the store's change listeners, the index's note).
      later = new Promise((r) => setTimeout(r, 30)).then(() => writePrivateFile(join(h, "after.txt"), "after"));
    });
    await expect(later).resolves.toBeUndefined();
    expect(readFileSync(join(h, "after.txt"), "utf8")).toBe("after");
  });

  test("a renewed lock is renamed into place: no renewal file is left, and the lock reads whole throughout", async () => {
    const h = home();
    const lock = join(h, "run", "x.lock");
    const seen: string[] = [];
    await withSecretsLock(lock, async () => {
      for (let i = 0; i < 20; i++) { seen.push(readFileSync(lock, "utf8")); await new Promise((r) => setTimeout(r, 15)); }
    }, 2_000, 10);
    for (const t of seen) expect(t.split("\n").length).toBe(4); // pid, time, nonce, and the final newline: never half a lock
    expect(new Set(seen).size).toBeGreaterThan(1); // renewed
    expect(readdirSync(join(h, "run")).filter((n) => n.endsWith(".renew"))).toEqual([]);
  });
});

describe("3: a replaced value never comes back from the copy", () => {
  test("set X=old, set X=new, then the file damaged or gone: X reads new, never old", async () => {
    for (const harm of ["cut", "gone"] as const) {
      const w = fileWorld();
      await w.open().set(ref("X"), "old-value");
      await w.open().set(ref("X"), "new-value");
      if (harm === "cut") cut(MAIN(w.h)); else rmSync(MAIN(w.h));
      expect(await readsAs(w.open(), ref("X"))).toBe("new-value");
    }
  });

  test("generated sequences of writes, rotations, removals, crashes at any step and harmed copies: a value replaced or removed by a write that returned is never read again", async () => {
    setWindowsAclForTests(process.platform === "win32" ? async () => {} : undefined);
    try {
    const names = ["A", "B"];
    const steps: PrivateFileStep[] = ["created", "locked", "written", "file-flushed", "renamed", "rename-flushed"];
    for (const seed of [21, 22, 23, 24, 25, 26, 27, 28, 29, 30]) {
      let s = seed >>> 0;
      const rnd = (n: number) => { s = (s * 1103515245 + 12345) >>> 0; return (s >>> 8) % n; };
      const w = fileWorld();
      // Per name: every value a write tried, and which are superseded (a later write of that name returned).
      const tried = new Map<string, string[]>();
      const superseded = new Map<string, Set<string>>();
      const settle = (name: string) => { superseded.set(name, new Set([...(superseded.get(name) ?? []), ...(tried.get(name) ?? [])])); tried.set(name, []); };
      for (let step = 0; step < 100; step++) {
        const name = names[rnd(names.length)]!;
        const op = rnd(9);
        if (op <= 4) { // a write, often a rotation of the same name
          const v = `${name}-${seed}-${step}`;
          if (rnd(3) === 0) w.crash(steps[rnd(steps.length)]!, 1 + rnd(3));
          tried.set(name, [...(tried.get(name) ?? []), v]);
          const ok = await w.open().set(ref(name), v).then(() => true, () => false);
          if (ok) { settle(name); tried.set(name, [v]); superseded.get(name)!.delete(v); }
        } else if (op <= 6) {
          if (rnd(3) === 0) w.crash(steps[rnd(steps.length)]!, 1 + rnd(3));
          const ok = await w.open().delete(ref(name)).then((had) => had, () => false);
          if (ok) settle(name);
        } else if (op === 7) { if (rnd(2) === 0) cut(MAIN(w.h)); else rmSync(MAIN(w.h), { force: true }); }
        else { if (rnd(2) === 0) cut(BAK(w.h)); else rmSync(BAK(w.h), { force: true }); }
        for (const n of names) {
          const got = await readsAs(w.open(), ref(n));
          expect([seed, step, n, typeof got === "string" && (superseded.get(n)?.has(got) ?? false)]).toEqual([seed, step, n, false]);
        }
      }
    }
    } finally { setWindowsAclForTests(undefined); }
  }, 60_000);
});
