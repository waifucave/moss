// FakeBackendIcons: the reader over in-memory files the test gives. Its rules are the real reader's.
import { ICON_FILE_MAX_BYTES } from "@waifucave/moss-protocol";
import { isInside, normalizePosix } from "../common";
import { sniffIcon, svgIsInert, type BackendIcons, type IconFiles, type IconRead } from "../backend-icons";

export class FakeBackendIcons implements BackendIcons {
  constructor(private readonly files: IconFiles) {}

  async read(pluginRoot: string, icon: string): Promise<IconRead> {
    const f = this.files;
    const root = f.realpath(pluginRoot);
    const real = f.realpath(normalizePosix(`${pluginRoot}/${icon}`));
    if (root === undefined || real === undefined) return { none: "missing", why: `${icon} isn't in the plugin's folder` };
    if (!isInside(real, root)) return { none: "refused", why: `${icon} leads outside the plugin's folder` };
    const size = f.size(real);
    if (size === undefined) return { none: "missing", why: `${icon} isn't a file` };
    if (size > ICON_FILE_MAX_BYTES) return { none: "refused", why: `${icon} is over ${ICON_FILE_MAX_BYTES} bytes` };
    const bytes = f.read(real);
    const kind = sniffIcon(bytes);
    if (kind === undefined || /\.([a-z0-9]+)$/i.exec(icon)?.[1]?.toLowerCase() !== kind) return { none: "refused", why: `${icon} isn't the image its name says` };
    if (kind === "svg" && !svgIsInert(new TextDecoder().decode(bytes))) return { none: "refused", why: `${icon} is an SVG that could do more than draw` };
    return { icon: { mediaType: kind === "png" ? "image/png" : "image/svg+xml", data: Buffer.from(bytes).toString("base64"), at: f.now() } };
  }
}
