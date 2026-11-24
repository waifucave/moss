// Deleting the waifucave account from this computer (the deletion lane, item 1; spec §14.2 item 27). The order:
//
//   1. A marker in the home (`account-deletion.json`: the account id and when, nothing else) says a deletion was asked
//      for, before anything is sent, so a crash or a quit in the middle is finished at the next start (`resume`).
//   2. The account service is asked (`AccountClient.deleteAccount`, signed by this device). From its answer on, the
//      account is refused everywhere at waifucave and the service finishes the rest itself (the other services, then
//      the sign-in), retrying until each confirms. Asked again it answers how far that got.
//   3. What the account put on this computer goes (`endAccountHere`): the sign-in session, the devices the account
//      alone brought in (forgotten, not revoked: they stay the person's, and can be paired again), and the revoke
//      steps that would tell the account's services. What stays: everything else in the home (conversations, bots,
//      memory, settings, files, keys of providers) and the devices paired by code.
//   4. The marker goes.
//
// A deletion that half happened: before 2's answer, the account is untouched and the marker makes the next start (or
// the next ask) send it again; after it, the service owns the rest, and only 3 is left here. Once the sign-in itself is
// deleted the service answers 401 to this device's session, which (with the marker saying it was sent) is the
// deletion done, never a reason to ask again.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ContractError } from "../contracts/common";
import type { FileDeviceRegistry } from "../devices/registry";
import type { AccountClient, AccountDeletionStep } from "./account";

export const ACCOUNT_DELETION_FILE = "account-deletion.json";

interface Marker {
  v: 1;
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

const markerPath = (home: string) => join(home, ACCOUNT_DELETION_FILE);

function readMarker(home: string): Marker | undefined {
  try {
    const m = JSON.parse(readFileSync(markerPath(home), "utf8")) as Marker;
    return m && m.v === 1 && typeof m.account === "string" && typeof m.askedAt === "number" ? m : undefined;
  } catch {
    return undefined;
  }
}

function writeMarker(home: string, m: Marker): void {
  const tmp = `${markerPath(home)}.tmp`;
  writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
  renameSync(tmp, markerPath(home));
}

/** What the account put on this computer goes: its session, the devices it alone brought in, its revoke steps. */
export async function endAccountHere(deps: Pick<AccountDeletionDeps, "account" | "registry" | "log">): Promise<string[]> {
  await deps.account.forgetSession();
  deps.registry?.dropAccountRevokeSteps();
  const forgotten = deps.registry?.forgetAccountDevices() ?? [];
  deps.log?.(`[account] the account ended: its session is gone here${forgotten.length > 0 ? `, and ${forgotten.length} device(s) it brought in are forgotten` : ""}`);
  return forgotten;
}

/** Deletes the account (or finishes a deletion begun before), then what it put here. */
export async function deleteAccount(deps: AccountDeletionDeps): Promise<AccountDeletionOutcome> {
  const account = await deps.account.accountId();
  let marker = readMarker(deps.home);
  if (account === null) {
    // Signed out: only a deletion begun before can be finished, here alone (the service owns the rest, or the session
    // that could ask it is gone).
    if (!marker) throw new ContractError("refused", "this computer isn't signed in to an account");
    const forgotten = await endAccountHere(deps);
    rmSync(markerPath(deps.home), { force: true });
    return { pending: [], forgotten };
  }
  if (!marker || marker.account !== account) {
    marker = { v: 1, account, askedAt: deps.clock.now() };
    writeMarker(deps.home, marker);
  }
  let pending: AccountDeletionStep[];
  try {
    pending = (await deps.account.deleteAccount()).pending;
  } catch (err) {
    // The service answered before and the sign-in is gone now: the deletion is done there.
    const signInGone = err instanceof ContractError && err.code === "refused" && marker.answeredAt !== undefined;
    if (!signInGone) throw err;
    pending = [];
  }
  writeMarker(deps.home, { ...marker, answeredAt: marker.answeredAt ?? deps.clock.now() });
  const forgotten = await endAccountHere(deps);
  rmSync(markerPath(deps.home), { force: true });
  return { pending, forgotten };
}

/** At start: a deletion the last run began is finished. Never throws; a failure leaves the marker for the next try. */
export async function resumeAccountDeletion(deps: AccountDeletionDeps): Promise<AccountDeletionOutcome | undefined> {
  if (!existsSync(markerPath(deps.home))) return undefined;
  try {
    const out = await deleteAccount(deps);
    deps.log?.(`[account] finished the account's deletion begun before${out.pending.length > 0 ? `; waifucave still confirms: ${out.pending.join(", ")}` : ""}`);
    return out;
  } catch (err) {
    deps.log?.(`[account] the account's deletion begun before isn't finished yet (${err instanceof Error ? err.name : "error"}): tried again at the next start or ask`);
    return undefined;
  }
}
