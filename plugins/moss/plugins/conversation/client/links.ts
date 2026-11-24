// The conversation's one rule for links and images (review items 2 and 3).
//
// Links: only absolute http, https and mailto targets ever reach the host's `onOpenLink`. Relative
// (`/x`), protocol-relative (`//host`), `javascript:`, `file:` and every other scheme draw as plain
// text. A `#fragment` (a GFM footnote) scrolls inside the view and never leaves it.
//
// Images: only an asset the host has already resolved loads (`blob:`, an inline `data:image/…`, or the
// app's own `moss-asset:` scheme). Nothing in the conversation ever fetches from the web.

const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** The link's absolute URL when it may open, else undefined. */
export function safeLink(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  // An absolute URL starts with its scheme; anything else would resolve against the app's own page.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (!LINK_SCHEMES.has(url.protocol)) return undefined;
  if (url.protocol !== "mailto:" && url.hostname.length === 0) return undefined;
  return url.href;
}

/** Where a safe link goes, for the reader: an http(s) link's host (with a port if it has one), a mailto link's address. */
export function targetOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol === "mailto:") return decodeURIComponent(u.pathname);
    return u.host.length > 0 ? u.host : undefined;
  } catch {
    return undefined;
  }
}

/** True when the link's visible words already say its target (the URL itself, or just its host), so no host is added beside it. */
export function wordsShowTarget(words: string, url: string): boolean {
  const target = targetOf(url);
  const plain = words.trim().toLowerCase().replace(/^(https?:\/\/|mailto:)/, "").replace(/\/+$/, "");
  if (plain === "") return false;
  const href = url.toLowerCase().replace(/^(https?:\/\/|mailto:)/, "").replace(/\/+$/, "");
  return plain === href || (target !== undefined && plain === target.toLowerCase());
}

/** `#fragment` targets: footnotes and their back-references. */
export function fragmentOf(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string" || !raw.startsWith("#") || raw.length < 2) return undefined;
  return raw.slice(1);
}

const ASSET = /^(blob:|data:image\/(png|jpeg|gif|webp|avif|svg\+xml)[;,]|moss-asset:)/i;

/** An image source the host resolved, else undefined: never an http(s) URL. */
export function safeAsset(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string") return undefined;
  return ASSET.test(raw.trim()) ? raw.trim() : undefined;
}

/** Scrolls to an element with this id inside the same conversation, if there is one. */
export function scrollToFragment(from: Element, id: string): void {
  const root = from.closest(".cl-conv") ?? from.ownerDocument.body;
  for (const el of Array.from(root.querySelectorAll("[id]"))) {
    if (el.id === id) {
      el.scrollIntoView?.({ block: "center" });
      return;
    }
  }
}
