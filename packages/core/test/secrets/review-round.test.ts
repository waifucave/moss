import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractError } from "../../src/contracts/common";
import { encryptedFileStatus, type SecretRef } from "../../src/contracts/secret-store";
import { DeviceKey } from "../../src/identity/device-key";
import { fileSecretsBackend } from "../../src/secrets/file-backend";
import { EncryptedFileValues, MossSecretStore, chooseFileStore, memoryVault, vaultKey } from "../../src/secrets/moss-secret-store";
import { setSecretStatForTests, withSecretsLock, type PrivateFileStep } from "../../src/secrets/private-file";

// The adversarial review of lane SE's first round (2026-11-24): each fix with the test that failed before it.

const home = () => mkdtempSync(join(tmpdir(), "moss-review-"));
const MAIN = (h: string) => join(h, "secrets.enc");
const BAK = (h: string) => join(h, "credentials", "secrets.enc.bak");
const MEMORY = { backend: "memory" as const, plaintext: false, state: "unlocked" as const };
const ref = (name: string): SecretRef => ({ owner: { kind: "plugin", pluginId: "fish" }, name });

/** A contract store over the encrypted file, its key in one in-memory vault for the home; `crashAt` throws at that step
 *  of the next write's file writes (a crash there: nothing after it runs). */
function fileWorld() {
  const h = home();
  const keys = memoryVault();
  let crashAt: { step: PrivateFileStep; n: number } | undefined;
  const step = (s: PrivateFileStep) => { if (crashAt && s === crashAt.step && --crashAt.n === 0) { crashAt = undefined; throw new Error("crash"); } };
  const open = () => new MossSecretStore({ home: h, values: new EncryptedFileValues(MAIN(h), vaultKey(keys, MAIN(h)), "secret-service", undefined, { step, log: () => {} }), status: MEMORY, log: () => {} });
  return { h, keys, open, crash: (s: PrivateFileStep, n = 1) => { crashAt = { step: s, n }; } };
}

/** Each way the copies can be harmed later: one damaged or gone, or both. */
function harms(h: string): (() => void)[] {
  const cut = (p: string) => () => { if (existsSync(p)) writeFileSync(p, readFileSync(p).subarray(0, 20)); };
  const gone = (p: string) => () => rmSync(p, { force: true });
  return [() => {}, cut(MAIN(h)), gone(MAIN(h)), cut(BAK(h)), gone(BAK(h)), () => { cut(MAIN(h))(); cut(BAK(h))(); }];
}

const readsAs = async (store: MossSecretStore, r: SecretRef): Promise<string | null | "error"> =>
  store.get(r).then((v) => v?.value.reveal() ?? null, () => "error");

describe("blocker 1: a removed secret never comes back, from any copy", () => {
  test("set X, set Y, remove X, then harm either copy or both: X is never read again, and a later write never folds it back", async () => {
    for (let i = 0; i < harms("/x").length; i++) {
      const w = fileWorld();
      await w.open().set(ref("X"), "x-removed");
      await w.open().set(ref("Y"), "y-kept");
      expect(await w.open().delete(ref("X"))).toBe(true);
      harms(w.h)[i]!();
      expect([i, await readsAs(w.open(), ref("X"))]).not.toEqual([i, "x-removed"]);
      await w.open().set(ref("Z"), "z").catch(() => undefined); // a later write, wherever it reads from
      for (const h of harms(w.h)) { h(); expect([i, await readsAs(w.open(), ref("X"))]).not.toEqual([i, "x-removed"]); }
    }
  });

  test("a crash at every step of the removing write: either the removal never returned (X may stay), or no copy holds X", async () => {
    const steps: PrivateFileStep[] = ["created", "locked", "written", "file-flushed", "renamed", "rename-flushed"];
    for (const s of steps) for (const n of [1, 2, 3, 4]) {
      const w = fileWorld();
      await w.open().set(ref("X"), "x-removed");
      await w.open().set(ref("Y"), "y-kept");
      w.crash(s, n);
      const removed = await w.open().delete(ref("X")).then(() => true, () => false);
      if (!removed) continue; // the removal threw: it never happened, X may still be read
      for (const h of harms(w.h)) { h(); expect([s, n, await readsAs(w.open(), ref("X"))]).not.toEqual([s, n, "x-removed"]); }
    }
  });

  test("generated sequences of writes, removals, crashes and harmed copies: a key removed (and not written since) is never read again", async () => {
    const names = ["A", "B", "C"];
    const steps: PrivateFileStep[] = ["created", "locked", "written", "file-flushed", "renamed", "rename-flushed"];
    for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
      let s = seed >>> 0;
      const rnd = (n: number) => { s = (s * 1103515245 + 12345) >>> 0; return (s >>> 8) % n; };
      const w = fileWorld();
      const removed = new Map<string, Set<string>>(); // name -> values it held before its removal
      const ever = new Map<string, string[]>();
      for (let step = 0; step < 80; step++) {
        const name = names[rnd(names.length)]!;
        const op = rnd(8);
        if (op <= 2) {
          const v = `${name}-${seed}-${step}`;
          if (rnd(4) === 0) w.crash(steps[rnd(steps.length)]!, 1 + rnd(3));
          const ok = await w.open().set(ref(name), v).then(() => true, () => false);
          if (ok) { removed.delete(name); ever.set(name, [...(ever.get(name) ?? []), v]); }
        } else if (op <= 4) {
          if (rnd(3) === 0) w.crash(steps[rnd(steps.length)]!, 1 + rnd(3));
          const ok = await w.open().delete(ref(name)).then((had) => had, () => false);
          if (ok) removed.set(name, new Set(ever.get(name) ?? []));
        } else if (op === 5) harms(w.h)[1 + rnd(4)]!();
        else if (op === 6) { /* a restart: nothing kept in memory */ }
        else harms(w.h)[5]!();
        for (const [n, olds] of removed) {
          const got = await readsAs(w.open(), ref(n));
          expect([seed, step, n, typeof got === "string" && olds.has(got)]).toEqual([seed, step, n, false]);
        }
      }
    }
  }, 60_000);
});

describe("should-fix 2: a file that can't be looked at now is locked, never absent", () => {
  afterEach(() => setSecretStatForTests(undefined));
  for (const code of ["EACCES", "EIO"]) {
    test(`a stat that fails with ${code}: the device key is not made anew, and nothing is written`, async () => {
      const w = fileWorld();
      const first = await DeviceKey.loadOrCreate(w.open());
      const before = readFileSync(MAIN(w.h));
      const keysBefore = [...w.keys.items.entries()];
      setSecretStatForTests((p) => { if (p.endsWith("secrets.enc") || p.includes("credentials")) throw Object.assign(new Error(code), { code }); });
      const e = await DeviceKey.loadOrCreate(w.open()).then(() => undefined, (err: unknown) => err);
      expect((e as ContractError).code).toBe("locked");
      expect(String((e as Error).message)).toContain(code);
      setSecretStatForTests(undefined);
      expect(readFileSync(MAIN(w.h)).equals(before)).toBe(true);
      expect([...w.keys.items.entries()]).toEqual(keysBefore);
      expect((await DeviceKey.loadOrCreate(w.open())).id).toBe(first.id);
    });

    test(`${code} at start: the store opens locked with the reason, never as a new store`, async () => {
      const h = home();
      const keys = memoryVault();
      await fileSecretsBackend({ home: h, service: "svc", os: "linux", vault: () => keys, moveFrom: null, interactive: false, systemdCreds: null }).set({ service: "svc", name: "a", value: "1" });
      setSecretStatForTests((p) => { if (p.endsWith("secrets.enc")) throw Object.assign(new Error(code), { code }); });
      const c = await chooseFileStore({ home: h, service: "svc", os: "linux", vault: () => keys, interactive: false, systemdCreds: null });
      expect(c.locked).toContain(code);
      const b = fileSecretsBackend({ home: h, service: "svc", os: "linux", vault: () => keys, moveFrom: null, interactive: false, systemdCreds: null });
      await expect(b.get({ service: "svc", name: "a" })).rejects.toMatchObject({ code: "locked" });
    });
  }
});

describe("should-fixes 3 and 5: the lock", () => {
  test("a lock dated in the future, held by a pid that answers, is judged stale at once", async () => {
    const h = home();
    const lock = join(h, "run", "x.lock");
    mkdirSync(join(h, "run"), { recursive: true });
    writeFileSync(lock, `${process.pid}\n9999999999999\n`);
    const started = Date.now();
    expect(await withSecretsLock(lock, async () => "taken", 2_000)).toBe("taken");
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test("a holder renews its lock while it works, so a long hold (a keyring prompt) is never taken over", async () => {
    const h = home();
    const lock = join(h, "run", "x.lock");
    const times: number[] = [];
    await withSecretsLock(lock, async () => {
      for (let i = 0; i < 5; i++) { times.push(Number(readFileSync(lock, "utf8").split("\n")[1])); await new Promise((r) => setTimeout(r, 60)); }
    }, 2_000, 40);
    expect(times[times.length - 1]!).toBeGreaterThan(times[0]!);
  });

  test("a holder whose lock was taken over removes only its own: the new holder's lock stays", async () => {
    const h = home();
    const lock = join(h, "run", "x.lock");
    const theirs = `${process.pid}\n${Date.now()}\nsomeone-else\n`;
    await withSecretsLock(lock, async () => { writeFileSync(lock, theirs); });
    expect(readFileSync(lock, "utf8")).toBe(theirs);
  });
});

describe("should-fix 4: two processes on a fresh home make one key, not two", () => {
  const minter = join(import.meta.dir, "fixtures", "key-minter.ts");
  for (const what of ["device", "tokens"] as const) {
    test(`${what === "device" ? "the device key (contract store)" : "the pairing tokens (flat-name store)"}: every process gets the same`, async () => {
      for (let round = 0; round < 3; round++) {
        const h = home();
        const kids = [0, 1, 2, 3].map(() => Bun.spawn([process.execPath, minter, h, what], { stdout: "pipe", stderr: "pipe" }));
        const outs = await Promise.all(kids.map(async (k) => { const o = await new Response(k.stdout).text(); expect(await k.exited).toBe(0); return o; }));
        expect(outs[0]!.length).toBeGreaterThan(0);
        expect(new Set(outs).size).toBe(1);
      }
    }, 60_000);
  }
});
