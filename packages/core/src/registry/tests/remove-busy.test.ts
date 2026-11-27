// Removing a plugin whose data folder (or anything of it) a process still holds open: the data folder is moved FIRST, tried again briefly, and a
// folder that can't be moved stops the removal with nothing else touched (`DataFolderBusy`). Every later step is tried again on a busy file; one that still
// fails says what was done (`RemovalIncomplete`) and the next attempt finishes from the "removing" mark. The retry and each stage failing run everywhere
// (the failures are injected); the real-process half runs on Windows only.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUSY_TRIES, DataFolderBusy, RemovalIncomplete, busyCodes, forgetRemovedPlugin, hasRemovingMark, pendingRemovals, retryBusy, retryBusyAsync } from "../leftovers";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "moss-busy-"))); temps.push(d); return d; };
const busy = (code: string) => Object.assign(new Error(code), { code });
const noWait = async () => {};
const rec = { id: "busy-plugin", source: "local", treeHash: "sha256:abc", okHash: "sha256:def" } as never;

function world() {
  const home = temp();
  const data = join(home, "plugin-data", "busy-plugin");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "d.txt"), "x");
  mkdirSync(join(home, "settings", "plugins"), { recursive: true });
  const settings = join(home, "settings", "plugins", "busy-plugin.json");
  writeFileSync(settings, "{}");
  return { home, data, settings };
}

describe("retryBusy", () => {
  test("a busy failure is tried again after a wait, and the first success ends it", async () => {
    let calls = 0;
    const waits: number[] = [];
    await retryBusy(() => { if (++calls < 3) throw busy("EBUSY"); }, async (ms) => { waits.push(ms); });
    expect([calls, waits.length]).toEqual([3, 2]);
  });
  test("it gives up after BUSY_TRIES with the last error; another error is thrown at once", async () => {
    let calls = 0;
    await expect(Promise.resolve(retryBusy(() => { calls++; throw busy("EBUSY"); }, noWait))).rejects.toThrow("EBUSY");
    expect(calls).toBe(BUSY_TRIES);
    calls = 0;
    expect(() => retryBusy(() => { calls++; throw busy("ENOENT"); }, noWait)).toThrow("ENOENT");
    expect(calls).toBe(1);
  });
  test("EPERM and EACCES are waited out on Windows only (a permission fault elsewhere is never 'in use')", () => {
    expect([...busyCodes("win32")].sort()).toEqual(["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]);
    expect([...busyCodes("darwin")]).toEqual(["EBUSY"]);
    expect([...busyCodes("linux")]).toEqual(["EBUSY"]);
    let calls = 0;
    expect(() => retryBusy(() => { calls++; throw busy("EPERM"); }, noWait, "darwin")).toThrow("EPERM");
    expect(calls).toBe(1);
  });
  test("the async form retries the same way", async () => {
    let calls = 0;
    await retryBusyAsync(async () => { if (++calls < 2) throw busy("EBUSY"); }, noWait);
    expect(calls).toBe(2);
  });
});

describe("each stage of a removal failing", () => {
  test("the data folder stuck busy: DataFolderBusy, tried BUSY_TRIES times, the folder, settings and keys all still there, no mark", async () => {
    const w = world();
    let tries = 0;
    const err = await forgetRemovedPlugin({ home: w.home, record: rec, children: [], sleep: noWait, platform: "win32", now: () => 1, rename: () => { tries++; throw busy("EPERM"); } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataFolderBusy);
    expect(tries).toBe(BUSY_TRIES);
    expect(existsSync(w.data)).toBe(true);
    expect(existsSync(w.settings)).toBe(true);
    expect(pendingRemovals(w.home)).toEqual([]);
  });

  test("EPERM from the folder step on macOS/Linux is not 'in use': the plain error, no retry", async () => {
    const w = world();
    let tries = 0;
    const err = await forgetRemovedPlugin({ home: w.home, record: rec, children: [], sleep: noWait, platform: "darwin", now: () => 1, rename: () => { tries++; throw busy("EPERM"); } }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(DataFolderBusy);
    expect(tries).toBe(1);
  });

  test("a later step failing: RemovalIncomplete names what was done, the mark stays, and the next attempt finishes", async () => {
    const w = world();
    let fail = true;
    const secrets = { list: async () => [{ ref: "r1" }] as never, delete: async () => { if (fail) throw busy("EBUSY"); return true; } };
    const first = await forgetRemovedPlugin({ home: w.home, record: rec, children: [], secrets, sleep: noWait, now: () => 1 }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(RemovalIncomplete);
    expect((first as RemovalIncomplete).removed).toEqual(["its data folder was moved aside"]);
    expect((first as RemovalIncomplete).message).toContain("Removing it again finishes the job");
    expect(existsSync(w.data)).toBe(false);
    expect(existsSync(w.settings)).toBe(true);
    expect(pendingRemovals(w.home)).toEqual(["busy-plugin"]);
    fail = false;
    const done = await forgetRemovedPlugin({ home: w.home, record: rec, children: [], secrets, sleep: noWait, now: () => 2 });
    expect(done.dataKeptAt).toBeDefined();
    expect(existsSync(w.settings)).toBe(false);
    expect(pendingRemovals(w.home)).toEqual([]);
  });

  test("the settings step failing (a busy file): RemovalIncomplete, then resumed", async () => {
    const w = world();
    // The settings "file" is a non-empty directory on a platform where removal of it without recursion fails (rmSync force on a dir throws).
    rmSync(w.settings, { force: true });
    mkdirSync(w.settings, { recursive: true });
    writeFileSync(join(w.settings, "inner"), "x");
    const err = await forgetRemovedPlugin({ home: w.home, record: rec, children: [], sleep: noWait, now: () => 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemovalIncomplete);
    expect((err as RemovalIncomplete).step).toContain("settings");
    expect(existsSync(w.data)).toBe(false);
    expect(pendingRemovals(w.home)).toEqual(["busy-plugin"]);
    rmSync(w.settings, { recursive: true, force: true });
    const done = await forgetRemovedPlugin({ home: w.home, record: rec, children: [], sleep: noWait, now: () => 2 });
    expect(done.dataKeptAt).toBeDefined();
    expect(pendingRemovals(w.home)).toEqual([]);
  });
});

describe("a stale removing mark", () => {
  const failing = { list: async () => [{ ref: "r1" }] as never, delete: async () => { throw busy("EBUSY"); } };
  const half = async (w: ReturnType<typeof world>, record: never, deleteData: boolean) => forgetRemovedPlugin({ home: w.home, record, children: [], secrets: failing, sleep: noWait, now: () => 1, deleteData }).catch((e: unknown) => e);

  test("a part-way removal that chose 'delete its data', then a reinstall, then a removal that KEEPS data: the new data is kept, never deleted by the old choice", async () => {
    const w = world();
    expect(await half(w, rec, true)).toBeInstanceOf(RemovalIncomplete);
    expect(pendingRemovals(w.home)).toEqual(["busy-plugin"]);
    // The same install comes back (same tree and OK hashes) and holds data again; the user removes it choosing to keep its data.
    mkdirSync(w.data, { recursive: true });
    writeFileSync(join(w.data, "new.txt"), "new");
    const kept = join(w.home, "plugin-data", ".removed", "busy-plugin", "old-set-aside");
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, "older.txt"), "older");
    const out = await forgetRemovedPlugin({ home: w.home, record: rec, children: [], sleep: noWait, now: () => 2, deleteData: false });
    expect(out.dataKeptAt !== undefined && readFileSync(join(out.dataKeptAt, "new.txt"), "utf8")).toBe("new");
    expect(readFileSync(join(kept, "older.txt"), "utf8")).toBe("older");
  });

  test("a mark of another install (different tree hash) is ignored and cleared", async () => {
    const w = world();
    expect(await half(w, rec, false)).toBeInstanceOf(RemovalIncomplete);
    expect(pendingRemovals(w.home)).toEqual(["busy-plugin"]);
    mkdirSync(w.data, { recursive: true });
    writeFileSync(join(w.data, "other.txt"), "other");
    const other = { ...(rec as object), treeHash: "sha256:different", okHash: "sha256:other" } as never;
    const out = await forgetRemovedPlugin({ home: w.home, record: other, children: [], sleep: noWait, now: () => 3 });
    expect(out.dataKeptAt).toBeDefined();
    expect(pendingRemovals(w.home)).toEqual([]);
  });

  test("a mark whose 'kept' lies outside .removed/<id>/ is not used as where the data went", async () => {
    const w = world();
    expect(await half(w, rec, false)).toBeInstanceOf(RemovalIncomplete);
    const mark = join(w.home, "plugin-data", ".removing", "busy-plugin.json");
    const m = JSON.parse(readFileSync(mark, "utf8")) as { kept?: string };
    m.kept = join(temp(), "elsewhere");
    writeFileSync(mark, JSON.stringify(m));
    const out = await forgetRemovedPlugin({ home: w.home, record: rec, children: [], sleep: noWait, now: () => 4 });
    expect(out.dataKeptAt).toBeUndefined();
  });
});

describe("the removing mark's life", () => {
  const failing = { list: async () => [{ ref: "r1" }] as never, delete: async () => { throw busy("EBUSY"); } };

  test("it holds for the same install (switch-on stays refused) and is dropped only once the registry holds a DIFFERENT tree under the id", async () => {
    const w = world();
    await forgetRemovedPlugin({ home: w.home, record: rec, children: [], secrets: failing, sleep: noWait, now: () => 1 }).catch(() => undefined);
    expect(hasRemovingMark(w.home, "busy-plugin", rec as never)).toBe(true);
    expect(hasRemovingMark(w.home, "busy-plugin", rec as never)).toBe(true);
    expect(hasRemovingMark(w.home, "busy-plugin", { treeHash: "sha256:new", okHash: "sha256:new" })).toBe(false);
    expect(pendingRemovals(w.home)).toEqual([]);
  });

  test("a mark that can't be written stops the removal with RemovalIncomplete BEFORE any later step runs", async () => {
    const w = world();
    // A plain file where the marks' folder must be: the mark can't be made.
    writeFileSync(join(w.home, "plugin-data", ".removing"), "not a folder");
    const err = await forgetRemovedPlugin({ home: w.home, record: rec, children: [], sleep: noWait, now: () => 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemovalIncomplete);
    expect((err as RemovalIncomplete).step).toContain("removing mark");
    expect((err as RemovalIncomplete).removed).toEqual(["its data folder was moved aside"]);
    expect(existsSync(w.settings)).toBe(true);
  });
});

describe("a link planted under plugin-data/.removed", () => {
  test.skipIf(process.platform === "win32")("a symlink at .removed/<id> is refused, never followed", async () => {
    const w = world();
    const elsewhere = join(temp(), "target");
    mkdirSync(elsewhere);
    mkdirSync(join(w.home, "plugin-data", ".removed"), { recursive: true });
    symlinkSync(elsewhere, join(w.home, "plugin-data", ".removed", "busy-plugin"));
    await expect(forgetRemovedPlugin({ home: w.home, record: rec, children: [], sleep: noWait, now: () => 1 })).rejects.toThrow("not a plain folder");
    expect(existsSync(w.data)).toBe(true);
    expect(readFileSync(join(w.data, "d.txt"), "utf8")).toBe("x");
  });
});

describe.skipIf(process.platform !== "win32")("a data folder a process holds open (Windows)", () => {
  test("the removal stops with DataFolderBusy and everything else kept; once the process is gone it goes through", async () => {
    const w = world();
    const child = Bun.spawn(["cmd.exe", "/c", "ping -n 60 127.0.0.1 > nul"], { cwd: w.data, stdout: "ignore", stderr: "ignore" });
    try {
      await expect(forgetRemovedPlugin({ home: w.home, record: rec, children: [], sleep: noWait })).rejects.toBeInstanceOf(DataFolderBusy);
      expect(existsSync(w.data)).toBe(true);
      expect(existsSync(w.settings)).toBe(true);
      expect(pendingRemovals(w.home)).toEqual([]);
    } finally {
      child.kill();
      await child.exited;
    }
    const out = await forgetRemovedPlugin({ home: w.home, record: rec, children: [] });
    expect(existsSync(w.data)).toBe(false);
    expect(out.dataKeptAt !== undefined && existsSync(out.dataKeptAt)).toBe(true);
    expect(existsSync(w.settings)).toBe(false);
  });

  test("deleting the data of a plugin whose data folder name is a junction unlinks the junction, never the target's files", async () => {
    const home = temp();
    const target = join(temp(), "precious");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "keep");
    mkdirSync(join(home, "plugin-data"), { recursive: true });
    symlinkSync(target, join(home, "plugin-data", "busy-plugin"), "junction");
    await forgetRemovedPlugin({ home, record: rec, children: [], deleteData: true });
    expect(() => lstatSync(join(home, "plugin-data", "busy-plugin"))).toThrow();
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep");
  });

  test("a junction planted at .removed/<id> is refused (never followed)", async () => {
    const w = world();
    const elsewhere = join(temp(), "target");
    mkdirSync(elsewhere);
    mkdirSync(join(w.home, "plugin-data", ".removed"), { recursive: true });
    symlinkSync(elsewhere, join(w.home, "plugin-data", ".removed", "busy-plugin"), "junction");
    await expect(forgetRemovedPlugin({ home: w.home, record: rec, children: [], sleep: noWait })).rejects.toThrow("not a plain folder");
    expect(existsSync(w.data)).toBe(true);
  });
});
