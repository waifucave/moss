// The real world's "a host may be alive" rule on an OS with no lock: the kept-app mark, or a recorded pid still running.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineHostWorld } from "../world";

const make = (home: string, appKept?: boolean) => engineHostWorld({ home, os: "linux", profile: "dist", release: "1.0.0", run: async () => ({ ok: true, out: "" }), dist: true, testBuild: true, env: {}, stopHost: () => false, startFailed: () => {}, ...(appKept ? { appKept } : {}) });

test("no kept app and no recorded host: none alive; a recorded live pid or a kept app: may be", () => {
  const home = mkdtempSync(join(tmpdir(), "host-alive-"));
  try {
    expect(make(home).mayHostBeAlive?.()).toBe(false);
    expect(make(home, true).mayHostBeAlive?.()).toBe(true);
    const w = make(home);
    w.noteHost?.(process.pid);
    expect(w.mayHostBeAlive?.()).toBe(true);
    writeFileSync(join(home, "host.pid"), "2147483646");
    expect(w.mayHostBeAlive?.()).toBe(false);
    writeFileSync(join(home, "host.pid"), "garbage");
    expect(w.mayHostBeAlive?.()).toBe(false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
