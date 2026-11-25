// The waifucave account token a plugin's keyed fetch adds (`net.fetch` with `auth: "waifucave"`, spec §5.4 item 84):
// one source per account client, minted per audience from the account session (`AccountClient.mint`, which never
// syncs) and cached per host for at most five minutes (`mintedTokenSource`). Signed out, it gives none, and the fetch
// fails `no_account`.
import { mintedTokenSource, type KeyedTokenSource } from "../contracts/secret-store";
import type { AccountClient } from "./account";

const sources = new WeakMap<Pick<AccountClient, "mint">, KeyedTokenSource>();

/** This computer's account tokens, or undefined while no account is set up here. */
export function accountTokenSource(account: Pick<AccountClient, "mint"> | undefined, clock: { now(): number }): KeyedTokenSource | undefined {
  if (account === undefined) return undefined;
  let source = sources.get(account);
  if (source === undefined) {
    source = mintedTokenSource((audience) => account.mint(audience), clock);
    sources.set(account, source);
  }
  return source;
}
