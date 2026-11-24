// Deleting the waifucave account from this computer (the deletion lane, item 1; spec §14.2 item 27). The order:
//
//   1. The account service is asked (`AccountClient.deleteAccount`, signed by this device). A request that never reached
//      it, or that it refused, leaves nothing behind: the person is told it failed and asks again. Nothing here ever
//      sends a deletion the person didn't just ask for.
//   2. From the service's answer on, the account is refused everywhere at waifucave and the service finishes the rest
//      itself (the other services, then the sign-in), retrying until each confirms. A marker (the account id and when the
//      service accepted, nothing else) is then kept as a device item in the secret store, not a file a plugin could plant
//      in the home, so a stop before 3 is finished at the next start.
//   3. What the account put on this computer goes (`endAccountHere`): the sign-in session, the devices the account
//      alone brought in (forgotten, not revoked: they stay the person's, and can be paired again), and the revoke
//      steps that would tell the account's services. What stays: everything else in the home (conversations, bots,
//      memory, settings, files, keys of providers) and the devices paired by code.
//   4. The marker goes. Signing out or signing in clears it too.
//
// At start (`resume`) a marker finishes only the local part (3), and only while the account it names is the one signed in
// here, or none is: a marker naming another account is cleared and nothing else happens (that account's session was
// already replaced by the sign-in that put the other one here). A marker the service never accepted is cleared unused.
import { ContractError } from "../contracts/common";
import type { FileDeviceRegistry } from "../devices/registry";
import type { AccountClient, AccountDeletionStep } from "./account";

interface Marker {
  account: string;
  askedAt: number;
  /** When the account service first answered: from then on the deletion is the service's to finish. */
  answeredAt?: number;
}

export interface AccountDeletionDeps {
  home: string;
  account: AccountClient;
  registry?: Pick<FileDeviceRegistry, "forgetAccountDevices" | "dropAccountRevokeSteps">;
  clock: { now(): number };
  log?(line: string): void;
}

export interface AccountDeletionOutcome {
  /** The steps the account service hasn't confirmed yet; it keeps trying them on its own. */
  pending: AccountDeletionStep[];
  /** The devices forgotten here. */
  forgotten: string[];
}

/** What the account put on this computer goes: its session, the devices it alone brought in, its revoke steps. */
export async function endAccountHere(deps: Pick<AccountDeletionDeps, "account" | "registry" | "log">): Promise<string[]> {
  await deps.account.forgetSession();
  deps.registry?.dropAccountRevokeSteps();
  const forgotten = deps.registry?.forgetAccountDevices() ?? [];
  deps.log?.(`[account] the account ended: its session is gone here${forgotten.length > 0 ? `, and ${forgotten.length} device(s) it brought in are forgotten` : ""}`);
  return forgotten;
}

/** Deletes the account the person just asked to delete, then what it put here. */
export async function deleteAccount(deps: AccountDeletionDeps): Promise<AccountDeletionOutcome> {
  const account = await deps.account.accountId();
  const marker: Marker | null = await deps.account.deletionMark();
  if (account === null) {
    // Signed out: only a deletion the service already accepted can be finished, here alone.
    if (!marker || marker.answeredAt === undefined) throw new ContractError("refused", "this computer isn't signed in to an account");
    return finishHere(deps);
  }
  let pending: AccountDeletionStep[];
  try {
    pending = (await deps.account.deleteAccount()).pending;
  } catch (err) {
    // The service accepted this account's deletion before and its sign-in is gone now: done there.
    const accepted = marker !== null && marker.account === account && marker.answeredAt !== undefined;
    if (!(accepted && err instanceof ContractError && err.code === "refused")) throw err;
    pending = [];
  }
  const now = deps.clock.now();
  await deps.account.setDeletionMark({ account, askedAt: marker?.account === account ? marker.askedAt : now, answeredAt: marker?.account === account && marker.answeredAt !== undefined ? marker.answeredAt : now });
  const out = await finishHere(deps);
  return { pending, forgotten: out.forgotten };
}

async function finishHere(deps: AccountDeletionDeps): Promise<AccountDeletionOutcome> {
  const forgotten = await endAccountHere(deps);
  await deps.account.clearDeletionMark();
  return { pending: [], forgotten };
}

/** At start: the local part of a deletion the service accepted before a stop. Never sends anything; never throws. */
export async function resumeAccountDeletion(deps: AccountDeletionDeps): Promise<AccountDeletionOutcome | undefined> {
  try {
    const marker = await deps.account.deletionMark();
    if (marker === null) return undefined;
    const account = await deps.account.accountId();
    if (marker.answeredAt === undefined || (account !== null && account !== marker.account)) {
      await deps.account.clearDeletionMark();
      deps.log?.("[account] dropped a deletion marker that can't apply here (not accepted by the service, or another account is signed in)");
      return undefined;
    }
    const out = await finishHere(deps);
    deps.log?.("[account] finished, on this computer, the account's deletion the service had accepted before a stop");
    return out;
  } catch (err) {
    deps.log?.(`[account] the account's deletion isn't finished on this computer yet (${err instanceof Error ? err.name : "error"}): tried again at the next start`);
    return undefined;
  }
}
