// The theme tokens the canvas wears, by the catalog's names (`packages/plugin-sdk/src/catalogs/tokens.ts`):
// `color.text.muted` arrives in CSS as `--moss-color-text-muted`. test/styles.test.ts fails if styles.css uses a token
// this list doesn't name, or this list names one styles.css doesn't use. An agent's own colour is not a token: it is
// data from its plugin (`agent.backends`), set on each block as `--brand`.

/** Tokens from the catalog. */
export const CATALOG_TOKENS = [
  "color.canvas",
  "color.control",
  "color.danger",
  "color.float",
  "color.focus",
  "color.hairline",
  "color.hairline.raised",
  "color.hover",
  "color.raised",
  "color.surface",
  "color.text",
  "color.text.muted",
  "color.text.placeholder",
  "color.text.secondary",
  "font.line.body",
  "font.line.code",
  "font.line.tight",
  "font.mono",
  "font.sans",
  "font.size.caption",
  "font.size.control",
  "font.size.heading",
  "font.size.label",
  "font.size.tiny",
  "font.weight.medium",
  "font.weight.regular",
  "font.weight.semibold",
  "motion.fast",
  "radius.large",
  "radius.medium",
  "radius.round",
  "shadow.float",
  "space.l",
  "space.m",
  "space.s",
  "space.xl",
] as const;

/** The canvas's own tokens: none. (MOSS's coral for a bot and MOSS's coding agent is data, `MOSS_CORAL` in look.ts,
 *  until the catalog has a token for it; asked of the catalog's owner in the lane's report.) */
export const PART_TOKENS: readonly string[] = [];

export const TOKENS: readonly string[] = [...CATALOG_TOKENS, ...PART_TOKENS];

/** `color.text.muted` → `--moss-color-text-muted`. */
export const cssVariable = (token: string) => `--moss-${token.replace(/-/g, "_").replace(/\./g, "-")}`;
