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
import { chooseFileStore, EncryptedFileValues, type CredsRunner, type SystemdCreds, type ValueBackend, type Vault } from "./moss-secret-store";
import { SECRETS_FILE_NAME } from "./secret-files";

export type SecretsBackend = Pick<typeof Bun.secrets, "get" | "set" | "delete">;

/** A flat-name item's key in the file. */
export const itemKey = (service: string, name: string) => `kc/${service}/${name}`;
/** The note, in the file, that a service's items were moved out of the OS store. */
export const movedMarkKey = (service: string) => `mark/os-store-moved/${service}`;

/** The names of MOSS's own items in the OS store: `Bun.secrets` has no list on Windows or Linux, so these are the
 *  known names: the provider slots (every one the catalog gives an API key), the sign-in and pairing tokens, the
 *  tool keys (`MIGRATION_B_SECRET_NAMES`, the inventory the Winter migration walks too). The names made from an id at
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

/** The one-time move of what the OS store holds into the file. Idempotent and safe to stop anywhere: an item is copied,
 *  read back from the file, and only then deleted from the OS store; one the file already holds (a newer value, written
 *  since) is left as the file has it and its OS copy deleted only when equal. The note that it is done is written last,
 *  and only when every name was read: with the OS store unreachable (no Secret Service on a headless computer) nothing is
 *  written and the next start tries again. */
export async function moveOsStoreItems(o: { values: ValueBackend; from: SecretsBackend; service: string; names: readonly string[]; log?: (line: string) => void }): Promise<MoveResult> {
  const mark = movedMarkKey(o.service);
  if ((await o.values.get(mark)) !== null) return "done-before";
  const first = o.names[0];
  if (first === undefined) return "nothing";
  try {
    await Promise.race([
      o.from.get({ service: o.service, name: first }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), OS_STORE_PROBE_MS).unref?.()),
    ]);
  } catch { return "unreachable"; }
  let moved = 0, whole = true;
  for (const name of o.names) {
    try {
      const value = await o.from.get({ service: o.service, name });
      if (value === null || value === "") continue;
      const key = itemKey(o.service, name);
      const held = await o.values.get(key);
      if (held === null) {
        await o.values.set(key, value);
        if ((await o.values.get(key)) !== value) { whole = false; continue; } // not read back: the original stays
      }
      if (held === null || held === value) { await o.from.delete({ service: o.service, name }); moved++; }
    } catch { whole = false; }
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
}

/** The backend over this home's secrets file. Same contract as `Bun.secrets`: `get` answers null for a missing item and
 *  throws when the store can't be opened, `set` with an empty value deletes, `delete` says whether something was there. */
export function fileSecretsBackend(o: FileBackendOptions): SecretsBackend {
  const os = o.os ?? (process.platform === "win32" ? "windows" : "linux");
  let ready: Promise<ValueBackend> | undefined;
  const open = (): Promise<ValueBackend> => {
    ready ??= (async () => {
      const c = await chooseFileStore({ home: o.home, service: o.service, os, ...(o.vault ? { vault: o.vault } : {}), ...(o.interactive !== undefined ? { interactive: o.interactive } : {}), ...(o.systemdCreds !== undefined ? { systemdCreds: o.systemdCreds } : {}), ...(o.credsRunner ? { credsRunner: o.credsRunner } : {}) });
      if (c.locked !== undefined) throw new ContractError("locked", `the secrets file is locked: ${c.locked}`);
      const values = new EncryptedFileValues(join(o.home, SECRETS_FILE_NAME), c.key, c.source);
      const from = o.moveFrom === undefined ? osSecretsBackend() : o.moveFrom;
      if (from !== null) {
        await moveOsStoreItems({ values, from, service: o.service, names: (o.names ?? osStoreItemNames)(), ...(o.log ? { log: o.log } : { log: (l: string) => console.error(l) }) })
          .catch((e: unknown) => { if (e instanceof ContractError) throw e; /* the move is best effort: the file works without it */ });
      }
      return values;
    })().catch((e: unknown) => { ready = undefined; throw e; }); // a locked store is asked again at the next call, never remembered
    return ready;
  };
  return {
    get: (async (a: { service: string; name: string }) => (await (await open()).get(itemKey(a.service, a.name))) ?? null) as SecretsBackend["get"],
    set: (async (a: { service: string; name: string; value: string }) => {
      const values = await open();
      if (a.value === "") await values.delete(itemKey(a.service, a.name)); // `Bun.secrets`' rule: an empty value deletes
      else await values.set(itemKey(a.service, a.name), a.value);
    }) as SecretsBackend["set"],
    delete: (async (a: { service: string; name: string }) => {
      const values = await open();
      const key = itemKey(a.service, a.name);
      const had = (await values.get(key)) !== null;
      if (had) await values.delete(key);
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
