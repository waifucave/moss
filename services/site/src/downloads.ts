// The download area's files, read from the release's own artifact table (scripts/release/artifacts.ts), so a name the
// release scripts change is the name this page links. Only installers are listed: the mac zip and the .yml files are
// for the apps' own updater.
import { installersOf, INSTALLER_ROWS, installerName, type AppKey, type InstallerKind, type ReleaseOs } from "../../../scripts/release/artifacts";
import { WINGET_PACKAGE } from "../../../scripts/winget";
import { CASKS } from "../../../scripts/release/package-managers";

export interface DownloadFile {
  kind: InstallerKind;
  /** The file's name in the release. */
  name: string;
  url: string;
  /** What the button says. */
  label: string;
}

export interface DownloadSystem {
  /** The system as the page groups it, which the page's script matches against the visitor's. */
  key: "mac" | "win" | "linux-x64" | "linux-arm64";
  name: string;
  detail: string;
  files: DownloadFile[];
}

export interface DownloadApp {
  app: AppKey;
  name: string;
  what: string;
  systems: DownloadSystem[];
  homebrew: string;
  winget: string;
}

const SYSTEMS: readonly { key: ReleaseOs; name: string; detail: string }[] = [
  { key: "mac", name: "macOS", detail: "macOS 27 or later, Apple silicon" },
  { key: "win", name: "Windows", detail: "Windows 11, x64" },
  { key: "linux-x64", name: "Linux, x64", detail: "Ubuntu 26.04 LTS, current Fedora" },
  { key: "linux-arm64", name: "Linux, arm64", detail: "Ubuntu 26.04 LTS, current Fedora" },
];

const LABEL: Record<InstallerKind, string> = { dmg: "Disk image (.dmg)", zip: "Zip", exe: "Installer (.exe)", deb: ".deb", rpm: ".rpm", AppImage: "AppImage" };

const APPS: readonly { app: AppKey; name: string; what: string }[] = [
  { app: "moss", name: "MOSS", what: "The app for your bots." },
  { app: "code", name: "MOSS Code", what: "The app for your coding agents." },
];

/** `<repository>/releases/download/v<version>/<file>`: the form the winget manifests use (scripts/winget.ts). */
export function releaseUrl(repository: string, version: string, file: string): string {
  return `${repository}/releases/download/v${version}/${file}`;
}

export function downloads(version: string, repository: string): DownloadApp[] {
  const owner = repository.replace(/^https:\/\/github\.com\//, "").split("/")[0]!;
  return APPS.map(({ app, name, what }) => ({
    app, name, what,
    systems: SYSTEMS.map((s) => ({
      key: s.key, name: s.name, detail: s.detail,
      files: INSTALLER_ROWS.filter((r) => r.app === app && r.os === s.key && r.kind !== "zip").map((r) => {
        const file = installerName(r, version);
        return { kind: r.kind, name: file, url: releaseUrl(repository, version, file), label: LABEL[r.kind] };
      }),
    })),
    homebrew: `brew install --cask ${owner}/moss/${CASKS[app].token}`,
    winget: `winget install ${WINGET_PACKAGE[app]}`,
  }));
}

/** Every installer name the release table gives for `version`, for the tests' comparison. */
export function allInstallerNames(version: string): string[] {
  return (["mac", "win", "linux-x64", "linux-arm64"] as const).flatMap((os) => installersOf(version, os)).filter((n) => !n.endsWith(".zip"));
}
