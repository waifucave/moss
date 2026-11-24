// The docs' Markdown, rendered by Bun's own Markdown (`Bun.markdown.html`, GitHub's flavour: tables included), then
// given what a docs page needs: an id and an anchor on every h2 and h3, wide tables in a scroller, and pictures of the
// apps, written in the Markdown as one line of their own:
//
//   {{picture moss-panel "What the picture shows" "Its caption"}}
import { esc } from "./html";
import { picture } from "./pictures";

export interface FrontMatter {
  title: string;
  description: string;
}

export interface Heading {
  level: 2 | 3;
  id: string;
  text: string;
}

export interface RenderedDoc {
  meta: FrontMatter;
  html: string;
  headings: Heading[];
  /** The page's words without markup, for the search index. */
  text: string;
}

/** Splits `---`-fenced `key: value` lines off the top of a page. Only `title` and `description` are read. */
export function frontMatter(source: string, file: string): { meta: FrontMatter; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (m === null) throw new Error(`${file}: no front matter (--- title: … description: … ---)`);
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv !== null) fields[kv[1]!] = kv[2]!.trim();
  }
  if (!fields.title || !fields.description) throw new Error(`${file}: front matter needs a title and a description`);
  return { meta: { title: fields.title, description: fields.description }, body: source.slice(m[0].length) };
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/<[^>]+>/g, "").replace(/&[a-z#0-9]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "section";
}

export function stripTags(markup: string): string {
  return markup.replace(/<[^>]+>/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

const PICTURE_LINE = /^\{\{picture ([a-z0-9-]+) "([^"]*)"(?: "([^"]*)")?\}\}$/;
const BLOCK_LINE = /^\{\{([a-z-]+)\}\}$/;

/** Markup a page can ask for by name on a line of its own (`{{release-files}}`), built from the repository's own data. */
export type Blocks = Readonly<Record<string, () => string>>;

export function renderDoc(source: string, file: string, blocks: Blocks = {}): RenderedDoc {
  const { meta, body } = frontMatter(source, file);
  // Pictures and blocks first: each becomes a placeholder paragraph the renderer leaves alone, and is put back after.
  const held: string[] = [];
  const md = body.split("\n").map((line) => {
    const p = PICTURE_LINE.exec(line.trim());
    const b = BLOCK_LINE.exec(line.trim());
    if (p !== null) held.push(picture({ name: p[1]!, alt: p[2]!, ...(p[3] !== undefined ? { caption: p[3] } : {}) }).html);
    else if (b !== null) {
      const make = blocks[b[1]!];
      if (make === undefined) throw new Error(`${file}: no block called {{${b[1]}}}`);
      held.push(make());
    } else return line;
    return `\nPICTUREHOLDER${held.length - 1}\n`;
  }).join("\n");
  let out = Bun.markdown.html(md);
  out = out.replace(/<p>PICTUREHOLDER(\d+)<\/p>/g, (_m, i: string) => held[Number(i)]!);
  if (/PICTUREHOLDER/.test(out)) throw new Error(`${file}: a picture or block line wasn't on a line of its own`);
  // Headings: an id, unique on the page, and an anchor to it.
  const headings: Heading[] = [];
  const used = new Set<string>();
  out = out.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_m, level: string, inner: string) => {
    let id = slugify(stripTags(inner));
    for (let n = 2; used.has(id); n++) id = `${slugify(stripTags(inner))}-${n}`;
    used.add(id);
    headings.push({ level: Number(level) as 2 | 3, id, text: stripTags(inner) });
    return `<h${level} id="${id}">${inner}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`;
  });
  out = out.replace(/<table>/g, '<div class="table"><table>').replace(/<\/table>/g, "</table></div>");
  out = out.replace(/<pre>/g, '<div class="codeblock"><pre>').replace(/<\/pre>/g, "</pre></div>");
  if (/<h1[\s>]/.test(out)) throw new Error(`${file}: the page's title is its front matter's; no # heading in the body`);
  return { meta, html: out, headings, text: stripTags(out.replace(/<figure[\s\S]*?<\/figure>/g, " ")) };
}

/** One short piece of `text` around the first place `words` appear, for a search hit. */
export function snippet(text: string, max = 160): string {
  return esc(text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, "")}…`);
}
