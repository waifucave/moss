// The BackendIcons conformance suite (spec revision 20, §9.5). `runBackendIconsConformance(make)` registers every case
// against the reader `make` builds over the files it is given; `tests/backend-icons.test.ts` runs it against
// FakeBackendIcons, and lane CA against the engine's reader (over a temp plugin folder, real symlinks included).
import { describe, expect, test } from "bun:test";
import { ICON_FILE_MAX_BYTES } from "@waifucave/moss-protocol";
import { normalizePosix } from "../common";
import { sniffIcon, svgIsInert, type BackendIcons, type IconFiles } from "../backend-icons";

export type BackendIconsFactory = (files: IconFiles) => BackendIcons;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const enc = (s: string) => new TextEncoder().encode(s);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="url(#g)" d="M0 0h24v24z"/></svg>';

/** In-memory files with symlinks (`{ link }`), resolved as `realpath` does. */
export function iconFiles(files: Record<string, Uint8Array | { link: string }>): IconFiles {
  const resolve = (p: string, depth = 0): string | undefined => {
    if (depth > 16) return undefined;
    const parts = normalizePosix(p).split("/").filter(Boolean);
    let cur = "";
    for (let i = 0; i < parts.length; i++) {
      cur = `${cur}/${parts[i]}`;
      const f = files[cur];
      if (f !== undefined && "link" in f) return resolve([f.link.startsWith("/") ? f.link : normalizePosix(`${cur}/../${f.link}`), ...parts.slice(i + 1)].join("/"), depth + 1);
    }
    return files[cur] !== undefined || Object.keys(files).some((k) => k.startsWith(`${cur}/`)) ? cur : undefined;
  };
  const file = (p: string) => { const f = files[p]; return f !== undefined && !("link" in f) ? f : undefined; };
  return { realpath: (p) => resolve(p), size: (p) => file(p)?.length, read: (p) => file(p) ?? new Uint8Array(), now: () => 42 };
}

const ROOT = "/home/plugins/agent-codex";

export function runBackendIconsConformance(make: BackendIconsFactory): void {
  describe("BackendIcons", () => {
    test("a PNG or an inert SVG in the plugin's folder is served inline, as an image only", async () => {
      const r = make(iconFiles({ [`${ROOT}/marks/codex.svg`]: enc(SVG), [`${ROOT}/marks/codex.png`]: PNG, [`${ROOT}/moss.json`]: enc("{}") }));
      expect(await r.read(ROOT, "marks/codex.svg")).toEqual({ icon: { mediaType: "image/svg+xml", data: Buffer.from(SVG).toString("base64"), at: 42 } });
      expect(await r.read(ROOT, "marks/codex.png")).toMatchObject({ icon: { mediaType: "image/png" } });
    });

    test("refused, never a throw: oversized, an SVG with a script, a handler, a foreignObject or an outside reference, a misnamed file", async () => {
      const big = new Uint8Array(ICON_FILE_MAX_BYTES + 1);
      big.set(PNG);
      const bad: Record<string, Uint8Array> = {
        "big.png": big,
        "script.svg": enc('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        "onload.svg": enc('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>'),
        "fo.svg": enc('<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>'),
        "href.svg": enc('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>'),
        "css.svg": enc('<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://e.com/x)"/></svg>'),
        "png-named.svg": PNG,
        "text.png": enc("not an image"),
      };
      const r = make(iconFiles(Object.fromEntries(Object.entries(bad).map(([k, v]) => [`${ROOT}/${k}`, v]))));
      for (const name of Object.keys(bad)) expect([name, (await r.read(ROOT, name)) as unknown]).toMatchObject([name, { none: "refused" }]);
    });

    test("a symlink out of the plugin's folder is refused; a missing file is no icon", async () => {
      const r = make(iconFiles({ [`${ROOT}/mark.png`]: { link: "/Users/p/Pictures/secret.png" }, ["/Users/p/Pictures/secret.png"]: PNG, [`${ROOT}/moss.json`]: enc("{}") }));
      expect(await r.read(ROOT, "mark.png")).toMatchObject({ none: "refused" });
      expect(await r.read(ROOT, "nothing.png")).toMatchObject({ none: "missing" });
    });

    test("the checks are the bytes' own", () => {
      expect([sniffIcon(PNG), sniffIcon(enc(`<?xml version="1.0"?>\n${SVG}`)), sniffIcon(enc("GIF89a"))]).toEqual(["png", "svg", undefined]);
      expect(svgIsInert(SVG)).toBe(true);
      expect(svgIsInert('<svg><!DOCTYPE x [<!ENTITY a "b">]></svg>')).toBe(false);
      expect(svgIsInert('<svg><use xlink:href="other.svg#a"/></svg>')).toBe(false);
      expect(svgIsInert('<svg><use xlink:href="#a"/></svg>')).toBe(true);
    });
  });
}
