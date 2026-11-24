// The real reader of an agent backend's icon (spec revision 20, §9.5 "A backend's look"; the contract is
// `contracts/backend-icons.ts`, whose conformance suite `tests/backend-icons.test.ts` runs against this).
//
// An `agentBackends` entry names an icon file in its own plugin's folder. This reads it where the plugin's other files are
// read, and answers it inline or as no icon with why; it never throws, because a bad icon never fails its plugin.
//   * The file's REAL path (every symlink followed) must stay inside the plugin folder's real path.
//   * Read at most `ICON_FILE_MAX_BYTES + 1` bytes and check the length after the read (a file that grows between a stat and
//     the read is no bigger an answer than the cap), through a handle opened without following a link at the last step, and
//     refused when it has other hard links (a link planted in the folder to a file kept elsewhere).
//   * Its type is what its bytes are, and agrees with its name's extension; an SVG only when inert.
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { ICON_FILE_MAX_BYTES } from "@waifucave/moss-protocol";
import { isInside, normalizePosix } from "../contracts/common";
import { sniffIcon, svgIsInert, type BackendIcons, type IconFiles, type IconRead } from "../contracts/backend-icons";

export class EngineBackendIcons implements BackendIcons {
  constructor(private readonly files: IconFiles = nodeIconFiles()) {}

  async read(pluginRoot: string, icon: string): Promise<IconRead> {
    try {
      return this.#read(pluginRoot, icon);
    } catch (err) {
      // A file that can't be read (gone between the checks, a permission) is no icon, never a failed plugin.
      return { none: "refused", why: `${icon.slice(0, 120)} could not be read (${err instanceof Error ? err.name : "error"})` };
    }
  }

  #read(pluginRoot: string, icon: string): IconRead {
    const f = this.files;
    // A path that leaves the folder lexically never reaches the disk (the manifest's own check says the same).
    if (icon === "" || icon.startsWith("/") || /^[A-Za-z]:/.test(icon) || icon.includes("\\") || icon.split("/").includes("..")) return { none: "refused", why: `${icon.slice(0, 120)} isn't a path inside the plugin's folder` };
    const root = f.realpath(pluginRoot);
    const real = f.realpath(normalizePosix(`${pluginRoot}/${icon}`));
    if (root === undefined || real === undefined) return { none: "missing", why: `${icon} isn't in the plugin's folder` };
    if (!isInside(real, root)) return { none: "refused", why: `${icon} leads outside the plugin's folder` };
    const size = f.size(real);
    if (size === undefined) return { none: "missing", why: `${icon} isn't a file` };
    if (size > ICON_FILE_MAX_BYTES) return { none: "refused", why: `${icon} is over ${ICON_FILE_MAX_BYTES} bytes` };
    const bytes = f.read(real);
    if (bytes.length > ICON_FILE_MAX_BYTES) return { none: "refused", why: `${icon} is over ${ICON_FILE_MAX_BYTES} bytes` };
    const kind = sniffIcon(bytes);
    if (kind === undefined || /\.([a-z0-9]+)$/i.exec(icon)?.[1]?.toLowerCase() !== kind) return { none: "refused", why: `${icon} isn't the image its name says` };
    if (kind === "svg" && !svgIsInert(new TextDecoder().decode(bytes))) return { none: "refused", why: `${icon} is an SVG that could do more than draw` };
    return { icon: { mediaType: kind === "png" ? "image/png" : "image/svg+xml", data: Buffer.from(bytes).toString("base64"), at: f.now() } };
  }
}

/** The disk, for the reader: real paths, regular files only, a bounded read through a handle that takes no link. */
export function nodeIconFiles(now: () => number = Date.now): IconFiles {
  return {
    realpath(path) {
      try { return realpathSync(path); } catch { return undefined; }
    },
    size(path) {
      try {
        const s = statSync(path);
        return s.isFile() ? s.size : undefined;
      } catch { return undefined; }
    },
    read(path) {
      // O_NOFOLLOW where the OS has it (the last component is already a real path; this closes a swap after it).
      const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const s = fstatSync(fd);
        if (!s.isFile()) throw new Error("not a file");
        if (s.nlink > 1) throw new Error("hard-linked");
        const buf = Buffer.alloc(ICON_FILE_MAX_BYTES + 1);
        let n = 0;
        for (;;) {
          const r = readSync(fd, buf, n, buf.length - n, null);
          if (r === 0 || n + r >= buf.length) { n += r; break; }
          n += r;
        }
        return new Uint8Array(buf.subarray(0, n));
      } finally {
        closeSync(fd);
      }
    },
    now,
  };
}
