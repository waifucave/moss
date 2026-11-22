// MOSS's named secrets on Windows and Linux (spec §9.1 "The secret store", §8.5; spike S8): a `Bun.secrets`-shaped
// backend over the encrypted secrets file, so every reader and writer of the flat-name store (`KeychainSecretStore`: the
// provider keys, the sign-in tokens, the pairing tokens, the MCP sign-ins) goes through the ONE file the contract store
// (`MossSecretStore`) keeps its items in, and none reaches the OS store (Credential Manager, the Secret Service) any
// more. The OS store holds only the file's key.
//
//   * Items are `kc/<service>/<name>` in the file; the contract store's are `core/…`, `plugin:<id>/…`, `device/…`, so
//     the two never meet, and one file (one key, one lock) holds both.
//   * The key's source is `chooseFileStore`'s, the contract store's own decision. A key that can't be reached makes
//     every call throw `locked` (the way `Bun.secrets` throws when the keyring does not answer): a read never answers
//     "nothing there" for a store it could not open, because the callers mint a new token for a missing one
//     (`TokenAuthority.ensureTokens`) and would unpair every device.
//   * The first time the file is opened, what the OS store holds of MOSS's own is moved into it (`moveOsStoreItems`).
// Nothing here logs or throws a value.
import { join } from "node:path";
import { ContractError } from "../contracts/common";
import { MIGRATION_B_SECRET_NAMES } from "../auth/legacy-secret-names";
import { osSecretsBackend } from "../auth/secret-store";
import { chooseFileStore, EncryptedFileValues, type BatchValues, type CredsRunner, type SystemdCreds, type Vault } from "./moss-secret-store";
import type { PrivateFileStep } from "./private-file";
import { SECRETS_FILE_NAME } from "./secret-files";

export type SecretsBackend = Pick<typeof Bun.secrets, "get" | "set" | "delete">;

/** A flat-name item's key in the file. */
export const itemKey = (service: string, name: string) => `kc/${service}/${name}`;
/** The note, in the file, that a service's items were moved out of the OS store. */
export const movedMarkKey = (service: string) => `mark/os-store-moved/${service}`;

/** The names of MOSS's own items in the OS store: `Bun.secrets` has no list on Windows or Linux, so these are the
 *  known names: the provider slots (every one the catalog gives an API key), the sign-in and pairing tokens, the
 *  tool keys (`MIGRATION_B_SECRET_NAMES`, the inventory the older-home migration walks too). The names made from an id at
 *  run time (`mcp-oauth:<id>` and its client records) cannot be listed and are not moved: those sign-ins are made again. */
export function osStoreItemNames(): string[] {
  const names = new Set<string>(MIGRATION_B_SECRET_NAMES);
  try {
    const { credentialInventory } = require("../runtime-sdk/keychain") as typeof import("../runtime-sdk/keychain");
    for (const slot of credentialInventory()) names.add(slot.secretName);
  } catch { /* the catalog did not load: the fixed names still move */ }
  return [...names];
}

/** How long the OS store gets to answer the first read before the move is left for the next start. */
const OS_STORE_PROBE_MS = 5_000;

export type MoveResult = "moved" | "nothing" | "unreachable" | "partial" | "done-before";

/** The one-time move of what the OS store holds into the file. Idempotent and safe to stop anywhere (a power cut too):
 *   1. every known name is read from the OS store;
 *   2. in ONE hold of the file's lock (a daemon and a CLI starting together cannot each write what the other's read made
 *      stale), the file is read and every item it does not hold yet is added, a value the file already has being the
 *      newer one and kept; the file is written whole, durably (flushed, renamed, the rename flushed: `writePrivateFile`);
 *   3. only after that returns is an original deleted from the OS store, and only when the file's value is the same;
 *   4. the note that it is done is written last, and only when every name was read.
 *  So at every instant each secret is readable from the file or from the OS store, and a power cut inside the disk's
 *  commit window can lose only a copy that was never deleted. With the OS store unreachable (a locked keyring with no
 *  display, no Secret Service at all) nothing is written and the next start tries again; `o.pending` then holds the names
 *  that may still be there, so the caller never answers "nothing" for them (a missing token would be made anew). */
export async function moveOsStoreItems(o: { values: BatchValues; from: SecretsBackend; service: string; names: readonly string[]; log?: (line: string) => void; pending?: Set<string>; probeMs?: number }): Promise<MoveResult> {
  const mark = movedMarkKey(o.service);
  o.pending?.clear();
  if ((await o.values.get(mark)) !== null) return "done-before";
  const first = o.names[0];
  if (first === undefined) return "nothing";
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      o.from.get({ service: o.service, name: first }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), o.probeMs ?? OS_STORE_PROBE_MS); timer.unref?.(); }),
    ]).finally(() => clearTimeout(timer));
  } catch { for (const n of o.names) o.pending?.add(n); return "unreachable"; }
  const read = new Map<string, string>();
  let whole = true;
  for (const name of o.names) {
    try {
      const value = await o.from.get({ service: o.service, name });
      if (value !== null && value !== "") read.set(name, value);
    } catch { whole = false; o.pending?.add(name); }
  }
  if (read.size > 0) {
    await o.values.mutate((all) => {
      let changed = false;
      for (const [name, value] of read) { const k = itemKey(o.service, name); if (!(k in all)) { all[k] = value; changed = true; } }
      return changed;
    }); // returns when the file is durable
  }
  let moved = 0;
  for (const [name, value] of read) {
    try {
      const held = await o.values.get(itemKey(o.service, name));
      if (held === null) { whole = false; o.pending?.add(name); continue; } // not in the file after all: the original stays
      if (held === value) { await o.from.delete({ service: o.service, name }); moved++; } // a differing original is the older one: left
    } catch { whole = false; o.pending?.add(name); }
  }
  if (!whole) { o.log?.(`[secrets] moved ${moved} item(s) out of the OS store; some could not be read or written and stay there for the next start`); return "partial"; }
  await o.values.set(mark, new Date().toISOString());
  if (moved > 0) o.log?.(`[secrets] moved ${moved} item(s) from the OS store into the encrypted secrets file`);
  return moved > 0 ? "moved" : "nothing";
}

export interface FileBackendOptions {
  /** The MOSS home: the file is `secrets.enc` there. */
  home: string;
  /** The store's service (`keychainService(profile, home)`): the file's key is `<service>.key` in the OS store. */
  service: string;
  os?: "windows" | "linux";
  /** The OS store the file's key is kept in (tests); `bunVault`, the raw OS store, by default. */
  vault?: (service: string) => Vault;
  interactive?: boolean;
  systemdCreds?: SystemdCreds | null;
  credsRunner?: CredsRunner;
  /** What the one-time move reads: the raw OS store by default; null for no move (a home that never had one). */
  moveFrom?: SecretsBackend | null;
  names?: () => readonly string[];
  log?: (line: string) => void;
  /** Tests: how long the OS store gets to answer the move's first read. */
  probeMs?: number;
  /** Tests: called after each durable step of the file's writes (`PrivateFileDeps.step`). */
  step?: (name: PrivateFileStep, detail?: string) => void;
}

/** What a person is told, once per process and service, when the OS store holds the older logins and can't be read. */
const told = new Set<string>();
const WAIT_NOTE = "the OS keyring holds MOSS's saved logins from the previous version and isn't answering (locked, or no display to ask on): MOSS makes no new pairing tokens or logins in their place until it answers; unlock the keyring and start MOSS again";

/** How soon the move is tried again after the OS store did not answer, so a caller that asks every second does not wait
 *  the probe's seconds every time. */
const RETRY_MOVE_MS = 30_000;

/** The backend over this home's secrets file. Same contract as `Bun.secrets`: `get` answers null for a missing item and
 *  throws when the store can't be opened, `set` with an empty value deletes, `delete` says whether something was there.
 *  One more rule: while the one-time move has not finished (the OS store did not answer), a `get` of a name that may
 *  still be there and is not in the file throws `locked` and never answers null, because the callers mint a new pairing
 *  token for a missing one and would strand the old tokens, unpairing every device with no message. */
export function fileSecretsBackend(o: FileBackendOptions): SecretsBackend {
  const os = o.os ?? (process.platform === "win32" ? "windows" : "linux");
  const log = o.log ?? ((l: string) => console.error(l));
  interface Open { values: EncryptedFileValues; pending: Set<string>; osStore: "absent" | "locked" | "unlocked" | undefined; retryAt: number }
  let ready: Promise<Open> | undefined;
  const runMove = async (st: Open): Promise<void> => {
    const from = o.moveFrom === undefined ? osSecretsBackend() : o.moveFrom;
    if (from === null) return;
    const r = await moveOsStoreItems({ values: st.values, from, service: o.service, names: (o.names ?? osStoreItemNames)(), log, pending: st.pending, ...(o.probeMs !== undefined ? { probeMs: o.probeMs } : {}) })
      .catch((e: unknown) => { if (e instanceof ContractError) throw e; st.pending.clear(); return "nothing" as MoveResult; /* any other failure: the file works without the move */ });
    // No Secret Service at all (a headless computer): nothing was ever there to move, and nothing waits.
    if (r === "unreachable" && st.osStore === "absent") st.pending.clear();
    if (st.pending.size > 0) {
      st.retryAt = Date.now() + RETRY_MOVE_MS;
      if (!told.has(o.service)) { told.add(o.service); log(`[secrets] ${WAIT_NOTE}`); }
    }
  };
  /** A name that may still be in the OS store, and is not in the file, is neither "missing" nor "deleted": `locked`. */
  const refuseWhilePending = async (st: Open, name: string): Promise<void> => {
    if (!st.pending.has(name)) return;
    if (Date.now() >= st.retryAt) await runMove(st);
    if (st.pending.has(name)) throw new ContractError("locked", WAIT_NOTE);
  };
  const open = (): Promise<Open> => {
    ready ??= (async () => {
      const c = await chooseFileStore({ home: o.home, service: o.service, os, ...(o.vault ? { vault: o.vault } : {}), ...(o.interactive !== undefined ? { interactive: o.interactive } : {}), ...(o.systemdCreds !== undefined ? { systemdCreds: o.systemdCreds } : {}), ...(o.credsRunner ? { credsRunner: o.credsRunner } : {}) });
      if (c.locked !== undefined) throw new ContractError("locked", `the secrets file is locked: ${c.locked}`);
      const st: Open = { values: new EncryptedFileValues(join(o.home, SECRETS_FILE_NAME), c.key, c.source, undefined, { log, ...(o.step ? { step: o.step } : {}) }), pending: new Set(), osStore: c.osStore, retryAt: 0 };
      await runMove(st);
      return st;
    })().catch((e: unknown) => { ready = undefined; throw e; }); // a locked store is asked again at the next call, never remembered
    return ready;
  };
  return {
    get: (async (a: { service: string; name: string }) => {
      const st = await open();
      const v = await st.values.get(itemKey(a.service, a.name));
      if (v !== null) return v;
      await refuseWhilePending(st, a.name);
      return null;
    }) as SecretsBackend["get"],
    set: (async (a: { service: string; name: string; value: string }) => {
      const { values } = await open();
      if (a.value === "") await values.delete(itemKey(a.service, a.name)); // `Bun.secrets`' rule: an empty value deletes
      else await values.set(itemKey(a.service, a.name), a.value);
    }) as SecretsBackend["set"],
    delete: (async (a: { service: string; name: string }) => {
      const st = await open();
      const { values } = st;
      const key = itemKey(a.service, a.name);
      // A name the move may still find in the OS store is not "deleted" while it can't be read there: it would come back
      // into the file at the next start (the person logged out, and the credential returned).
      if ((await values.get(key)) === null) await refuseWhilePending(st, a.name);
      let had = false;
      await values.mutate((all) => { had = key in all; delete all[key]; return had; }); // one hold: whether it was there and its removal
      return had;
    }) as SecretsBackend["delete"],
  };
}

const shared = new Map<string, SecretsBackend>();

/** The process's one backend for a home and service: its key is read once, and the move runs once. */
export function sharedFileSecretsBackend(o: { home: string; service: string }): SecretsBackend {
  const k = `${o.home}\0${o.service}`;
  let b = shared.get(k);
  if (b === undefined) { b = fileSecretsBackend(o); shared.set(k, b); }
  return b;
}
