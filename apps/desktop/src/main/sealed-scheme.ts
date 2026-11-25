// The scheme a card page draws in. A card page (the sealed frame of a card, drawn in a window, in the island, or offscreen) takes it
// from a value the app SENDS, never from `prefers-color-scheme` alone: a frame that is hidden, never shown or not yet laid out does
// not re-evaluate its media queries when the Theme changes, so it stayed on the scheme it was made under (a Linux run read nine of
// fifteen card pages light after Dark was chosen). The page's CSS keys on `data-scheme` on its root; `prefers-color-scheme` is only the
// starting guess before the value arrives.
export type Scheme = "dark" | "light";

/** The channel the app tells a card page its scheme on . */
export const SEALED_SCHEME_CHANNEL = "moss:scheme";

export const schemeOf = (dark: boolean): Scheme => (dark ? "dark" : "light");

/** A frame the app can send to: its address and the send. */
export interface SchemeFrame { url: string; send(channel: string, scheme: Scheme): void }

/** Whether a frame is a card's page (a button, the field frames or the core's own page), by its address alone. */
export const isCardFrame = (url: string): boolean => url.startsWith("moss-sealed://card/");

/** Tells every card page among `frames`, shown or not, the scheme. Returns how many were told. */
export function tellCardPages(frames: Iterable<SchemeFrame>, dark: boolean): number {
  let n = 0;
  for (const f of frames) {
    if (!isCardFrame(f.url)) continue;
    try { f.send(SEALED_SCHEME_CHANNEL, schemeOf(dark)); n++; } catch { /* a frame that went away */ }
  }
  return n;
}

/** The card page's side (the preload's): the scheme the app last told it, set on the page's root as `data-scheme` whenever there is a
 *  root. Nothing here waits for the app: a page that is never told keeps no `data-scheme` and draws by `prefers-color-scheme`. */
export function cardPageScheme(root: () => { setAttribute(name: string, value: string): void } | null | undefined): { hear(scheme: unknown): void; apply(): void; readonly told: Scheme | undefined } {
  let told: Scheme | undefined;
  const apply = () => { const r = root(); if (told !== undefined && r) r.setAttribute("data-scheme", told); };
  return {
    hear(scheme: unknown) { if (scheme === "dark" || scheme === "light") { told = scheme; apply(); } },
    apply,
    get told() { return told; },
  };
}
