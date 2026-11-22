// winget's three manifests for each of a MOSS release's two apps (MOSS Code's `waifucave.MOSSCode`, MOSS's `waifucave.MOSS`), rendered from packaging/winget/*.yaml.tmpl (plan §4 M1). Each
// release fills in its version, the Windows installer's URL and SHA-256, and the release date; submitting them to
// microsoft/winget-pkgs is the release pipeline's (M2). The installer they point at comes with E-M1's app.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { installersOf, type AppKey } from "./release/artifacts";

export interface WingetValues {
  version: string;
  /** The NSIS installer's download URL. */
  url: string;
  /** Its SHA-256, 64 hex digits (winget wants them upper-case; either is accepted here and written upper-case). */
  sha256: string;
  /** YYYY-MM-DD. */
  releaseDate: string;
}

export const WINGET_DIR = join("packaging", "winget");

/** The release's installer URL for a version (electron-builder's NSIS artifact, published on the GitHub release). */
export function wingetInstallerUrl(version: string, app: AppKey = "code"): string {
  return `https://github.com/waifucave/moss/releases/download/v${version}/${installersOf(version, "win", app)[0]}`;
}

/** Each app's winget package: the identifier its three manifests carry, and so their file names' prefix (`waifucave.MOSSCode.`, `waifucave.MOSS.`). */
export const WINGET_PACKAGE: Readonly<Record<AppKey, string>> = { code: "waifucave.MOSSCode", moss: "waifucave.MOSS" };

/** Every manifest, by file name (the template's name without `.tmpl`), with the release's values in. */
export function renderWinget(root: string, v: WingetValues, app: AppKey = "code"): Record<string, string> {
  if (!/^\d+\.\d+\.\d+$/.test(v.version)) throw new Error(`winget: version ${JSON.stringify(v.version)} is not N.N.N`);
  if (!/^[0-9a-fA-F]{64}$/.test(v.sha256)) throw new Error("winget: sha256 is not 64 hex digits");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.releaseDate)) throw new Error(`winget: releaseDate ${JSON.stringify(v.releaseDate)} is not YYYY-MM-DD`);
  if (!/^https:\/\//.test(v.url)) throw new Error("winget: the installer URL is not https");
  const dir = join(root, WINGET_DIR);
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).filter((f) => f.startsWith(`${WINGET_PACKAGE[app]}.`) && f.endsWith(".yaml.tmpl")).sort()) {
    const text = readFileSync(join(dir, name), "utf8")
      .replaceAll("{{version}}", v.version)
      .replaceAll("{{url}}", v.url)
      .replaceAll("{{sha256}}", v.sha256.toUpperCase())
      .replaceAll("{{releaseDate}}", v.releaseDate);
    const left = text.match(/\{\{\w+\}\}/);
    if (left !== null) throw new Error(`winget: ${name} has a slot this renderer does not fill: ${left[0]}`);
    out[name.slice(0, -".tmpl".length)] = text;
  }
  if (Object.keys(out).length !== 3) throw new Error(`winget: ${WINGET_PACKAGE[app]} has ${Object.keys(out).length} manifests, not 3 (version, installer, locale)`);
  return out;
}
