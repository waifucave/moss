import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeychainSecretStore } from "../../src/auth/secret-store";
import { TokenAuthority } from "../../src/auth/tokens";
import { fileSecretsBackend, itemKey, movedMarkKey, moveOsStoreItems, type SecretsBackend } from "../../src/secrets/file-backend";
import { EncryptedFileValues, memoryVault, secretDisk, vaultKey, type Vault } from "../../src/secrets/moss-secret-store";
import { writePrivateFile, type PrivateFileStep } from "../../src/secrets/private-file";
import { SECRETS_BACKUP_SEGMENTS, SECRETS_FILE_NAME, SECRETS_MADE_SEGMENTS } from "../../src/secrets/secret-files";

// Durability, the lost-file rules and the move's order (lane SF's fix round, the reviewer's blocker and should-fixes).
// What a test can show of a power cut: the durable steps are made and made in the right order (the calls, in order); a
// crash injected between any two steps of a write, and of the move, leaves every secret readable from one place; and a
// file that a power cut left short, empty or changed is read from the previous whole file, never answered as "empty".
// Throwaway homes and in-memory vaults only.

const home = () => mkdtempSync(join(tmpdir(), "moss-sfd-"));
const SVC = "svc";
const VALUE = ["sk", "dur", Math.random().toString(36).slice(2)].join("-");
const quiet = () => {};

const fileOf = (h: string) => join(h, SECRETS_FILE_NAME);
const bakOf = (h: string) => join(h, ...SECRETS_BACKUP_SEGMENTS);
const madeOf = (h: string) => join(h, ...SECRETS_MADE_SEGMENTS);
const valuesOn = (h: string, keys: Vault, step?: (n: PrivateFileStep, d?: string) => void, log: (l: string) => void = quiet) =>
  new EncryptedFileValues(fileOf(h), vaultKey(keys, fileOf(h)), "secret-service", undefined, { log, ...(step ? { step } : {}) });

class Crash extends Error {}

/** Every file under `dir`, relative, recursively. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base)); else out.push(p.slice(base.length + 1));
  }
  return out;
}

describe("a write is on the disk before it counts as saved", () => {
  test("the calls made, in order: made private, written, the file flushed, then the rename, then the rename flushed", async () => {
    const h = home();
    const steps: string[] = [];
    const target = join(h, "x.bin");
    const tmpDir = join(h, "run");
    let tmpWhileHalfMade: string[] = [];
    await writePrivateFile(target, "data", {
      tmpDir,
      step: (n, d) => {
        steps.push(d === undefined ? n : `${n}:${d}`);
        if (n === "written") tmpWhileHalfMade = [...readdirSync(tmpDir), ...readdirSync(h).filter((f) => f.endsWith(".tmp"))];
      },
    });
    expect(steps.slice(0, 4)).toEqual(["created", "locked", "written", "file-flushed"]);
    // Linux and macOS: fsync of the folder after the rename; Windows: FlushFileBuffers on the renamed file (no folder can be flushed there).
    expect(steps.slice(4)).toEqual(["renamed", "rename-flushed"]);
    // The half-made copy lived in the run folder, never beside the file under a name no deny list knows.
    expect(tmpWhileHalfMade.length).toBe(1);
    expect(readdirSync(h).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readdirSync(tmpDir)).toEqual([]); // and is gone
    expect(readFileSync(target, "utf8")).toBe("data");
  });

  test("a store's write makes its second copy the new file first, then the file, then the note that a file was made", async () => {
    const h = home(), keys = memoryVault();
    await valuesOn(h, keys).set("a", "1");
    const steps: string[] = [];
    await valuesOn(h, keys, (n) => steps.push(n)).set("a", "2");
    // Two files this time (the second copy, then the file); the note already exists. Both are the new file.
    const one = ["created", "locked", "written", "file-flushed", "renamed", "rename-flushed"];
    expect(steps).toEqual([...one, ...one]);
    expect(readFileSync(bakOf(h)).equals(readFileSync(fileOf(h)))).toBe(true);
    expect(existsSync(madeOf(h))).toBe(true);
    expect(readdirSync(join(h, "run")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readdirSync(h).filter((f) => f.includes(".tmp"))).toEqual([]);
  });

  test("a crash between any two steps of a write leaves the old whole file or the new whole file, and every secret readable", async () => {
    // Count the steps of one write over an existing file.
    const probe = home(), pk = memoryVault();
    await valuesOn(probe, pk).set("a", "old");
    let total = 0;
    await valuesOn(probe, pk, () => { total++; }).set("a", "new");
    expect(total).toBeGreaterThan(8);
    for (let crashAt = 0; crashAt < total; crashAt++) {
      const h = home(), keys = memoryVault();
      await valuesOn(h, keys).set("a", "old");
      await valuesOn(h, keys).set("b", "kept");
      let n = 0;
      const crashing = valuesOn(h, keys, () => { if (n++ === crashAt) throw new Crash(`crash at step ${crashAt}`); });
      await expect(crashing.set("a", "new")).rejects.toThrow(Crash);
      const after = valuesOn(h, keys);
      const a = await after.get("a");
      expect([crashAt, ["old", "new"].includes(a ?? "")]).toEqual([crashAt, true]);
      expect([crashAt, await after.get("b")]).toEqual([crashAt, "kept"]);
      await after.set("a", "again"); // and the store goes on
      expect(await valuesOn(h, keys).get("a")).toBe("again");
      rmSync(h, { recursive: true, force: true });
    }
  });
});

describe("a file a power cut left short, empty or changed is not the end of the road", () => {
  const seeded = async () => {
    const h = home(), keys = memoryVault();
    const v = valuesOn(h, keys);
    await v.set(itemKey(SVC, "harness-token"), "tok-1");
    await v.set(itemKey(SVC, "harness-token"), "tok-2"); // secrets.enc and its second copy both hold tok-2 (lane SE: the copy is the NEW file, so a replaced value never comes back)
    return { h, keys };
  };

  test("truncated at every length and with one byte changed anywhere, the previous whole file is read, and said", async () => {
    const { h, keys } = await seeded();
    const whole = readFileSync(fileOf(h));
    const cases: [string, Buffer][] = [["empty", Buffer.alloc(0)]];
    for (const len of [1, 2, 14, 30, 45, whole.length - 1]) cases.push([`cut at ${len}`, whole.subarray(0, len)]);
    for (const at of [0, 1, 5, 20, 33, whole.length - 1]) { const b = Buffer.from(whole); b[at] = b[at]! ^ 0xff; cases.push([`byte ${at} changed`, b]); }
    for (const [name, bytes] of cases) {
      writeFileSync(fileOf(h), bytes);
      const lines: string[] = [];
      const got = await valuesOn(h, keys, undefined, (l) => lines.push(l)).get(itemKey(SVC, "harness-token"));
      expect([name, got]).toEqual([name, "tok-2"]); // the second copy's value: the latest, never the one it replaced
      expect(lines.length).toBe(1);
      expect(lines[0]).not.toContain("tok-");
    }
    // The next write puts a whole file back, and the previous copy is not the damaged one.
    await valuesOn(h, keys).set(itemKey(SVC, "harness-token"), "tok-3");
    expect(await valuesOn(h, keys).get(itemKey(SVC, "harness-token"))).toBe("tok-3");
  });

  test("a header byte naming no key source is damage and is read from the previous copy; one naming another real source is the downgrade rule: locked", async () => {
    const { h, keys } = await seeded();
    const whole = readFileSync(fileOf(h));
    expect(whole[1]).toBe(2); // secret-service
    const unknown = Buffer.from(whole); unknown[1] = 0x7f;
    writeFileSync(fileOf(h), unknown);
    expect(await valuesOn(h, keys).get(itemKey(SVC, "harness-token"))).toBe("tok-2");
    const other = Buffer.from(whole); other[1] = 4; // key-file: a file claiming another (weaker) source is not "damaged"
    writeFileSync(fileOf(h), other);
    await expect(valuesOn(h, keys).get(itemKey(SVC, "harness-token"))).rejects.toMatchObject({ code: "locked" });
  });

  test("damaged with no previous copy is an error, never an empty store", async () => {
    const h = home(), keys = memoryVault();
    await valuesOn(h, keys).set("a", "1");
    rmSync(bakOf(h)); // the second copy lost too (every write makes one since lane SE)
    const whole = readFileSync(fileOf(h));
    for (const bytes of [Buffer.alloc(0), whole.subarray(0, whole.length - 3), Buffer.concat([whole.subarray(0, 40), Buffer.from([whole[40]! ^ 1]), whole.subarray(41)])]) {
      writeFileSync(fileOf(h), bytes);
      await expect(valuesOn(h, keys).get("a")).rejects.toMatchObject({ code: "invalid" });
      await expect(valuesOn(h, keys).set("b", "2")).rejects.toMatchObject({ code: "invalid" }); // and nothing is written over it
      expect(readFileSync(fileOf(h)).equals(bytes)).toBe(true);
    }
  });

  test("the flat store, opened on an empty or short file, reads the previous copy too (the header is read from it)", async () => {
    const { h, keys } = await seeded();
    const open = () => fileSecretsBackend({ home: h, service: SVC, os: "linux", vault: () => keys, moveFrom: null, log: quiet });
    for (const bytes of [Buffer.alloc(0), Buffer.from([2]), readFileSync(fileOf(h)).subarray(0, 20)]) {
      writeFileSync(fileOf(h), bytes);
      expect(await open().get({ service: SVC, name: "harness-token" })).toBe("tok-2");
    }
    // With no previous copy the same file is locked, not empty.
    rmSync(bakOf(h));
    writeFileSync(fileOf(h), Buffer.alloc(0));
    await expect(open().get({ service: SVC, name: "harness-token" })).rejects.toMatchObject({ code: "locked" });
  });
});

describe("a secrets file deleted while its key is still there is never a quiet new store", () => {
  test("gone with its previous copy: read from it and put back; gone with none: locked until the person chooses", async () => {
    const h = home(), keys = memoryVault();
    const open = () => fileSecretsBackend({ home: h, service: SVC, os: "linux", vault: () => keys, moveFrom: null, log: quiet });
    await open().set({ service: SVC, name: "harness-token", value: "t1" });
    await open().set({ service: SVC, name: "harness-token", value: "t2" });
    rmSync(fileOf(h));
    expect(await open().get({ service: SVC, name: "harness-token" })).toBe("t2"); // the second copy: the latest
    await open().set({ service: SVC, name: "harness-token", value: "t3" });
    expect(existsSync(fileOf(h))).toBe(true);

    rmSync(fileOf(h)); rmSync(bakOf(h));
    const keyBefore = keys.items.get("secrets-file-key");
    for (const call of [
      () => open().get({ service: SVC, name: "harness-token" }),
      () => open().set({ service: SVC, name: "x", value: "y" }),
      () => new TokenAuthority(new KeychainSecretStore(open(), SVC)).ensureTokens(),
    ]) {
      const e = await call().then(() => undefined, (err: unknown) => err);
      expect((e as { code?: string }).code).toBe("locked");
      expect(String((e as Error).message)).toContain("secrets.enc");
    }
    expect(existsSync(fileOf(h))).toBe(false); // no new empty store was made
    expect(keys.items.get("secrets-file-key")).toBe(keyBefore);
    // The person's choice: the note deleted, an empty store.
    rmSync(madeOf(h));
    expect(await open().get({ service: SVC, name: "harness-token" })).toBeNull();
  });

  test("a key made and a crash before the first file: the next start is the first start, not a lost file", async () => {
    const h = home(), keys = memoryVault();
    keys.items.set("secrets-file-key", Buffer.alloc(32, 7).toString("base64"));
    const b = fileSecretsBackend({ home: h, service: SVC, os: "linux", vault: () => keys, moveFrom: null, log: quiet });
    await b.set({ service: SVC, name: "a", value: VALUE });
    expect(await b.get({ service: SVC, name: "a" })).toBe(VALUE);
  });
});

describe("the one-time move: order, crashes, and the pairing tokens", () => {
  const osStore = (items: Record<string, string>, onDelete?: (name: string) => void) => {
    const m = new Map(Object.entries(items));
    const backend: SecretsBackend = {
      get: (async ({ name }: { name: string }) => m.get(name) ?? null) as SecretsBackend["get"],
      set: (async ({ name, value }: { name: string; value: string }) => { m.set(name, value); }) as SecretsBackend["set"],
      delete: (async ({ name }: { name: string }) => { onDelete?.(name); return m.delete(name); }) as SecretsBackend["delete"],
    };
    return { m, backend };
  };

  test("an original is deleted from the OS store only after the file holding it is durable (the calls, in order)", async () => {
    const h = home(), keys = memoryVault();
    const events: string[] = [];
    const values = valuesOn(h, keys, (n, d) => events.push(`file:${d === undefined ? n : `${n}:${d}`}`));
    const { backend: from } = osStore({ a: "1", b: "2" }, (name) => events.push(`os-delete:${name}`));
    expect(await moveOsStoreItems({ values, from, service: SVC, names: ["a", "b"], log: quiet })).toBe("moved");
    const firstDelete = events.findIndex((e) => e.startsWith("os-delete:"));
    expect(firstDelete).toBeGreaterThan(0);
    expect(events[firstDelete - 1]).toBe("file:rename-flushed"); // the file's rename was flushed right before
    expect(events.slice(0, firstDelete).filter((e) => e === "file:file-flushed").length).toBeGreaterThanOrEqual(1);
    // One write of the file for both items (one hold), then the two deletes, then the note's own write.
    expect(events.filter((e) => e.startsWith("os-delete:")).length).toBe(2);
    expect(events.slice(0, firstDelete).filter((e) => e === "file:created").length).toBe(3); // the second copy, the new file, and the note that one was made
  });

  test("a crash between any two steps of the move leaves every secret readable from the file or the OS store, and the next start finishes", async () => {
    const run = async (crashAt: number | null) => {
      const h = home(), keys = memoryVault();
      let n = 0, dead = false, armed = true;
      // A crash is the process gone: once it has happened, every later step throws too (the move's own catches can't carry on).
      const tick = () => { if (armed && (dead || n++ === crashAt)) { dead = true; throw new Crash(`crash at ${crashAt}`); } };
      const values = valuesOn(h, keys, tick);
      const os = osStore({ a: "1", b: "2" }, tick);
      const done = await moveOsStoreItems({ values, from: os.backend, service: SVC, names: ["a", "b"], log: quiet }).then((r) => r === "moved", (e: unknown) => { if (e instanceof Crash) return false; throw e; }); // finished, or the process died
      armed = false; // the process is restarted: the same disk and OS store, no crash
      return { h, keys, os, steps: n, done };
    };
    const reference = await run(null);
    expect(reference.done).toBe(true);
    const total = reference.steps;
    expect(total).toBeGreaterThan(10);
    for (let crashAt = 0; crashAt < total; crashAt++) {
      const c = await run(crashAt);
      expect([crashAt, c.done]).toEqual([crashAt, false]);
      const after = valuesOn(c.h, c.keys);
      for (const [name, want] of [["a", "1"], ["b", "2"]] as const) {
        const inFile = await after.get(itemKey(SVC, name));
        const inOs = c.os.m.get(name) ?? null;
        expect([crashAt, name, inFile === want || inOs === want]).toEqual([crashAt, name, true]); // readable from one place
        expect([crashAt, name, inFile === null || inFile === want]).toEqual([crashAt, name, true]); // and never a wrong value
      }
      // The next start finishes it: both in the file, none left in the OS store, the note written.
      expect(await moveOsStoreItems({ values: after, from: c.os.backend, service: SVC, names: ["a", "b"], log: quiet })).toMatch(/moved|nothing|done-before/);
      expect([crashAt, await after.get(itemKey(SVC, "a")), await after.get(itemKey(SVC, "b"))]).toEqual([crashAt, "1", "2"]);
      expect([...c.os.m.keys()]).toEqual([]);
      expect(await after.get(movedMarkKey(SVC))).not.toBeNull();
      rmSync(c.h, { recursive: true, force: true });
    }
  });

  test("a daemon and a CLI starting together never write an older OS value over a newer one: one hold reads the file again", async () => {
    const h = home(), keys = memoryVault();
    const racer = valuesOn(h, keys);
    // The OS store answers the move's read of `a` with the old value while another process writes the new one.
    let raced = false;
    const { m, backend } = osStore({ a: "old-from-os" });
    const from: SecretsBackend = {
      ...backend,
      get: (async ({ name }: { name: string }) => {
        const v = m.get(name) ?? null;
        if (name === "a" && !raced) { raced = true; await racer.set(itemKey(SVC, "a"), "newer-in-file"); }
        return v;
      }) as SecretsBackend["get"],
    };
    expect(await moveOsStoreItems({ values: valuesOn(h, keys), from, service: SVC, names: ["a"], log: quiet })).toBe("nothing"); // nothing of the older value was taken
    expect(await valuesOn(h, keys).get(itemKey(SVC, "a"))).toBe("newer-in-file");
    expect(m.get("a")).toBe("old-from-os"); // the differing original is left, the file's value is the one kept
  });

  test("two backends moving at once end with the items once in the file and none in the OS store", async () => {
    const h = home(), keys = memoryVault();
    const { m, backend: from } = osStore({ "harness-token": "t1", "admin-token": "t2" });
    const open = () => fileSecretsBackend({ home: h, service: SVC, os: "linux", vault: () => keys, moveFrom: from, names: () => ["harness-token", "admin-token"], log: quiet });
    const [x, y] = await Promise.all([open().get({ service: SVC, name: "harness-token" }), open().get({ service: SVC, name: "admin-token" })]);
    expect([x, y]).toEqual(["t1", "t2"]);
    expect([...m.keys()]).toEqual([]);
  });

  test("the OS store silent: no pairing token is made, one plain note is logged, and the old tokens are the ones kept once it answers", async () => {
    const h = home(), keys = memoryVault();
    let answers = false;
    const { backend: real } = osStore({ "harness-token": "old-1", "admin-token": "old-2", "remote-token": "old-3" });
    let probes = 0;
    const from: SecretsBackend = { ...real, get: (async (a: { service: string; name: string }) => { probes++; if (!answers) throw new Error("the collection is locked"); return real.get(a); }) as SecretsBackend["get"] };
    const lines: string[] = [];
    const open = () => fileSecretsBackend({ home: h, service: `${SVC}-silent`, os: "linux", vault: () => keys, moveFrom: from, log: (l) => lines.push(l) });
    const b = open();
    const store = new KeychainSecretStore(b, `${SVC}-silent`);
    const e = await new TokenAuthority(store).ensureTokens().then(() => undefined, (err: unknown) => err);
    expect((e as { code?: string }).code).toBe("locked");
    expect(existsSync(fileOf(h)) ? readFileSync(fileOf(h)).length : 0).toBe(0); // nothing was minted into a file
    expect(lines.filter((l) => l.includes("isn't answering")).length).toBe(1); // said once, plainly
    const after = probes;
    await expect(b.get({ service: `${SVC}-silent`, name: "harness-token" })).rejects.toMatchObject({ code: "locked" });
    expect(probes).toBe(after); // not asked again within the retry window: no wait on every call
    expect(lines.filter((l) => l.includes("isn't answering")).length).toBe(1);
    // A name the move can never have held is not blocked by it.
    answers = true;
    const next = open();
    const tokens = await new TokenAuthority(new KeychainSecretStore(next, `${SVC}-silent`)).ensureTokens();
    expect(Object.values(tokens)).toEqual(expect.arrayContaining(["old-1", "old-2", "old-3"]));
  });

  test("a name the move may still find is not deleted while the OS store is silent: it would come back into the file at the next start", async () => {
    const h = home(), keys = memoryVault();
    let answers = false;
    const { backend: real, m } = osStore({ "remote-token": "still-in-keyring" });
    const from: SecretsBackend = { ...real, get: (async (a: { service: string; name: string }) => { if (!answers) throw new Error("the collection is locked"); return real.get(a); }) as SecretsBackend["get"] };
    const open = () => fileSecretsBackend({ home: h, service: `${SVC}-del`, os: "linux", vault: () => keys, moveFrom: from, names: () => ["remote-token", "admin-token"], log: quiet });
    const b = open();
    await expect(b.delete({ service: `${SVC}-del`, name: "remote-token" })).rejects.toMatchObject({ code: "locked" });
    // A name outside the move's list is deleted as usual, and a set still works.
    await b.set({ service: `${SVC}-del`, name: "exa-api-key", value: "k" });
    expect(await b.delete({ service: `${SVC}-del`, name: "exa-api-key" })).toBe(true);
    answers = true;
    expect(await open().get({ service: `${SVC}-del`, name: "remote-token" })).toBe("still-in-keyring");
    expect(m.size).toBe(0);
  });

  test("no Secret Service at all (a headless computer): nothing to move, and nothing waits", async () => {
    const h = home();
    // A vault that errors as libsecret does with no bus: the file's key goes to a key file, and the OS store is absent.
    const absent: Vault = {
      get: async () => null,
      set: async () => { throw new Error("org.freedesktop.DBus.Error.ServiceUnknown: The name was not provided by any .service files"); },
      delete: async () => false,
    };
    const down: SecretsBackend = { get: (async () => { throw new Error("org.freedesktop.DBus.Error.ServiceUnknown"); }) as SecretsBackend["get"], set: (async () => {}) as SecretsBackend["set"], delete: (async () => false) as SecretsBackend["delete"] };
    const b = fileSecretsBackend({ home: h, service: `${SVC}-absent`, os: "linux", vault: () => absent, interactive: false, systemdCreds: null, moveFrom: down, names: () => ["harness-token"], log: quiet });
    expect(await b.get({ service: `${SVC}-absent`, name: "harness-token" })).toBeNull();
    const tokens = await new TokenAuthority(new KeychainSecretStore(b, `${SVC}-absent`)).ensureTokens();
    expect(Object.keys(tokens).length).toBeGreaterThan(0);
  });
});

describe("what is on the disk", () => {
  test("no clear value anywhere in the home: not in the file, the previous copy, the note, the run folder or any leftover", async () => {
    const h = home(), keys = memoryVault();
    const b = fileSecretsBackend({ home: h, service: SVC, os: "linux", vault: () => keys, moveFrom: null, log: quiet });
    for (let i = 0; i < 3; i++) await b.set({ service: SVC, name: "anthropic:default", value: `${VALUE}-${i}` });
    await b.set({ service: SVC, name: "mcp-oauth:x", value: JSON.stringify({ access_token: VALUE }) });
    const files = walk(h);
    expect(files).toEqual(expect.arrayContaining([SECRETS_FILE_NAME, join(...SECRETS_BACKUP_SEGMENTS), join(...SECRETS_MADE_SEGMENTS)]));
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const clear = [VALUE, Buffer.from(VALUE).toString("base64"), Buffer.from(VALUE).toString("hex"), "access_token", "anthropic:default"];
    for (const f of files) {
      const bytes = readFileSync(join(h, f));
      for (const needle of clear) expect([f, bytes.includes(Buffer.from(needle))]).toEqual([f, false]);
    }
    // And the key is not in the home either (it is in the vault).
    const key = Buffer.from(keys.items.get("secrets-file-key")!, "base64");
    for (const f of files) expect([f, readFileSync(join(h, f)).includes(key)]).toEqual([f, false]);
    if (process.platform !== "win32") for (const f of files) expect([f, statSync(join(h, f)).mode & 0o077]).toEqual([f, 0]);
  });

  test("the key file and the sealed credential are made in the run folder first and flushed, as the file is", async () => {
    const h = home();
    mkdirSync(join(h, "run"), { recursive: true });
    const { keyFileKey } = await import("../../src/secrets/moss-secret-store");
    const k = await keyFileKey(join(h, "secrets.key"), fileOf(h))();
    expect(k.length).toBe(32);
    expect(readdirSync(h).filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(readdirSync(join(h, "run")).filter((f) => f.includes(".tmp"))).toEqual([]);
    expect(secretDisk(fileOf(h)).tmpDir).toBe(join(h, "run"));
    if (process.platform !== "win32") expect(statSync(join(h, "secrets.key")).mode & 0o777).toBe(0o600);
    truncateSync(join(h, "secrets.key"), 5);
    await expect(keyFileKey(join(h, "secrets.key"), fileOf(h))()).rejects.toMatchObject({ code: "invalid" }); // a short key is damaged, never used
  });
});
