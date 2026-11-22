// Homebrew and winget for BOTH apps, rendered from the artifact table's file names (scripts/release/artifacts.ts) and the release's own
// files: one cask and one set of three winget manifests per app. Pure but for the reads of the templates under packaging/ (and the
// sha256 of the installers, which `shaOf` supplies). Nothing is submitted: the owner commits the casks to the Homebrew tap and submits
// the manifests to microsoft/winget-pkgs (the owner's steps).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderWinget, wingetInstallerUrl } from "../winget";
import { APP_KEYS, installersOf, type AppKey } from "./artifacts";

/** Each app's cask: its token and template. */
export const CASKS: Readonly<Record<AppKey, { token: string; template: string }>> = {
  code: { token: "moss-code", template: "packaging/moss-code.rb.tmpl" },
  moss: { token: "moss", template: "packaging/moss.rb.tmpl" },
};

/** A cask template's slots filled (release-lib's `caskFrom`, which this pipeline does not import: the casks' URLs are derived by Ruby from the version). */
export function renderCask(template: string, version: string, sha256: string): string {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`cask: version ${JSON.stringify(version)} is not N.N.N`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error("cask: sha256 is not 64 lower-case hex digits");
  const text = template.replaceAll("{{version}}", version).replaceAll("{{sha256}}", sha256);
  const left = text.match(/\{\{\w+\}\}/);
  if (left !== null) throw new Error(`cask: a slot this renderer does not fill: ${left[0]}`);
  return text;
}

/** The dmg each app's cask downloads (the table's), which the sha256 is of. */
export function caskDmg(version: string, app: AppKey): string {
  return installersOf(version, "mac", app)[0]!;
}

/** The NSIS installer each app's winget manifest points at (the table's). */
export function wingetExe(version: string, app: AppKey): string {
  return installersOf(version, "win", app)[0]!;
}

/** Every rendered file of the release's package managers, by path: `casks/<token>.rb` and `winget/<identifier>.<kind>.yaml`.
 *  `shaOf(name)` gives an installer's SHA-256 (hex): the release's own file. */
export function renderPackageManagers(root: string, version: string, releaseDate: string, shaOf: (installer: string) => string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const app of APP_KEYS) {
    const cask = CASKS[app];
    out[`casks/${cask.token}.rb`] = renderCask(readFileSync(join(root, cask.template), "utf8"), version, shaOf(caskDmg(version, app)));
    const manifests = renderWinget(root, { version, url: wingetInstallerUrl(version, app), sha256: shaOf(wingetExe(version, app)), releaseDate }, app);
    for (const [name, text] of Object.entries(manifests)) out[`winget/${name}`] = text;
  }
  return out;
}
