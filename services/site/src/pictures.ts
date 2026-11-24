// Pictures of the real apps (public/pictures, with SOURCES.md saying where each came from). Every picture has a light
// and a dark file; the page shows the one that matches the visitor's system. A picture with a narrow file
// (`<name>-narrow-<theme>.png`) shows that one on a phone-sized screen. Width and height come from the files, so the
// page never jumps while a picture loads.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SITE_DIR } from "./config";
import { html, type Html } from "./html";

const DIR = join(SITE_DIR, "public", "pictures");

/** A PNG's width and height, from its header. */
export function pngSize(file: string): { width: number; height: number } {
  const b = readFileSync(file);
  if (b.length < 24 || b.toString("latin1", 1, 4) !== "PNG") throw new Error(`${file} is not a PNG`);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

export interface PictureSpec {
  /** The file name's stem: public/pictures/<name>-light.png and <name>-dark.png. */
  name: string;
  /** What the picture shows, for a reader who can't see it. */
  alt: string;
  caption?: string;
  /** Drawn at its own size or smaller, never wider (the card). */
  small?: boolean;
  /** The pixel density the file was rendered at: 2 for a 2x render, so it is drawn at half its pixel width. */
  density?: number;
}

export function picture(p: PictureSpec): Html {
  const file = (theme: string, narrow = false) => `${p.name}${narrow ? "-narrow" : ""}-${theme}.png`;
  for (const t of ["light", "dark"]) if (!existsSync(join(DIR, file(t)))) throw new Error(`public/pictures/${file(t)} is missing`);
  const narrow = existsSync(join(DIR, file("light", true))) && existsSync(join(DIR, file("dark", true)));
  const size = pngSize(join(DIR, file("light")));
  const density = p.density ?? (size.width > 2000 ? 2 : 1);
  const w = Math.round(size.width / density), h = Math.round(size.height / density);
  const ns = narrow ? pngSize(join(DIR, file("light", true))) : undefined;
  const nw = ns === undefined ? 0 : Math.round(ns.width / density), nh = ns === undefined ? 0 : Math.round(ns.height / density);
  return html`<figure class="pic${p.small === true ? " pic--small" : ""}">
<picture>
${narrow ? html`<source media="(max-width: 700px) and (prefers-color-scheme: dark)" srcset="/pictures/${file("dark", true)}" width="${nw}" height="${nh}">
<source media="(max-width: 700px)" srcset="/pictures/${file("light", true)}" width="${nw}" height="${nh}">` : ""}
<source media="(prefers-color-scheme: dark)" srcset="/pictures/${file("dark")}">
<img src="/pictures/${file("light")}" width="${w}" height="${h}" alt="${p.alt}" loading="lazy" decoding="async">
</picture>
${p.caption !== undefined ? html`<figcaption>${p.caption}</figcaption>` : ""}
</figure>`;
}
