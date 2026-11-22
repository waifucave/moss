// The artifact table (scripts/release/artifacts.ts): what a release holds, in one place, and the checks that keep every builder and
// reader to it. The two directions the release wave asks for: a file built but not in the table, and a file in the table that nothing
// builds, each a failing test (and, at the end of every build, a failing build: `builtArtifactProblems`).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEED_NAME } from "../../packages/update-feed/src/index";
import { LINUX_FORMATS, LINUX_PACKAGES } from "../build-packages";
import {
  APP_BUILD, APP_KEYS, appArtifacts, appFeedFile, appOfInstaller, BUILD_BYPRODUCTS, builtArtifactProblems, CHANNELS, engineArtifacts, expandTemplate, expectedArtifacts, INSTALLER_ROWS,
  installerName, installersOf, kindsOf, linuxPackageOf, RELEASE_OSES, type AppKey, type InstallerRow, type ReleaseOs,
} from "./artifacts";
import { writeReleaseFixture } from "./fixture";
import { engineFile } from "./lib";

const ROOT = join(import.meta.dir, "..", "..");
const config = (app: AppKey): Record<string, any> => Bun.YAML.parse(readFileSync(join(ROOT, APP_BUILD[app].config), "utf8")) as Record<string, any>;
const VERSION = "1.2.3";

describe("the table against each app's electron-builder.yml (a builder and the table cannot drift)", () => {
  for (const app of APP_KEYS) {
    test(`${app}: every artifactName template in the yml has rows, and every row's template is the yml's`, () => {
      const yml = config(app);
      const keys = ["dmg", "mac", "nsis", "deb", "rpm", "appImage"] as const;
      // Every artifactName the yml writes is a TemplateKey the table reads (a new `snap:` or `msi:` target with a name would be a stranger).
      const written = Object.entries(yml).flatMap(([section, v]) => (v !== null && typeof v === "object" && typeof (v as any).artifactName === "string" ? [section] : []));
      expect(written.sort()).toEqual([...keys].sort());
      for (const row of INSTALLER_ROWS.filter((r) => r.app === app)) expect(row.template, `${row.os} ${row.kind}`).toBe(yml[row.key].artifactName);
      for (const key of keys) expect(INSTALLER_ROWS.some((r) => r.app === app && r.key === key), `${app} ${key} has no row`).toBe(true);
    });

    test(`${app}: the kinds the table holds per system are the kinds its builds make`, () => {
      const yml = config(app);
      expect<string[]>(kindsOf("mac", app)).toEqual((yml.mac.target as Array<{ target: string }>).map((t) => t.target));
      expect(kindsOf("win", app)).toEqual(["exe"]);
      expect((yml.win.target as Array<{ target: string }>).map((t) => t.target)).toEqual(["nsis"]);
      // Linux: electron-builder.yml's target is `dir`; scripts/build-packages.ts names the formats the build asks for.
      for (const os of ["linux-x64", "linux-arm64"] as const) expect(kindsOf(os, app)).toEqual([...LINUX_FORMATS]);
    });

    test(`${app}: its Linux package is the one build-packages.ts builds (name, product folder, executable)`, () => {
      const yml = config(app);
      expect(yml.deb.packageName).toBe(LINUX_PACKAGES[app].product);
      expect(yml.rpm.packageName).toBe(LINUX_PACKAGES[app].product);
      expect(yml.linux.executableName).toBe(LINUX_PACKAGES[app].executable);
      expect(existsSync(join(ROOT, LINUX_PACKAGES[app].dir, "electron-builder.yml"))).toBe(true);
      expect(LINUX_PACKAGES[app].dir).toBe(APP_BUILD[app].dir);
      // The package's file names carry the package's name: electron-builder writes `<packageName>_<version>_<arch>.deb` and `<packageName>-<version>.<arch>.rpm`.
      expect(yml.deb.artifactName).toBe(`${yml.deb.packageName}_\${version}_\${arch}.\${ext}`);
      expect(yml.rpm.artifactName).toBe(`${yml.rpm.packageName}-\${version}.\${arch}.\${ext}`);
    });
  }

  test("the Linux file names spell the architecture as electron-builder does (builder-util getArtifactArchName)", () => {
    expect(installersOf(VERSION, "linux-x64", "moss")).toEqual(["moss_1.2.3_amd64.deb", "moss-1.2.3.x86_64.rpm", "MOSS-1.2.3-x86_64.AppImage"]);
    expect(installersOf(VERSION, "linux-arm64", "moss")).toEqual(["moss_1.2.3_arm64.deb", "moss-1.2.3.aarch64.rpm", "MOSS-1.2.3-arm64.AppImage"]);
    expect(installersOf(VERSION, "linux-x64", "code")).toEqual(["moss-code_1.2.3_amd64.deb", "moss-code-1.2.3.x86_64.rpm", "MOSS-Code-1.2.3-x86_64.AppImage"]);
    expect(installersOf(VERSION, "linux-arm64", "code")).toEqual(["moss-code_1.2.3_arm64.deb", "moss-code-1.2.3.aarch64.rpm", "MOSS-Code-1.2.3-arm64.AppImage"]);
  });

  test("a template expands the way electron-builder expands it", () => {
    expect(expandTemplate("MOSS-${version}-${arch}.${ext}", { version: "1.2.3", arch: "arm64", ext: "zip" })).toBe("MOSS-1.2.3-arm64.zip");
  });
});

describe("what a release holds", () => {
  test("every system holds both apps' installers and update files for each channel served, and the engine once", () => {
    for (const os of RELEASE_OSES) {
      for (const channel of CHANNELS) {
        const all = expectedArtifacts(VERSION, os, channel);
        expect(new Set(all).size, `${os} ${channel} has a name twice`).toBe(all.length);
        for (const app of APP_KEYS) for (const n of appArtifacts(app, VERSION, os, channel)) expect(all).toContain(n);
        for (const n of engineArtifacts(VERSION, os, channel)) expect(all).toContain(n);
        // The engine is one per system, not one per app.
        expect(all.filter((n) => n.startsWith(`${engineFile("linux")}-`)).length).toBe(1);
        expect(all.filter((n) => n.startsWith("moss-plugin-bun-")).length).toBe(1);
        expect(all.filter((n) => n.startsWith("moss-plugins-")).length).toBe(1);
        expect(all.length).toBe(appArtifacts("code", VERSION, os, channel).length + appArtifacts("moss", VERSION, os, channel).length + engineArtifacts(VERSION, os, channel).length);
      }
    }
  });

  test("no two files of the whole release share a name, and each app's names tell it from the other's", () => {
    const names = RELEASE_OSES.flatMap((os) => expectedArtifacts(VERSION, os, "latest"));
    // The same engine file name in two systems would be a collision in one GitHub release; the update files are per system too.
    expect(new Set(names).size).toBe(names.length);
    for (const row of INSTALLER_ROWS) expect(appOfInstaller(installerName(row, VERSION), VERSION), installerName(row, VERSION)).toBe(row.app);
  });

  test("every update file is a name the feed's signature covers (FEED_NAME), each app's own", () => {
    for (const os of RELEASE_OSES) for (const c of CHANNELS) for (const app of APP_KEYS) {
      expect(FEED_NAME.test(appFeedFile(app, c, os)), appFeedFile(app, c, os)).toBe(true);
      expect(appFeedFile(app, c, os).startsWith("moss-")).toBe(app === "moss");
    }
    for (const os of RELEASE_OSES) for (const n of engineArtifacts(VERSION, os, "latest")) expect(FEED_NAME.test(n) || /^moss-/.test(n), n).toBe(true);
  });

  test("the Linux repositories read the table: a deb or an rpm of either app, and nothing else", () => {
    const names = (["linux-x64", "linux-arm64"] as const).flatMap((os) => installersOf(VERSION, os));
    for (const n of names) {
      const pkg = linuxPackageOf(n);
      if (/\.(deb|rpm)$/.test(n)) expect(pkg, n).toBeDefined();
      else expect(pkg, n).toBeUndefined();
    }
    expect(linuxPackageOf("moss_1.2.3_amd64.deb")).toEqual({ app: "moss", kind: "deb", os: "linux-x64" });
    expect(linuxPackageOf("moss-code_1.2.3_arm64.deb")).toEqual({ app: "code", kind: "deb", os: "linux-arm64" });
    expect(linuxPackageOf("moss-code-1.2.3.aarch64.rpm")).toEqual({ app: "code", kind: "rpm", os: "linux-arm64" });
    expect(linuxPackageOf("moss-1.2.3.x86_64.rpm")).toEqual({ app: "moss", kind: "rpm", os: "linux-x64" });
    // The engine's own files and a stranger are no package.
    expect(linuxPackageOf(`${engineFile("linux")}-1.2.3-linux-x64`)).toBeUndefined();
    expect(linuxPackageOf("moss-plugins-1.2.3-linux-x64.tar.gz")).toBeUndefined();
    expect(linuxPackageOf("moss_1.2.3_i386.deb")).toBeUndefined();
  });
});

describe("a build's folder against the table, both directions", () => {
  const present = (os: ReleaseOs) => expectedArtifacts(VERSION, os, "latest");

  test("exactly the table's files (and a build's byproducts) are a clean folder", () => {
    for (const os of RELEASE_OSES) {
      const files = [...present(os), `${installersOf(VERSION, os)[0]}.blockmap`, `SHA256SUMS-${os}.txt`, `BUILD-COMMIT-${os}.txt`, "builder-debug.yml", "builder-effective-config.yaml"];
      expect(builtArtifactProblems(VERSION, [os], "latest", files)).toEqual([]);
    }
  });

  test("a file the table names that nothing built fails (in the table, not built)", () => {
    for (const os of RELEASE_OSES) for (const gone of present(os)) {
      expect(builtArtifactProblems(VERSION, [os], "latest", present(os).filter((n) => n !== gone)), `${os} without ${gone}`).toEqual([`${gone} is in the artifact table but was not built`]);
    }
  });

  test("a file a builder wrote that the table does not name fails (built, not in the table)", () => {
    for (const os of RELEASE_OSES) {
      for (const stranger of ["MOSS-Extra-1.2.3.dmg", "moss-1.2.3.snap", "latest-extra.yml", "MOSS-Setup-1.2.3-x64.exe", "moss_1.2.3_i386.deb", "moss-code-1.2.3.arm64.rpm"]) {
        expect(builtArtifactProblems(VERSION, [os], "latest", [...present(os), stranger]), stranger).toEqual([`${stranger} was built but is not in the artifact table (scripts/release/artifacts.ts)`]);
      }
    }
  });

  test("a build that makes only one app's files fails for the other's (MOSS's missing, or MOSS Code's)", () => {
    for (const os of RELEASE_OSES) for (const app of APP_KEYS) {
      const dropped = appArtifacts(app, VERSION, os, "latest");
      const problems = builtArtifactProblems(VERSION, [os], "latest", present(os).filter((n) => !dropped.includes(n)));
      expect(problems.sort()).toEqual(dropped.map((n) => `${n} is in the artifact table but was not built`).sort());
    }
  });

  test("a folder of several systems (the release's --from) is held to all of them", () => {
    const both = ["win", "linux-x64"] as const;
    expect(builtArtifactProblems(VERSION, both, "latest", both.flatMap(present))).toEqual([]);
    expect(builtArtifactProblems(VERSION, both, "latest", present("win")).length).toBe(present("linux-x64").length);
  });

  test("the byproducts are named, not a pattern that eats a real file", () => {
    for (const real of RELEASE_OSES.flatMap(present)) expect(BUILD_BYPRODUCTS.some((re) => re.test(real)), real).toBe(false);
  });

  test("the table's own fixture folder (a local stand-in for a release) is clean for every channel", () => {
    for (const channel of CHANNELS) {
      const dir = mkdtempSync(join(tmpdir(), "moss-table-fixture-"));
      try {
        const written = writeReleaseFixture(dir, VERSION, channel);
        expect(builtArtifactProblems(VERSION, RELEASE_OSES, channel, written.filter((n) => !n.startsWith("BUILD-COMMIT-")))).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

test("a row is data: it names a builder, and one per file", () => {
  const rows: InstallerRow[] = [...INSTALLER_ROWS];
  expect(rows.length).toBe(APP_KEYS.length * (1 + 1 + 1 + 3 + 3));
  for (const r of rows) expect(["release/build.ts", "build-packages.ts"]).toContain(r.builder);
  expect(rows.filter((r) => r.builder === "build-packages.ts").every((r) => r.os.startsWith("linux"))).toBe(true);
});
