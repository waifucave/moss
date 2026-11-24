// `publish.ts --dry-run` (the release wave, lane RP): the publish step proven against a local folder standing in for a release, never
// GitHub. It lists both apps' files for each system, renders the Homebrew casks and winget manifests of both, and calls nothing
// outside the folder: no gh, no git, no codesign, no Keychain (asserted with shims for each of them on the process's whole PATH).
import { beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appFeedFile, APP_KEYS, expectedArtifacts, installersOf, RELEASE_OSES } from "./artifacts";
import { FIXTURE_COMMIT, writeReleaseFixture } from "./fixture";
import * as publish from "./publish";

const ROOT = join(import.meta.dir, "..", "..");
const version = (JSON.parse(readFileSync(join(ROOT, "apps", "desktop", "package.json"), "utf8")) as { version: string }).version;

// The dry run is run as a process of its own, with a PATH holding only shims for every program the real publish step calls (gh, git,
// codesign, xcrun, security, hdiutil, ditto, node): each writes its name to a log and fails. A dry run that touched any of them leaves
// a line in the log. (Not `mock.module`: it would leak into every other test file of the run.)
let shims = "";
let log = "";
beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "moss-dry-run-shims-"));
  shims = join(root, "bin");
  log = join(root, "calls.log");
  mkdirSync(shims);
  writeFileSync(log, "");
  for (const prog of ["gh", "git", "codesign", "xcrun", "security", "hdiutil", "ditto", "bsdtar", "curl"]) {
    writeFileSync(join(shims, prog), `#!/bin/sh\necho "${prog} $*" >> '${log}'\nexit 1\n`);
    chmodSync(join(shims, prog), 0o755);
  }
});

/** Runs publish.ts as a process with only the shims on its PATH. */
async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn([process.execPath, join(ROOT, "scripts", "release", "publish.ts"), ...argv], { cwd: ROOT, env: { PATH: shims, HOME: tmpdir() }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

const spawned = { get calls(): string[] { return readFileSync(log, "utf8").split("\n").filter(Boolean); } };

function folder(channel: "latest" | "beta" = "latest"): string {
  const dir = mkdtempSync(join(tmpdir(), "moss-dry-run-"));
  writeReleaseFixture(dir, version, channel);
  return dir;
}

describe("publish.ts --dry-run", () => {
  test("lists both apps' files for each system, the engine's, and skips (by name) what needs GitHub, git, codesign or the Keychain", async () => {
    const dir = folder();
    try {
      const r = await run(["--dry-run", "--from", dir]);
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      for (const os of RELEASE_OSES) {
        for (const app of APP_KEYS) {
          const line = r.out.split("\n").find((l) => l.startsWith(`  ${os} / ${app === "moss" ? "MOSS" : "MOSS Code"}:`));
          expect(line, `${os} ${app}`).toBeDefined();
          for (const n of installersOf(version, os, app)) expect(line).toContain(n);
          expect(line).toContain(appFeedFile(app, "latest", os));
          expect(line).toContain(appFeedFile(app, "beta", os));
        }
        expect(r.out).toContain(`  ${os} / the engine:`);
      }
      expect(r.out).toContain(`at ${FIXTURE_COMMIT}`);
      for (const s of publish.DRY_RUN_SKIPS) expect(r.out).toContain(`dry run skips: ${s}`);
      expect(r.out).toContain("nothing signed, uploaded or created");
      // Not one of gh, git, codesign, xcrun, security (the Keychain), hdiutil, ditto or curl was called.
      expect(spawned.calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("says where each file would go and whose step it is: the draft, both taps' casks, both winget packages, the Linux repositories", async () => {
    const dir = folder();
    try {
      const r = await run(["--dry-run", "--from", dir]);
      expect(r.code).toBe(0);
      const out = r.out;
      expect(out).toContain(`GitHub waifucave/moss: a DRAFT release v${version} at ${FIXTURE_COMMIT}`);
      // Each app's update files get a signature at --create-draft, MOSS's under its own names.
      for (const os of RELEASE_OSES) for (const app of APP_KEYS) expect(out, `${os} ${app}`).toContain(`${appFeedFile(app, "latest", os)}.sig`);
      expect(out).toContain("Homebrew waifucave/homebrew-moss: Casks/moss-code.rb, Casks/moss.rb");
      expect(out).toContain(`manifests/w/waifucave/MOSSCode/${version}/`);
      expect(out).toContain(`manifests/w/waifucave/MOSS/${version}/`);
      expect(out).toContain("R2 bucket moss-packages");
      for (const n of installersOf(version, "linux-x64", "moss").filter((f) => /\.(deb|rpm)$/.test(f))) expect(out).toContain(n);
      expect(out).toContain("nothing signed, uploaded or created");
      expect(spawned.calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("renders both apps' Homebrew casks and winget manifests from the release's own files", async () => {
    const dir = folder(), to = mkdtempSync(join(tmpdir(), "moss-dry-run-render-"));
    try {
      const r = await run(["--dry-run", "--from", dir, "--render-to", to]);
      expect(r.code).toBe(0);
      const files = ["casks/moss.rb", "casks/moss-code.rb", ...["waifucave.MOSS", "waifucave.MOSSCode"].flatMap((p) => ["installer", "locale.en-US", "version"].map((k) => `winget/${p}.${k === "version" ? "" : `${k}.`}yaml`))];
      for (const f of files) expect(existsSync(join(to, f)), f).toBe(true);
      const mossCask = readFileSync(join(to, "casks", "moss.rb"), "utf8");
      expect(mossCask).toContain(`version "${version}"`);
      expect(mossCask).toContain("MOSS-#{version}.dmg");
      expect(mossCask).not.toContain("{{");
      expect(readFileSync(join(to, "winget", "waifucave.MOSS.installer.yaml"), "utf8")).toContain(`/v${version}/MOSS-Setup-${version}.exe`);
      expect(readFileSync(join(to, "winget", "waifucave.MOSSCode.installer.yaml"), "utf8")).toContain(`/v${version}/MOSS-Code-Setup-${version}.exe`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(to, { recursive: true, force: true });
    }
  });

  test("a file of the table missing from the folder fails the dry run, whichever app's", async () => {
    for (const app of APP_KEYS) {
      const dir = folder();
      try {
        const gone = installersOf(version, "linux-arm64", app).find((n) => n.endsWith(".rpm"))!;
        rmSync(join(dir, gone));
        const r = await run(["--dry-run", "--from", dir]);
        expect(r.code).toBe(1);
        expect(r.err).toContain(`${gone} is missing`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("an update file that names the other app's files fails (MOSS Code's update file may not carry MOSS's installer)", async () => {
    const dir = folder();
    try {
      const mossDmg = installersOf(version, "mac", "moss")[0]!;
      const feed = join(dir, appFeedFile("code", "latest", "mac"));
      const bytes = readFileSync(join(dir, mossDmg));
      const sha512 = new Bun.CryptoHasher("sha512").update(bytes).digest("base64");
      writeFileSync(feed, `version: ${version}\nfiles:\n  - url: ${mossDmg}\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: ${mossDmg}\nsha512: ${sha512}\n`);
      const r = await run(["--dry-run", "--from", dir]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(`latest-mac.yml names ${mossDmg}, which is not MOSS Code's`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("builds of different commits fail, and so does an update file whose file changed", async () => {
    const dir = folder();
    try {
      writeFileSync(join(dir, "BUILD-COMMIT-win.txt"), "fedcba9876543210fedcba9876543210fedcba98\n");
      writeFileSync(join(dir, installersOf(version, "win", "moss")[0]!), "different bytes");
      const r = await run(["--dry-run", "--from", dir]);
      expect(r.code).toBe(1);
      expect(r.err).toContain("the builds come from different commits");
      expect(r.err).toContain("sha512 doesn't match");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("it creates nothing: --create-draft is refused beside it, and --render-to needs it", () => {
    expect(() => publish.parsePublishArgs(["--dry-run", "--create-draft", "--from", "x"])).toThrow(/dry-run never creates/);
    expect(() => publish.parsePublishArgs(["--render-to", "x", "--from", "x"])).toThrow(/--render-to is for --dry-run/);
    expect(publish.parsePublishArgs(["--dry-run", "--from", "a,b", "--render-to", "out"])).toEqual({ mode: "draft", from: ["a", "b"], channel: "latest", create: false, dryRun: true, renderTo: "out" });
  });

  test("the beta channel's folder is a beta release's dry run", async () => {
    const dir = folder("beta");
    try {
      const r = await run(["--dry-run", "--from", dir, "--channel", "beta"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("on beta");
      expect(r.out).not.toContain("moss-latest-mac.yml");
      expect(r.out).toContain("moss-beta-mac.yml");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the control: the shims do catch the real thing", () => {
  test("the plain plan (no --dry-run) calls git, which the shim records, so an empty log above means something", async () => {
    const dir = folder();
    try {
      const before = spawned.calls.length;
      const r = await run(["--from", dir]);
      expect(r.code).toBe(1);
      expect(spawned.calls.length).toBeGreaterThan(before);
      expect(spawned.calls.slice(before).some((c) => c.startsWith("git "))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("promoting a beta release names MOSS's update files too", () => {
  test("each beta update file's latest name, MOSS's with its prefix", () => {
    expect(publish.promotedName("beta-mac.yml")).toBe("latest-mac.yml");
    expect(publish.promotedName("moss-beta-mac.yml")).toBe("moss-latest-mac.yml");
    expect(publish.promotedName("moss-beta.yml")).toBe("moss-latest.yml");
    expect(publish.promotedName("moss-beta-linux-arm64.yml")).toBe("moss-latest-linux-arm64.yml");
    expect(publish.promotedName("beta-core-linux-x64.yml")).toBe("latest-core-linux-x64.yml");
    expect(() => publish.promotedName("moss-latest-mac.yml")).toThrow(/not a beta update file/);
    expect(() => publish.promotedName("moss-beta-extra.yml")).toThrow(/not a beta update file/);
  });

  test("a beta release's update files are the table's (every system: both apps' and the engine's three): promote counts and names them all", () => {
    const betaFeeds = RELEASE_OSES.flatMap((os) => expectedArtifacts(version, os, "beta").filter((n) => n.endsWith(".yml")));
    expect(betaFeeds.length).toBe(publish.BETA_FEEDS);
    for (const f of betaFeeds) {
      expect(publish.BETA_FEED.test(f), f).toBe(true);
      expect(() => publish.promotedName(f), f).not.toThrow();
    }
    // And the latest names promote writes are exactly the latest names the table holds for a full release.
    const latest = new Set(RELEASE_OSES.flatMap((os) => expectedArtifacts(version, os, "latest")));
    for (const f of betaFeeds) expect(latest.has(publish.promotedName(f)), f).toBe(true);
  });
});
