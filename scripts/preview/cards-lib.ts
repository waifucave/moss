// `ctl cards` and `ctl approve`: which pending card a person means, and what it says. Pure, so the choosing is tested without an engine.
// Never a sweep: a card is answered only when it is NAMED, by its id or by its session (and then only when that session has exactly one pending card).

export interface CardRow {
  id: string;
  hash: string;
  kind?: string;
  session?: string;
  bot?: string;
  fields?: Record<string, { type?: string; text?: string } | undefined>;
  options: { id: string; kind: string; label?: string; remember?: string }[];
}

export interface Placed { kind?: string; program?: string; window?: string }

/** The card's own words for what it asks: its title, else what it says, else its kind. */
export function cardTitle(c: CardRow): string {
  const t = c.fields?.title?.text ?? c.fields?.what?.text;
  return t !== undefined && t !== "" ? t.replace(/\s+/g, " ").slice(0, 120) : (c.kind ?? "a card");
}

/** Where a card is drawn, in words. */
export function placeWords(p: Placed | undefined): string {
  if (p === undefined || p.kind === undefined) return "not placed yet";
  if (p.kind === "conversation" || p.kind === "strip") return `${p.kind === "strip" ? "the window's strip" : "the conversation"} (${p.program ?? "?"} window ${p.window ?? "?"})`;
  if (p.kind === "island") return "the island (this preview has none)";
  if (p.kind === "elsewhere") return "nowhere on this computer";
  return p.kind;
}

/** The one card named by `id`, or by `session` when that session has exactly one pending card; otherwise why not. */
export function chooseCard(cards: readonly CardRow[], sel: { id?: string; session?: string }): { card: CardRow } | { error: string } {
  if (sel.id !== undefined) {
    const c = cards.find((x) => x.id === sel.id);
    return c === undefined ? { error: `no pending card ${sel.id} (ctl cards lists them)` } : { card: c };
  }
  if (sel.session !== undefined) {
    const mine = cards.filter((x) => x.session === sel.session);
    if (mine.length === 1) return { card: mine[0]! };
    return { error: mine.length === 0 ? `session ${sel.session} has no pending card` : `session ${sel.session} has ${mine.length} pending cards (${mine.map((x) => x.id).join(", ")}): name one by its id` };
  }
  return { error: "name the card: ctl approve <card-id> or ctl approve --session <id>" };
}

/** The option an answer takes: the first of the wanted kind that is not a saved "always" rule (an answer here never saves a rule). */
export function chooseOption(card: CardRow, deny: boolean): { id: string; label?: string } | undefined {
  const kind = deny ? "deny" : "approve";
  return card.options.find((o) => o.kind === kind && o.remember === undefined);
}
