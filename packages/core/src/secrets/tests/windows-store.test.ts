// Windows only: the secrets file store as the daemon uses it, each step timed and bounded, so a call that never answers is
// named (the moss unit's plugin.auth.list gave no answer in 15 s on the runner).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSecretsBackend } from "../file-backend";

const within = async <T>(what: string, ms: number, p: Promise<T>): Promise<T> => {
  const t0 = Date.now();
  const r = await Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what}: no answer in ${ms} ms`)), ms))]);
  console.log(`[windows-store] ${what}: ${Date.now() - t0} ms`);
  return r;
};

describe.skipIf(process.platform !== "win32")("the secrets store on Windows", () => {
  test("the raw OS store answers set, get and delete", async () => {
    const svc = `com.waifucave.moss.core.test.winstore-${process.pid}`;
    await within("Bun.secrets.set", 20_000, Bun.secrets.set({ service: svc, name: "probe", value: "dummy123" }));
    expect(await within("Bun.secrets.get", 20_000, Bun.secrets.get({ service: svc, name: "probe" }))).toBe("dummy123");
    expect(await within("Bun.secrets.delete", 20_000, Bun.secrets.delete({ service: svc, name: "probe" }))).toBe(true);
  });
  test("the file store opens, writes and reads back", async () => {
    const home = mkdtempSync(join(tmpdir(), "moss-store-"));
    const b = fileSecretsBackend({ home, service: `com.waifucave.moss.core.test.winfile-${process.pid}`, moveFrom: null, log: (l) => console.log(`[windows-store] log: ${l}`) });
    expect(await within("get of a missing item", 30_000, b.get({ service: "x", name: "a" }))).toBeNull();
    await within("set", 30_000, b.set({ service: "x", name: "a", value: "dummy123" }));
    expect(await within("get", 30_000, b.get({ service: "x", name: "a" }))).toBe("dummy123");
  });
});
