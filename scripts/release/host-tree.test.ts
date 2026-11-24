// The background host on Windows and Linux (the release wave, lane RP; spec §3.1: each app carries the engine AND the host): MOSS carries
// MOSS Code's app as `resources/host/moss-host[.exe]`, laid out by apps/moss/scripts/host-helper.mjs and held by two-apps.ts's
// `hostTreeProblems`. Run on real folders (a stand-in Electron tree), both ways: a good layout, and each way it can be wrong.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error a plain .mjs, imported for its pure helper
import { carryHostTree, CODE_EXECUTABLE, HOST_TREE_DIR as LAYOUT_DIR, HOST_TREE_FROM_ENV } from "../../apps/moss/scripts/host-helper.mjs";
import { engineFile } from "./lib";
import { HOST_TREE_DIR, hostExecutableName, hostTreeProblems } from "./two-apps";

/** A stand-in for MOSS Code's unpacked app on `platform`: its executable, Electron's files, its app.asar and the engine and tree. */
function unpackedCode(root: string, platform: "linux" | "win32"): string {
  const dir = join(root, platform === "win32" ? "win-unpacked" : "linux-unpacked");
  mkdirSync(join(dir, "resources", "daemon"), { recursive: true });
  mkdirSync(join(dir, "resources", "plugins", "moss"), { recursive: true });
  mkdirSync(join(dir, "locales"));
  writeFileSync(join(dir, CODE_EXECUTABLE[platform]), "electron");
  chmodSync(join(dir, CODE_EXECUTABLE[platform]), 0o755);
  writeFileSync(join(dir, "chrome-sandbox"), "sandbox");
  writeFileSync(join(dir, "icudtl.dat"), "icu");
  writeFileSync(join(dir, "locales", "en-US.pak"), "pak");
  writeFileSync(join(dir, "resources", "app.asar"), "MOSS Code's main process");
  writeFileSync(join(dir, "resources", "apparmor-profile"), "profile");
  writeFileSync(join(dir, "resources", "daemon", engineFile("linux")), "engine");
  writeFileSync(join(dir, "resources", "plugins", "moss", "moss.json"), "{}");
  return dir;
}

describe("carryHostTree (MOSS's afterPack on Windows and Linux)", () => {
  test("the layout and the checks agree on one folder name, and the env var is the one the build sets", () => {
    expect(LAYOUT_DIR).toBe(HOST_TREE_DIR);
    expect(HOST_TREE_FROM_ENV).toBe("MOSS_HOST_TREE_FROM");
    expect(hostExecutableName("win")).toBe("moss-host.exe");
    expect(hostExecutableName("linux-x64")).toBe("moss-host");
  });

  for (const [platform, os] of [["linux", "linux-x64"], ["win32", "win"]] as const) {
    test(`${platform}: MOSS Code's whole app is carried as the host, without the engine or the tree, and the checks pass`, () => {
      const work = mkdtempSync(join(tmpdir(), "moss-host-tree-"));
      try {
        const code = unpackedCode(work, platform);
        const moss = join(work, "moss-resources");
        mkdirSync(moss);
        const exe = carryHostTree({ resourcesDir: moss, from: code, platform });
        expect(exe).toBe(join(moss, "host", hostExecutableName(os)));
        // Electron's files and the app's own code come with it; the executable is renamed, the original name is gone.
        for (const f of ["icudtl.dat", "locales/en-US.pak", "resources/app.asar", "chrome-sandbox"]) expect(existsSync(join(moss, "host", f)), f).toBe(true);
        expect(existsSync(join(moss, "host", CODE_EXECUTABLE[platform]))).toBe(false);
        // Not copied twice: the engine, the bundled tree and MOSS Code's AppArmor profile are MOSS's own beside it.
        for (const f of ["resources/daemon", "resources/plugins", "resources/apparmor-profile"]) expect(existsSync(join(moss, "host", f)), f).toBe(false);
        if (platform !== "win32") expect(statSync(exe!).mode & 0o111).not.toBe(0);
        expect(hostTreeProblems({ os, codeResources: join(code, "resources"), mossResources: moss })).toEqual([]);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  }

  test("a folder with no MOSS Code in it carries nothing (the build refuses it by name)", () => {
    const work = mkdtempSync(join(tmpdir(), "moss-host-tree-"));
    try {
      expect(carryHostTree({ resourcesDir: work, from: join(work, "nothing"), platform: "linux" })).toBeUndefined();
      expect(carryHostTree({ resourcesDir: work, from: work, platform: "darwin" })).toBeUndefined();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test("a symlink in the tree stays a symlink (verbatim), never followed out of it", () => {
    const work = mkdtempSync(join(tmpdir(), "moss-host-tree-"));
    try {
      const code = unpackedCode(work, "linux");
      symlinkSync("/etc/hostname", join(code, "libvk.so"));
      const moss = join(work, "moss-resources");
      mkdirSync(moss);
      carryHostTree({ resourcesDir: moss, from: code, platform: "linux" });
      expect(readFileSync(join(moss, "host", "icudtl.dat"), "utf8")).toBe("icu");
      expect(lstatSync(join(moss, "host", "libvk.so")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(moss, "host", "libvk.so"))).toBe("/etc/hostname");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("hostTreeProblems: each way MOSS's host can be wrong", () => {
  function good(platform: "linux" | "win32") {
    const work = mkdtempSync(join(tmpdir(), "moss-host-tree-"));
    const code = unpackedCode(work, platform);
    const moss = join(work, "moss-resources");
    mkdirSync(moss);
    carryHostTree({ resourcesDir: moss, from: code, platform });
    return { work, codeResources: join(code, "resources"), mossResources: moss, os: platform === "win32" ? ("win" as const) : ("linux-x64" as const) };
  }

  test("no host at all: a MOSS-only install would have none to start", () => {
    const g = good("linux");
    try {
      rmSync(join(g.mossResources, "host"), { recursive: true });
      expect(hostTreeProblems(g)).toEqual([`MOSS carries no host: ${join(g.mossResources, "host", "moss-host")} is missing (a MOSS-only install would have no host to start)`]);
    } finally { rmSync(g.work, { recursive: true, force: true }); }
  });

  test("a host that runs different code from MOSS Code's own", () => {
    const g = good("win32");
    try {
      writeFileSync(join(g.mossResources, "host", "resources", "app.asar"), "another main process");
      expect(hostTreeProblems(g).join("\n")).toContain("different code from MOSS Code's own");
      rmSync(join(g.mossResources, "host", "resources", "app.asar"));
      expect(hostTreeProblems(g).join("\n")).toContain("holds no resources/app.asar");
    } finally { rmSync(g.work, { recursive: true, force: true }); }
  });

  test("a second copy of the engine or the tree inside the host", () => {
    const g = good("linux");
    try {
      mkdirSync(join(g.mossResources, "host", "resources", "daemon"));
      mkdirSync(join(g.mossResources, "host", "resources", "plugins"));
      expect(hostTreeProblems(g)).toEqual([
        "MOSS's host tree holds its own resources/daemon: the engine and the bundled tree are MOSS's own, never copied twice",
        "MOSS's host tree holds its own resources/plugins: the engine and the bundled tree are MOSS's own, never copied twice",
      ]);
    } finally { rmSync(g.work, { recursive: true, force: true }); }
  });
});
