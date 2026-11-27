// Removing a plugin whose data folder a process still holds open (Windows): the rename into .removed is tried again briefly, and a removal that
// can't move the folder stops with nothing else forgotten. The retry is pure; the real-folder half runs on Windows only.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUSY_TRIES, forgetRemovedPlugin, retryBusy } from "../leftovers";

const temps: string[] = [];
afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });
const temp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), "moss-busy-"))); temps.push(d); return d; };
const busy = (code: string) => Object.assign(new Error(code), { code });

describe("retryBusy", () => {
  test("a busy failure is tried again after a wait, and the first success ends it", async () => {
    let calls = 0;
    const waits: number[] = [];
    await retryBusy(() => { if (++calls < 3) throw busy("EBUSY"); }, async (ms) => { waits.push(ms); });
    expect([calls, waits.length]).toEqual([3, 2]);
  });
  test("it gives up after BUSY_TRIES with the last error; another error is thrown at once", async () => {
    let calls = 0;
    await expect(Promise.resolve(retryBusy(() => { calls++; throw busy("EPERM"); }, async () => {}))).rejects.toThrow("EPERM");
    expect(calls).toBe(BUSY_TRIES);
    calls = 0;
    expect(() => retryBusy(() => { calls++; throw busy("ENOENT"); }, async () => {})).toThrow("ENOENT");
    expect(calls).toBe(1);
  });
});

describe.skipIf(process.platform !== "win32")("a data folder a process holds open (Windows)", () => {
  const rec = { id: "busy-plugin", source: "local", treeHash: "sha256:abc", okHash: "sha256:def" } as never;
  test("the removal stops with the folder, the settings and the keys still there; once the process is gone it goes through", async () => {
    const home = temp();
    const data = join(home, "plugin-data", "busy-plugin");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "d.txt"), "x");
    mkdirSync(join(home, "settings", "plugins"), { recursive: true });
    const settings = join(home, "settings", "plugins", "busy-plugin.json");
    writeFileSync(settings, "{}");
    // A process whose working directory is the data folder holds it open.
    const child = Bun.spawn(["cmd.exe", "/c", "ping -n 60 127.0.0.1 > nul"], { cwd: data, stdout: "ignore", stderr: "ignore" });
    try {
      await expect(forgetRemovedPlugin({ home, record: rec, children: [], sleep: async () => {} })).rejects.toMatchObject({ code: expect.stringMatching(/^(EBUSY|EPERM|EACCES)$/) });
      expect(existsSync(data)).toBe(true);
      expect(existsSync(settings)).toBe(true);
    } finally {
      child.kill();
      await child.exited;
    }
    const out = await forgetRemovedPlugin({ home, record: rec, children: [] });
    expect(existsSync(data)).toBe(false);
    expect(out.dataKeptAt !== undefined && existsSync(out.dataKeptAt)).toBe(true);
    expect(existsSync(settings)).toBe(false);
  });
});
