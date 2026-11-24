// THE artifact table (the release wave, lane RP; spec §13 row C7, §14.2 item 120): every file one release holds, for both
// apps (MOSS Code and MOSS) on the three systems, in ONE place. The build (scripts/release/build.ts, scripts/build-packages.ts),
// the check run on each build's output (`builtArtifactProblems`), the publish step (scripts/release/publish.ts), the Linux
// repositories (linux-repo.ts's `archOf`), the Homebrew casks and the winget manifests all read it, so a file added to one
// builder and not to the others is a failing test (artifacts.test.ts), not a surprise at the owner's publish.
//
// What a release holds, per system (`os`):
//   * each app's INSTALLERS (`INSTALLER_ROWS`: dmg and zip, NSIS installer, deb, rpm and AppImage), named by the
//     `artifactName` its electron-builder.yml gives (the row says which key, and the test expands the template and compares);
//   * each app's UPDATE FILES for every channel served (`appFeedFile`): MOSS Code's are electron-updater's own names, MOSS's
//     carry `MOSS_APP_FEED_PREFIX`, so the two apps' files in one GitHub release never overwrite each other;
//   * the ENGINE's files, once per system and not once per app (one release ships one engine, one tree): the daemon's binary
//     and update file, plain Bun for plugins, and the bundled plugins' tarball (`engineArtifacts`).
// Pure: no file is read or written here.
import { coreBinaryFile, coreFeedFile, MOSS_APP_FEED_PREFIX, pluginBunBinaryFile, pluginBunFeedFile, pluginsFeedFile, pluginsTarballFile, type CoreTarget } from "../../packages/update-feed/src/index";
import { PLUGIN_BUN } from "../bundled-binaries";

export const CHANNELS = ["latest", "beta"] as const;
export type Channel = (typeof CHANNELS)[number];

export type ReleaseOs = "mac" | "win" | "linux-x64" | "linux-arm64";
/** Every system a release builds for, in the order the release is read. */
export const RELEASE_OSES: readonly ReleaseOs[] = ["mac", "win", "linux-x64", "linux-arm64"];

export type AppKey = "code" | "moss";
export const APP_KEYS: readonly AppKey[] = ["code", "moss"];

export type InstallerKind = "dmg" | "zip" | "exe" | "deb" | "rpm" | "AppImage";

/** The update file electron-updater reads for `os` on `channel` (MOSS Code's name; MOSS's is `appFeedFile("moss", …)`). */
export function feedFile(channel: Channel, os: ReleaseOs): string {
  switch (os) {
    case "mac": return `${channel}-mac.yml`;
    case "win": return `${channel}.yml`;
    case "linux-x64": return `${channel}-linux.yml`;
    case "linux-arm64": return `${channel}-linux-arm64.yml`;
  }
}

/** `app`'s update file: MOSS Code's as electron-builder names it, MOSS's with `MOSS_APP_FEED_PREFIX` in front. */
export function appFeedFile(app: AppKey, channel: Channel, os: ReleaseOs): string {
  return app === "moss" ? `${MOSS_APP_FEED_PREFIX}${feedFile(channel, os)}` : feedFile(channel, os);
}

/** The channels a release on `channel` writes update files for: a full release serves beta users too. */
export function channelsServed(channel: Channel): Channel[] {
  return channel === "latest" ? ["latest", "beta"] : ["beta"];
}

/** Where each app is built: its folder (relative to the repository) and the electron-builder.yml the names come from. */
export const APP_BUILD: Readonly<Record<AppKey, { dir: string; config: string }>> = {
  code: { dir: "apps/desktop", config: "apps/desktop/electron-builder.yml" },
  moss: { dir: "apps/moss", config: "apps/moss/electron-builder.yml" },
};

/** The part of electron-builder.yml a name template sits in. */
export type TemplateKey = "dmg" | "mac" | "nsis" | "deb" | "rpm" | "appImage";

export interface InstallerRow {
  app: AppKey;
  os: ReleaseOs;
  kind: InstallerKind;
  /** The `artifactName` template in the app's electron-builder.yml (`<TemplateKey>.artifactName`), as written there. */
  key: TemplateKey;
  template: string;
  /** What electron-builder puts for `${arch}` in this file's name, and for `${ext}` (the kind, but for the exe). */
  arch: string;
  ext: string;
  /** What builds it. */
  builder: "release/build.ts" | "build-packages.ts";
}

/** electron-builder's names, by app: the templates are copied from each app's electron-builder.yml and the test holds them equal. */
const TEMPLATES: Readonly<Record<AppKey, Readonly<Record<TemplateKey, string>>>> = {
  code: {
    dmg: "MOSS-Code-${version}.${ext}", mac: "MOSS-Code-${version}-mac.${ext}", nsis: "MOSS-Code-Setup-${version}.${ext}",
    deb: "moss-code_${version}_${arch}.${ext}", rpm: "moss-code-${version}.${arch}.${ext}", appImage: "MOSS-Code-${version}-${arch}.AppImage",
  },
  moss: {
    dmg: "MOSS-${version}.${ext}", mac: "MOSS-${version}-mac.${ext}", nsis: "MOSS-Setup-${version}.${ext}",
    deb: "moss_${version}_${arch}.${ext}", rpm: "moss-${version}.${arch}.${ext}", appImage: "MOSS-${version}-${arch}.AppImage",
  },
};

/** Expands an electron-builder name template. */
export function expandTemplate(template: string, v: { version: string; arch: string; ext: string }): string {
  return template.replaceAll("${version}", v.version).replaceAll("${arch}", v.arch).replaceAll("${ext}", v.ext);
}

/** The Linux packages' file names spell the architecture per format: electron-builder's `getArtifactArchName` (builder-util
 *  arch.js, 26.18.0): the deb says amd64 and the rpm and AppImage x86_64 for x64, and for arm64 the rpm says aarch64 where the deb
 *  and the AppImage say arm64. */
const LINUX_ARCH: Readonly<Record<"linux-x64" | "linux-arm64", { deb: string; rpm: string; appImage: string }>> = {
  "linux-x64": { deb: "amd64", rpm: "x86_64", appImage: "x86_64" },
  "linux-arm64": { deb: "arm64", rpm: "aarch64", appImage: "arm64" },
};

function rowsFor(app: AppKey): InstallerRow[] {
  const t = TEMPLATES[app];
  const r = (os: ReleaseOs, kind: InstallerKind, key: TemplateKey, arch: string, ext: string, builder: InstallerRow["builder"]): InstallerRow => ({ app, os, kind, key, template: t[key], arch, ext, builder });
  return [
    r("mac", "dmg", "dmg", "arm64", "dmg", "release/build.ts"),
    r("mac", "zip", "mac", "arm64", "zip", "release/build.ts"),
    r("win", "exe", "nsis", "x64", "exe", "release/build.ts"),
    ...(["linux-x64", "linux-arm64"] as const).flatMap((os) => [
      r(os, "deb", "deb", LINUX_ARCH[os].deb, "deb", "build-packages.ts"),
      r(os, "rpm", "rpm", LINUX_ARCH[os].rpm, "rpm", "build-packages.ts"),
      r(os, "AppImage", "appImage", LINUX_ARCH[os].appImage, "AppImage", "build-packages.ts"),
    ]),
  ];
}

/** Every installer of a release, both apps, every system. */
export const INSTALLER_ROWS: readonly InstallerRow[] = APP_KEYS.flatMap(rowsFor);

/** The file name of one installer row for `version`. */
export function installerName(row: InstallerRow, version: string): string {
  return expandTemplate(row.template, { version, arch: row.arch, ext: row.ext });
}

/** `os`'s installers for `version`: both apps' (MOSS Code's first), or one app's. */
export function installersOf(version: string, os: ReleaseOs, app?: AppKey): string[] {
  return INSTALLER_ROWS.filter((r) => r.os === os && (app === undefined || r.app === app)).map((r) => installerName(r, version));
}

/** The daemon's target each system's release build makes (scripts/build-daemon.ts's). */
export const CORE_TARGET: Readonly<Record<ReleaseOs, CoreTarget>> = { mac: "darwin-arm64", win: "windows-x64", "linux-x64": "linux-x64", "linux-arm64": "linux-arm64" };

/** The daemon's files in `os`'s release: its binary and its update file for each channel served. */
export function coreArtifacts(version: string, os: ReleaseOs, channel: Channel): string[] {
  return [coreBinaryFile(version, CORE_TARGET[os]), ...channelsServed(channel).map((c) => coreFeedFile(c, CORE_TARGET[os]))];
}

/** Plain Bun for plugins in `os`'s release (for a server install): its binary, named by the daemon's Bun version, and its update files. */
export function pluginBunArtifacts(os: ReleaseOs, channel: Channel): string[] {
  return [pluginBunBinaryFile(PLUGIN_BUN.version, CORE_TARGET[os]), ...channelsServed(channel).map((c) => pluginBunFeedFile(c, CORE_TARGET[os]))];
}

/** The bundled plugins in `os`'s release (for a server install): the tarball and its update files. */
export function pluginsArtifacts(version: string, os: ReleaseOs, channel: Channel): string[] {
  return [pluginsTarballFile(version, CORE_TARGET[os]), ...channelsServed(channel).map((c) => pluginsFeedFile(c, CORE_TARGET[os]))];
}

/** The engine's files in `os`'s release: once per system, whatever apps it carries it. */
export function engineArtifacts(version: string, os: ReleaseOs, channel: Channel): string[] {
  return [...coreArtifacts(version, os, channel), ...pluginBunArtifacts(os, channel), ...pluginsArtifacts(version, os, channel)];
}

/** One app's update files in `os`'s release, for each channel served. */
export function appFeeds(app: AppKey, os: ReleaseOs, channel: Channel): string[] {
  return channelsServed(channel).map((c) => appFeedFile(app, c, os));
}

/** One app's files in `os`'s release: its installers and its update files. */
export function appArtifacts(app: AppKey, version: string, os: ReleaseOs, channel: Channel): string[] {
  return [...installersOf(version, os, app), ...appFeeds(app, os, channel)];
}

/** Every file `os`'s release holds, from the one table: both apps' installers and update files, and the engine's. */
export function expectedArtifacts(version: string, os: ReleaseOs, channel: Channel): string[] {
  return [...APP_KEYS.flatMap((app) => appArtifacts(app, version, os, channel)), ...engineArtifacts(version, os, channel)];
}

/** What a build of `os` leaves beside the files of the table, which is none of the table's concern: block maps (they travel
 *  with their files), the unpacked apps, the sums and commit files the build writes, and electron-builder's own debug output.
 *  A file in a build's folder that is in neither this list nor the table is a file the table does not know about. */
export const BUILD_BYPRODUCTS: readonly RegExp[] = [
  /\.blockmap$/, /^SHA256SUMS-[a-z0-9-]+\.txt$/, /^BUILD-COMMIT-[a-z0-9-]+\.txt$/, /^builder-debug\.yml$/, /^builder-effective-config\.yaml$/,
];

/** What a build folder's regular files (`present`, names only) hold against the table, for the systems `oses` that folder is
 *  of: the table's files that are missing, and the files no row of the table names (`unknown`). Directories (`mac-arm64/`,
 *  `win-unpacked/`, `linux-unpacked/`) are not listed here, and a build's byproducts are `BUILD_BYPRODUCTS`.
 *  Both directions: a builder that writes a file the table lacks fails here as a stranger, and a table row no builder makes
 *  fails here as missing. */
export function builtArtifactProblems(version: string, oses: readonly ReleaseOs[], channel: Channel, present: readonly string[]): string[] {
  const want = new Set(oses.flatMap((os) => expectedArtifacts(version, os, channel)));
  const have = new Set(present);
  const problems: string[] = [];
  for (const name of want) if (!have.has(name)) problems.push(`${name} is in the artifact table but was not built`);
  for (const name of have) if (!want.has(name) && !BUILD_BYPRODUCTS.some((re) => re.test(name))) problems.push(`${name} was built but is not in the artifact table (scripts/release/artifacts.ts)`);
  return problems;
}

/** The kinds the table holds for `os` (for a builder that must make each: the Linux formats, the mac targets). */
export function kindsOf(os: ReleaseOs, app: AppKey): InstallerKind[] {
  return INSTALLER_ROWS.filter((r) => r.os === os && r.app === app).map((r) => r.kind);
}

/** A package file's app and Linux architecture, from its name (`archOf` in linux-repo.ts reads this): a deb or an rpm of the table. */
export function linuxPackageOf(name: string): { app: AppKey; kind: "deb" | "rpm"; os: "linux-x64" | "linux-arm64" } | undefined {
  for (const row of INSTALLER_ROWS) {
    if ((row.kind !== "deb" && row.kind !== "rpm") || (row.os !== "linux-x64" && row.os !== "linux-arm64")) continue;
    // The version is whatever sits where the template has `${version}`.
    const esc = (t: string) => t.replace(/[.*+?^$|()[\]\\{}]/g, "\\$&");
    const pattern = new RegExp(`^${row.template.split(/(\$\{version\}|\$\{arch\}|\$\{ext\})/).map((part) => (part === "${version}" ? "(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?)" : part === "${arch}" ? esc(row.arch) : part === "${ext}" ? row.ext : esc(part))).join("")}$`);
    if (pattern.test(name)) return { app: row.app, kind: row.kind, os: row.os };
  }
  return undefined;
}

/** The App each installer file of `version` belongs to (for the checks that must name an app: the dmg's signature, the unpacked app's name scan). */
export function appOfInstaller(name: string, version: string): AppKey | undefined {
  return INSTALLER_ROWS.find((r) => installerName(r, version) === name)?.app;
}
