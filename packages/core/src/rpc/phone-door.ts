// The one test a door that a paired phone's connection (`remote`) may use goes through. `agent.start` (PH2), `bot.create`,
// `session.stageFile` and `session.composerOffers` (PH3) all ask it: a phone is never let in on the strength of the connection
// alone, only on the registry's record of its device read at the moment of the call (so a revocation that races the call ends it).
import type { Caller } from "@waifucave/moss-protocol";
import { ContractError } from "../contracts/common";

type UserCaller = Extract<Caller, { kind: "user" }>;

/** A caller that is neither this computer's app nor its terminal: a paired phone's connection (`remote`). Tested the other
 *  way round so that a client label added later is held to the phone rules until someone says otherwise. */
export function isPhoneCaller(caller: Caller): caller is UserCaller {
  return caller.kind === "user" && caller.client !== "app" && caller.client !== "cli";
}

/** Whether `device` is a paired phone that holds an answer key and isn't revoked now (`mayStartSessions` over the registry). */
export type PhoneMay = (device: string) => boolean;

/** Lets a call from this computer's own app or terminal through, and a phone's only while `may` says its device is a paired,
 *  unrevoked phone with an answer key. A phone that names no device, or an engine wired with no gate, is refused. */
export function requirePairedPhone(caller: UserCaller, may: PhoneMay | undefined, what: string): void {
  if (!isPhoneCaller(caller)) return;
  if (caller.device === undefined || may?.(caller.device) !== true) {
    throw new ContractError("refused", `this phone isn't paired with an answer key any more, so it can't ${what} here`);
  }
}
