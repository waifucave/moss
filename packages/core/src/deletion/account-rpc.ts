// `account.delete` (the deletion lane, item 1): the person deletes their waifucave account from an app (on the engine's
// card) or their own terminal. The work is `identity/account-deletion.ts`'s.
import { DEVICES_METHODS } from "@waifucave/moss-protocol";
import { ContractError } from "../contracts/common";
import type { FileDeviceRegistry } from "../devices/registry";
import { handler, MethodError, type CardOpener, type MethodHandler } from "../devices/rpc";
import type { AccountClient } from "../identity/account";
import { deleteAccount } from "../identity/account-deletion";
import { byThePerson } from "./person";
import { ERR } from "@waifucave/moss-protocol";

export interface AccountDeletionMethodsDeps {
  home: string;
  account?: AccountClient;
  registry?: Pick<FileDeviceRegistry, "forgetAccountDevices" | "dropAccountRevokeSteps">;
  clock: { now(): number };
  openCard: CardOpener;
  log?(line: string): void;
}

/** The card's words: what goes at waifucave and here, and what stays. */
export const ACCOUNT_DELETE_CARD = {
  change: "account-delete" as const,
  title: "Delete your MOSS account?",
  what: "This deletes your account at waifucave for good. It can't be undone.",
  rows: [
    { label: "Deleted at waifucave", value: "your sign-in (email, and Discord or Google if used), your devices' list with their names and keys, your phones' push addresses, your computers' webhook keys and the webhooks waiting for them, and your account's connection records" },
    { label: "Removed from this computer", value: "your sign-in, and the devices only your account added" },
    { label: "Your other computers and phones", value: "they sign out the next time they reach waifucave" },
    { label: "Stays on this computer", value: "your conversations, bots, memory, settings and files, your providers' keys, and devices you paired by code" },
  ],
};

export function accountDeletionMethods(deps: AccountDeletionMethodsDeps): Record<string, MethodHandler> {
  const M = DEVICES_METHODS;
  return {
    [M.accountDelete.name]: handler(M.accountDelete, async (p, ctx) => {
      const account = deps.account;
      if (!account) throw new MethodError(ERR.INVALID_REQUEST, "accounts aren't set up on this computer");
      if ((await account.accountId()) === null) throw new ContractError("refused", "this computer isn't signed in to an account");
      return byThePerson(ctx, {
        what: "delete the account", confirm: p.confirm, openCard: deps.openCard, card: ACCOUNT_DELETE_CARD,
        run: async () => {
          const out = await deleteAccount({ home: deps.home, account, ...(deps.registry ? { registry: deps.registry } : {}), clock: deps.clock, ...(deps.log ? { log: deps.log } : {}) });
          return { pending: out.pending };
        },
        onError: (err) => deps.log?.(`[account] the deletion asked on the card didn't finish (${err instanceof Error ? err.name : "error"}): it is finished at the next start`),
      });
    }),
  };
}
