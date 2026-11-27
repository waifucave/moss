// Which executable the engine's on-demand host task (Windows) or user unit (Linux) runs. The host there is MOSS Code's own program started
// as `<executable> --moss-program=host` (apps/desktop/src/main/host-program.ts); neither OS has a helper bundle. Two installs can hold it:
//   * MOSS Code: its own executable in its install folder (`<folder>\MOSS Code.exe`, `<folder>/moss-code`: /opt/moss-code on Linux);
//   * MOSS: MOSS Code's whole app carried in its own install folder, `<folder>\resources\host\moss-host.exe`, `<folder>/resources/host/moss-host`
//     (apps/moss/scripts/host-helper.mjs; /opt/moss on Linux).
// The install folders are what the apps wrote in their records under the home (`<home>/apps/code.json`, `moss.json`: `bundlePath`), the same
// records the engine reads to find a host to start, so the definition and the engine's start name the same install.
// ONE RULE for a computer that has both (one host per home, so one definition): the one of the NEWER release, and on the same release MOSS Code's
// own executable (the app that is the host's program, which updates on its own). A copy whose executable isn't on disk is not a candidate. The
// definition is written again by every `autostart enable` and `disable` (the apps run it at each launch when the login item is installed), so an
// upgrade, or the other app's install or removal, moves it at the next launch of either app. With no candidate no host is defined.
import { existsSync } from "node:fs";
import { compareReleases } from "@waifucave/moss-protocol";
import { appRecordsSource } from "../../host/world";
import type { DaemonPlatform } from "../transport";

/** MOSS Code's executable in its install folder, by OS (apps/moss/scripts/host-helper.mjs's `CODE_EXECUTABLE`). */
const CODE_EXECUTABLE = { linux: "moss-code", win32: "MOSS Code.exe" } as const;

const under = (os: "linux" | "win32", folder: string, ...parts: string[]): string =>
  os === "win32" ? [folder.replace(/[\\/]+$/, ""), ...parts].join("\\") : [folder.replace(/\/+$/, ""), ...parts].join("/");

export interface HostExecutable { readonly bin: string; readonly program: "code" | "moss"; readonly release: string }

/** The host's executable on Windows or Linux under `home`, or undefined (macOS, or no install that carries it is on disk). */
export function hostExecutable(home: string, os: DaemonPlatform, exists: (p: string) => boolean = existsSync): HostExecutable | undefined {
  if (os !== "linux" && os !== "win32") return undefined;
  const found: HostExecutable[] = [];
  const code = appRecordsSource(home, exists, "code");
  if (code !== undefined) {
    const bin = under(os, code.bundlePath, CODE_EXECUTABLE[os]);
    if (exists(bin)) found.push({ bin, program: "code", release: code.release });
  }
  const moss = appRecordsSource(home, exists, "moss");
  if (moss !== undefined) {
    const bin = under(os, moss.bundlePath, "resources", "host", os === "win32" ? "moss-host.exe" : "moss-host");
    if (exists(bin)) found.push({ bin, program: "moss", release: moss.release });
  }
  if (found.length === 0) return undefined;
  return found.reduce((best, c) => (compareReleases(c.release, best.release) > 0 ? c : best));
}
