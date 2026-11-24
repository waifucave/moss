// Homebrew and winget for BOTH apps, from the artifact table (scripts/release/package-managers.ts): the file each cask and each winget
// installer points at is the table's file for that app, so a rename in electron-builder.yml and the table cannot leave a package manager
// downloading a file that is not there.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderWinget, WINGET_PACKAGE, wingetInstallerUrl } from "../winget";
import { APP_KEYS, installersOf } from "./artifacts";
import { caskDmg, CASKS, renderCask, renderPackageManagers, wingetExe } from "./package-managers";

const ROOT = join(import.meta.dir, "..", "..");
const VERSION = "1.111.1";
const SHA = "ab".repeat(32);
const shaOf = (name: string): string => (name.endsWith(".dmg") ? SHA : "cd".repeat(32));

describe("the casks", () => {
  for (const app of APP_KEYS) {
    test(`${app}: the cask downloads the table's dmg for ${app}, and its token and bundle are the app's`, () => {
      const text = readFileSync(join(ROOT, CASKS[app].template), "utf8");
      // The template says `#{version}` for Ruby to fill in; expanding it must give the table's name for this app.
      const url = /url "([^"]+)"/.exec(text)![1]!.replace("#{version}", VERSION).replace("#{version}", VERSION);
      expect(url).toBe(`https://github.com/waifucave/moss/releases/download/v${VERSION}/${caskDmg(VERSION, app)}`);
      expect<string | undefined>(caskDmg(VERSION, app)).toBe(installersOf(VERSION, "mac", app).find((n) => n.endsWith(".dmg")));
      expect(text).toContain(`cask "${CASKS[app].token}" do`);
      expect(text).toContain(`app "${app === "moss" ? "MOSS" : "MOSS Code"}.app"`);
    });
  }

  test("two casks never link one command: only MOSS Code's links `moss`", () => {
    expect(readFileSync(join(ROOT, CASKS.code.template), "utf8")).toMatch(/^\s*binary .*target: "moss"/m);
    expect(readFileSync(join(ROOT, CASKS.moss.template), "utf8")).not.toMatch(/^\s*binary /m);
  });

  test("renderCask fills version and sha, and refuses what isn't one", () => {
    const out = renderCask(readFileSync(join(ROOT, CASKS.moss.template), "utf8"), VERSION, SHA);
    expect(out).toContain(`version "${VERSION}"`);
    expect(out).toContain(`sha256 "${SHA}"`);
    expect(() => renderCask("x", "1.2", SHA)).toThrow(/N\.N\.N/);
    expect(() => renderCask("x", VERSION, "zz")).toThrow(/sha256/);
    expect(() => renderCask("{{other}}", VERSION, SHA)).toThrow(/slot/);
  });
});

describe("winget", () => {
  for (const app of APP_KEYS) {
    test(`${app}: three manifests of its own package, pointing at the table's installer`, () => {
      const manifests = renderWinget(ROOT, { version: VERSION, url: wingetInstallerUrl(VERSION, app), sha256: SHA, releaseDate: "2026-12-01" }, app);
      expect(Object.keys(manifests).sort()).toEqual([`${WINGET_PACKAGE[app]}.installer.yaml`, `${WINGET_PACKAGE[app]}.locale.en-US.yaml`, `${WINGET_PACKAGE[app]}.yaml`]);
      for (const [name, text] of Object.entries(manifests)) {
        expect(text, name).toContain(`PackageIdentifier: ${WINGET_PACKAGE[app]}\n`);
        expect(text, name).not.toContain("{{");
      }
      const installer = Bun.YAML.parse(manifests[`${WINGET_PACKAGE[app]}.installer.yaml`]!) as { Installers: Array<{ InstallerUrl: string }> };
      expect(installer.Installers[0]!.InstallerUrl).toBe(`https://github.com/waifucave/moss/releases/download/v${VERSION}/${wingetExe(VERSION, app)}`);
      expect<string | undefined>(wingetExe(VERSION, app)).toBe(installersOf(VERSION, "win", app)[0]);
    });
  }

  test("the two packages differ in identifier and name, and only one holds the `moss` moniker", () => {
    expect(WINGET_PACKAGE.code).not.toBe(WINGET_PACKAGE.moss);
    const monikers = APP_KEYS.map((app) => /^Moniker: (.*)$/m.exec(renderWinget(ROOT, { version: VERSION, url: wingetInstallerUrl(VERSION, app), sha256: SHA, releaseDate: "2026-12-01" }, app)[`${WINGET_PACKAGE[app]}.locale.en-US.yaml`]!)?.[1]);
    expect(monikers.filter((m) => m !== undefined)).toEqual(["moss"]);
  });
});

test("renderPackageManagers renders every file of both apps from the release's own installers", () => {
  const seen: string[] = [];
  const files = renderPackageManagers(ROOT, VERSION, "2026-12-01", (n) => { seen.push(n); return shaOf(n); });
  expect(Object.keys(files).sort()).toEqual([
    "casks/moss-code.rb", "casks/moss.rb",
    "winget/waifucave.MOSS.installer.yaml", "winget/waifucave.MOSS.locale.en-US.yaml", "winget/waifucave.MOSS.yaml",
    "winget/waifucave.MOSSCode.installer.yaml", "winget/waifucave.MOSSCode.locale.en-US.yaml", "winget/waifucave.MOSSCode.yaml",
  ]);
  // Each sha is that file's: the dmg for the casks, the NSIS installer for winget, of the right app.
  expect(seen.sort()).toEqual([...installersOf(VERSION, "mac", "code").slice(0, 1), ...installersOf(VERSION, "win", "code"), ...installersOf(VERSION, "mac", "moss").slice(0, 1), ...installersOf(VERSION, "win", "moss")].sort());
  expect(files["casks/moss.rb"]).toContain(`sha256 "${SHA}"`);
});
