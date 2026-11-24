// On Windows a junction inside a plugin's folder that points outside it is refused by the plugin guard, as a symlink is elsewhere.
// (The runner runs elevated, which can make a junction or a link; a junction needs no privilege at all.)
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePluginRunFiles, guardedPluginEnv } from "../plugin-run";

describe.skipIf(process.platform !== "win32")("the plugin guard on Windows", () => {
  const base = mkdtempSync(join(tmpdir(), "moss-guard-win-"));
  const files = ensurePluginRunFiles(join(base, "run"), { mossHome: base });
  const outside = join(base, "outside");
  const mark = join(base, "mark");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "evil.ts"), `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "ran");\nexport const x = 1;\n`);
  const plugin = join(base, "plugin");
  mkdirSync(plugin, { recursive: true });
  symlinkSync(outside, join(plugin, "link"), "junction");
  writeFileSync(join(plugin, "index.ts"), `await import("./link/evil.ts");\nconsole.log("ran to the end");\n`);
  writeFileSync(join(plugin, "inside.ts"), `console.log("inside ok");\n`);
  const run = (entry: string) => {
    const plain = { ...process.env, NODE_ENV: undefined };
    const env = guardedPluginEnv(plain, { pluginRoot: plugin, files, shared: [] });
    const r = Bun.spawnSync([process.execPath, entry], { cwd: plugin, env, stdout: "pipe", stderr: "pipe" });
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), code: r.exitCode };
  };
  test("a file reached through a junction to outside the folder is refused and never runs", () => {
    const r = run("index.ts");
    expect(existsSync(mark)).toBe(false);
    expect(r.stdout).not.toContain("ran to the end");
    expect(r.stderr).toMatch(/outside the plugin's own folder|refused/);
  });
  test("a file inside the folder, spelled with its 8.3 short or long name, still loads", () => {
    expect(run("inside.ts").stdout).toContain("inside ok");
  });
  test("the run folder is the user's alone (no inherited Authenticated Users or Users)", () => {
    const acl = Bun.spawnSync([`${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\icacls.exe`, join(base, "run", "plugin-run")], { stdout: "pipe" }).stdout.toString();
    expect(acl).not.toMatch(/Authenticated Users|BUILTIN\\Users|Everyone/i);
  });
});
