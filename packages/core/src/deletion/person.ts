// Deleting for good is the person's alone (the deletion lane; the standing rule: sessions, bots, the account and the
// home are deleted only by the person). One gate for every such method:
//
// * The caller must count as the user (`caller.kind === "user"`): an app or a terminal from outside every sandbox. A
//   bot's or an agent's session (a `cli` inside one), a plugin, a routine, a paired phone, the web page and another
//   computer are refused here, besides the methods' roles (`app`, `cli`) keeping the remote ones off the wire at all.
// * In the person's own terminal the CLI asks for its own typed confirmation first and sends `confirm: true`; without it
//   nothing happens.
// * From an app the engine raises its own sealed card, whose words are the engine's (what goes and what stays), and
//   deletes on the person's yes on that card alone. A page of a plugin can ask, never answer.
import type { ApprovalRequest } from "../contracts/approval-broker";
import { ERR, MOSS_ERR } from "@waifucave/moss-protocol";
import { MethodError, type CardOpener, type MethodContext } from "../devices/rpc";

export type DeletionChange = "account-delete" | "session-delete" | "bot-delete" | "home-erase";

export interface DeletionCard {
  change: DeletionChange;
  title: string;
  what: string;
  /** Each row: a label and the engine's own words (a name the person gave is a row's value, never inside a sentence). */
  rows: { label: string; value: string }[];
}

export function deletionCard(c: DeletionCard): ApprovalRequest {
  return {
    kind: "change", origin: "user", computers: [], effect: "other", change: c.change,
    fields: { title: { type: "text", text: c.title }, what: { type: "text", text: c.what }, detail: { type: "rows", rows: c.rows } },
  } as ApprovalRequest;
}

/** Refuses any caller that isn't the person. */
export function requirePerson(ctx: MethodContext, what: string): void {
  if (ctx.caller.kind !== "user") throw new MethodError(MOSS_ERR.NOT_THE_USER, `only the person can ${what}`);
}

const inTerminal = (ctx: MethodContext): boolean => ctx.caller.kind === "user" && ctx.caller.client === "cli";

/**
 * Runs `run` for the person: at once in their own terminal with `confirm`, else after their yes on the engine's card.
 * The card's answer comes later (`card_resolved`); the app's result is `{applied: false, card}` meanwhile.
 */
export async function byThePerson<T extends object>(
  ctx: MethodContext,
  o: { what: string; confirm: boolean | undefined; openCard: CardOpener; card: DeletionCard; run: () => Promise<T>; onError?(err: unknown): void },
): Promise<({ applied: true } & T) | { applied: false; card: string }> {
  requirePerson(ctx, o.what);
  if (inTerminal(ctx)) {
    if (o.confirm !== true) throw new MethodError(ERR.INVALID_PARAMS, `${o.what}: confirm it in your terminal first (confirm: true)`);
    return { applied: true, ...(await o.run()) };
  }
  const opened = await o.openCard(deletionCard(o.card));
  if (!opened.card) {
    if (!(await opened.allowed)) throw new MethodError(ERR.INVALID_REQUEST, "refused");
    return { applied: true, ...(await o.run()) };
  }
  void opened.allowed.then((ok) => (ok ? o.run() : undefined)).catch((err: unknown) => o.onError?.(err));
  return { applied: false, card: opened.card };
}
