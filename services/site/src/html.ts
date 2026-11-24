// A tagged template for the site's pages: every value is escaped unless it is already markup (`Html`), arrays are
// joined, and null, undefined and false leave nothing. No dependency: the pages are strings.

export interface Html {
  readonly html: string;
}

const isHtml = (v: unknown): v is Html => typeof v === "object" && v !== null && "html" in v && typeof (v as Html).html === "string";

export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Markup that is already safe (built by `html`, or the Markdown renderer's output). */
export function raw(markup: string): Html {
  return { html: markup };
}

function part(v: unknown): string {
  if (v === null || v === undefined || v === false) return "";
  if (Array.isArray(v)) return v.map(part).join("");
  if (isHtml(v)) return v.html;
  return esc(String(v));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) out += part(values[i]) + (strings[i + 1] ?? "");
  return { html: out };
}

/** Folds the indentation and blank lines a template's own layout leaves, so the pages stay small. Inside <pre>, nothing
 *  is touched. */
export function tidy(page: string): string {
  return page
    .split(/(<pre[\s\S]*?<\/pre>)/)
    .map((chunk, i) => (i % 2 === 1 ? chunk : chunk.replace(/\n[ \t]+/g, "\n").replace(/\n{2,}/g, "\n")))
    .join("")
    .trim() + "\n";
}
