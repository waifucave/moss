// The real SecretStore (B's contract `contracts/secret-store.ts`, owner lane C; spec §8.5, §9.1 "The secret store").
//   - What the store knows about each item (its owner, name, generation, time and whether it syncs) sits in an index,
//     `<home>/credentials/index.json`, inside the fenced set and owner-only. It never holds a value, so `list` and
//     `watch` work while the values are locked.
//   - The values:
//       macOS            one Keychain item per secret (`KeychainValues`), whose ACL trusts the daemon's binary
//       Windows, Linux   one encrypted file, `<home>/secrets.enc` (AES-256-GCM, a fresh nonce per write), whose key
//                        is in the OS store (Credential Manager, the Secret Service) or, on a headless computer with
//                        neither, a key file only the user can read, labelled `plaintext` (`secretKeySourceFor`)
//   - The OS stores are injected (`Vault`), so tests never touch the real Keychain, Credential Manager or keyring.
// A value leaves only through `get`, wrapped in a `Secret`; nothing written to the index, a log or an error holds one.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { SecretKeySource } from "@waifucave/moss-protocol";
import type { Clock } from "../contracts/clock";
import { ContractError, Listeners } from "../contracts/common";
import { osSecretsBackend } from "../auth/secret-store";
import { flushFile, readFileRetrying, renameDurably, withSecretsLock, writePrivateFile, type PrivateFileDeps } from "./private-file";
import {
  SECRETS_BACKUP_SEGMENTS, SECRETS_FILE_NAME, SECRETS_KEY_FILE_NAME, SECRETS_LOCK_SEGMENTS, SECRETS_MADE_SEGMENTS,
  SECRETS_SEALED_KEY_FILE_NAME, SECRETS_TMP_DIR_SEGMENTS,
} from "./secret-files";
import {
  SECRET_NAME_RE, Secret, secretOwnerKey, secretRefKey,
  type SecretChange, type SecretMeta, type SecretOwner, type SecretRef, type SecretStore, type SecretStoreStatus, type SecretValue,
} from "../contracts/secret-store";

/** An OS store of named strings (`Bun.secrets` with one service): the Keychain, Credential Manager, the Secret Service. */
export interface Vault {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<boolean>;
}

/** The OS store under one service, through the one raw OS backend (`osSecretsBackend`): on macOS the login keychain by
 *  path, elsewhere `Bun.secrets`; under a test, only an isolated store (the test keychain file, the private Secret
 *  Service, a throwaway service, or this process's memory: auth/test-isolation.ts). Never `Bun.secrets` directly, which
 *  on macOS searches the user's keychain list and creates in the login keychain. On Windows and Linux this is where the
 *  secrets file's KEY lives, so it must stay the raw OS store: `defaultSecretsBackend` there is the file itself. */
export function bunVault(service: string): Vault {
  const backend = () => osSecretsBackend();
  return {
    get: async (name) => (await backend().get({ service, name })) ?? null,
    set: async (name, value) => { await backend().set({ service, name, value }); },
    delete: async (name) => backend().delete({ service, name }),
  };
}

/** A vault in memory (tests). */
export function memoryVault(): Vault & { readonly items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    get: async (n) => items.get(n) ?? null,
    set: async (n, v) => { items.set(n, v); },
    delete: async (n) => items.delete(n),
  };
}

/** Where the values are kept. */
export interface ValueBackend {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Values that can be changed several at a time in ONE step: the file is read, `change` edits the copy it is handed
 *  (true when it changed something) and the file is written whole, all under one hold of the lock. */
export interface BatchValues extends ValueBackend {
  mutate(change: (all: Record<string, string>) => boolean): Promise<void>;
}

/** The previous whole secrets file, the note that a secrets file was made here, and the folder half-made copies live in. */
const backupPath = (file: string) => join(dirname(file), ...SECRETS_BACKUP_SEGMENTS);
const madePath = (file: string) => join(dirname(file), ...SECRETS_MADE_SEGMENTS);
/** What every write of a secret file passes: its half-made copy goes in the run folder, which every fence hides. */
export const secretDisk = (file: string): PrivateFileDeps => ({ tmpDir: join(dirname(file), ...SECRETS_TMP_DIR_SEGMENTS) });
/** A secrets file was made here: it is there, its previous copy is, or the note that one was is. A key missing now is then
 *  lost, never to be made over (#205's S3). */
export function secretsFileMade(file: string): boolean { return existsSync(file) || existsSync(backupPath(file)) || existsSync(madePath(file)); }

/** macOS: one vault item per secret. */
export class KeychainValues implements ValueBackend {
  constructor(private readonly vault: Vault) {}
  get(key: string) { return this.vault.get(key); }
  async set(key: string, value: string) { await this.vault.set(key, value); }
  async delete(key: string) { await this.vault.delete(key); }
}

const SOURCE_CODES: Record<SecretKeySource, number> = { "credential-manager": 1, "secret-service": 2, "systemd-creds": 3, "key-file": 4 };

/** The key source a secrets file records in its header (#205's S3): the store always uses it, never another. Null when
 *  there's no file; `unreadable` when it isn't one this store wrote. */
export function recordedKeySource(path: string): SecretKeySource | null | "unreadable" {
  if (!existsSync(path)) return null;
  let head: Buffer;
  try { head = readFileSync(path).subarray(0, 2); } catch { return "unreadable"; }
  if (head[0] !== 2) return "unreadable";
  const code = head[1];
  const found = (Object.entries(SOURCE_CODES) as [SecretKeySource, number][]).find(([, c]) => c === code);
  return found ? found[0] : "unreadable";
}

/** Windows and Linux: every value in one AES-256-GCM file, its 32-byte key from `key()`. The header is the format
 *  (2), the key's source, then the nonce and the tag; the key's source is authenticated with the body. A write reads the
 *  file whole, changes it and writes it whole, under the lock (`withSecretsLock`: one writer at a time across this
 *  user's processes), so no write loses another's; a read needs no lock, the file being replaced atomically. */
export class EncryptedFileValues implements BatchValues {
  readonly #lockPath: string;
  readonly #disk: PrivateFileDeps;
  readonly #log: (line: string) => void;
  #toldRecovery = false;
  constructor(
    private readonly path: string, private readonly key: () => Promise<Buffer>, private readonly source: SecretKeySource, lockPath?: string,
    /** `step` is a test seam (`PrivateFileDeps.step`); `log` says when the previous file was used. */
    seams: { step?: PrivateFileDeps["step"]; log?: (line: string) => void } = {},
  ) {
    this.#lockPath = lockPath ?? join(dirname(path), ...SECRETS_LOCK_SEGMENTS);
    this.#disk = { ...secretDisk(path), ...(seams.step ? { step: seams.step } : {}) };
    this.#log = seams.log ?? ((line) => console.error(line));
  }

  /** What `blob` holds, or `invalid` when it isn't a whole file this store wrote under this key. */
  async #decrypt(blob: Buffer): Promise<Record<string, string>> {
    if (blob.length < 2 + 12 + 16 || blob[0] !== 2) throw new ContractError("invalid", "the secrets file is not one this store wrote");
    // A code that names no key source is damage (the previous copy may be whole); a known one that is not this store's is the
    // downgrade rule (#205's S3): locked, whatever else is beside it.
    if (!Object.values(SOURCE_CODES).includes(blob[1]!)) throw new ContractError("invalid", "the secrets file's header is damaged");
    if (blob[1] !== SOURCE_CODES[this.source]) throw new ContractError("locked", "the secrets file's key is kept elsewhere than this store looks");
    const iv = blob.subarray(2, 14), tag = blob.subarray(14, 30), body = blob.subarray(30);
    const d = createDecipheriv("aes-256-gcm", await this.key(), iv);
    d.setAAD(blob.subarray(0, 2));
    d.setAuthTag(tag);
    try { return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString("utf8")) as Record<string, string>; }
    catch { throw new ContractError("invalid", "the secrets file can't be opened with this key"); }
  }

  /** The values, and the bytes they came from. A file that is damaged (short, empty, a changed byte) or gone is not the end
   *  of the road while the previous whole file is there (`credentials/secrets.enc.bak`, kept until each write is
   *  durable): it is read from that, and said so. A file gone with no previous one, though a file was made here before,
   *  is `locked` and never a quiet new empty store: the person restores it, or deletes the note
   *  `credentials/secrets-file.made` to start empty. */
  async #load(): Promise<{ all: Record<string, string>; blob: Buffer | null; recovered: boolean }> {
    const bak = backupPath(this.path);
    let damage: unknown;
    if (existsSync(this.path)) {
      const blob = await readFileRetrying(this.path);
      try { return { all: await this.#decrypt(blob), blob, recovered: false }; }
      catch (e) { if (!(e instanceof ContractError) || e.code !== "invalid") throw e; damage = e; }
    } else if (!existsSync(bak)) {
      if (existsSync(madePath(this.path))) {
        throw new ContractError("locked", "the secrets file (secrets.enc) is missing though one was made here: saved logins stay locked until it is restored (or the note credentials/secrets-file.made is deleted to start empty)");
      }
      return { all: {}, blob: null, recovered: false };
    }
    if (existsSync(bak)) {
      try {
        const blob = await readFileRetrying(bak);
        const all = await this.#decrypt(blob);
        if (!this.#toldRecovery) { this.#toldRecovery = true; this.#log(`[secrets] secrets.enc was ${damage === undefined ? "missing" : "damaged"}: read from the previous whole file (credentials/secrets.enc.bak); the next write puts it back`); }
        return { all, blob, recovered: true };
      } catch { /* no better: the first failure stands */ }
    }
    throw damage ?? new ContractError("locked", "the secrets file (secrets.enc) is missing and its previous copy can't be read");
  }

  /** Writes `all`: the file it replaces is first kept whole as the previous copy (durably), then the new file is written
   *  (flushed, renamed, the rename flushed: `writePrivateFile`), then the note that a file was made. A crash anywhere
   *  leaves the old whole file, the new whole file, or the previous copy beside whichever is there. */
  async #write(all: Record<string, string>, from: { blob: Buffer | null; recovered: boolean }): Promise<void> {
    const iv = randomBytes(12);
    const head = Buffer.from([2, SOURCE_CODES[this.source]]);
    const c = createCipheriv("aes-256-gcm", await this.key(), iv);
    c.setAAD(head);
    const body = Buffer.concat([c.update(JSON.stringify(all), "utf8"), c.final()]);
    if (from.blob !== null && !from.recovered) await writePrivateFile(backupPath(this.path), from.blob, this.#disk);
    await writePrivateFile(this.path, Buffer.concat([head, iv, c.getAuthTag(), body]), this.#disk);
    if (!existsSync(madePath(this.path))) await writePrivateFile(madePath(this.path), "a secrets file was made here\n", this.#disk);
  }

  async get(key: string) { return (await this.#load()).all[key] ?? null; }
  mutate(change: (all: Record<string, string>) => boolean): Promise<void> {
    return withSecretsLock(this.#lockPath, async () => {
      const from = await this.#load();
      const all = { ...from.all };
      if (change(all)) await this.#write(all, from);
    });
  }
  set(key: string, value: string) { return this.mutate((all) => { all[key] = value; return true; }); }
  delete(key: string) { return this.mutate((all) => { if (!(key in all)) return false; delete all[key]; return true; }); }
}

/** A key may be made only while there's no secrets file: one that exists was sealed with a key that must be found,
 *  never replaced (#205's S3). */
const missingKey = (where: string) => new ContractError("locked", `the secrets file's key is missing from ${where}: saved logins stay locked until it's back`);

/** The secrets file's key, kept in `vault` under `name`, made on first use (only while `secretsFile` doesn't exist). */
export function vaultKey(vault: Vault, secretsFile: string, name = "secrets-file-key", where = "the OS keyring"): () => Promise<Buffer> {
  let cached: Buffer | undefined;
  return async () => {
    if (cached) return cached;
    let text: string | null;
    try { text = await vault.get(name); } catch { throw new ContractError("locked", `${where} didn't answer`); }
    if (text === null) {
      if (secretsFileMade(secretsFile)) throw missingKey(where);
      text = randomBytes(32).toString("base64");
      await vault.set(name, text);
    }
    const k = Buffer.from(text, "base64");
    if (k.length !== 32) throw new ContractError("invalid", "the secrets file's key is damaged");
    return (cached = k);
  };
}

/** How `systemd-creds` seals the key here: `--user` (systemd 256 or later, the user's own credential key, with the TPM
 *  where there is one), or `--with-key=tpm2` on systemd 250 to 255 when the user can reach the TPM; null for neither. */
export interface SystemdCreds { readonly args: readonly string[]; readonly tpm: boolean }

export type CredsRunner = (argv: readonly string[], stdin?: string) => Promise<{ ok: boolean; out: string }>;

const bunCredsRunner: CredsRunner = async (argv, stdin) => {
  try {
    const p = Bun.spawn([...argv], { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "ignore" });
    if (stdin !== undefined && p.stdin) { p.stdin.write(stdin); await p.stdin.end(); }
    const out = await new Response(p.stdout).text();
    return { ok: (await p.exited) === 0, out };
  } catch { return { ok: false, out: "" }; }
};

/** What `systemd-creds` offers on this Linux computer. */
export async function probeSystemdCreds(run: CredsRunner = bunCredsRunner): Promise<SystemdCreds | null> {
  const v = await run(["systemd-creds", "--version"]);
  const version = Number(/systemd\s+(\d+)/.exec(v.out)?.[1] ?? 0);
  if (!v.ok || version < 250) return null;
  const tpm = (await run(["systemd-creds", "has-tpm2", "--quiet"])).ok;
  if (version >= 256) return { args: ["--user"], tpm };
  return tpm ? { args: ["--with-key=tpm2"], tpm } : null;
}

/** The secrets file's key sealed by `systemd-creds` in `path` (`secrets.key.cred`), made on first use. */
export function systemdCredsKey(path: string, creds: SystemdCreds, secretsFile: string, run: CredsRunner = bunCredsRunner): () => Promise<Buffer> {
  let cached: Buffer | undefined;
  const name = "--name=moss-secrets-key";
  return async () => {
    if (cached) return cached;
    if (!existsSync(path)) {
      if (secretsFileMade(secretsFile)) throw missingKey("its sealed credential (secrets.key.cred)");
      const fresh = randomBytes(32).toString("base64");
      // The half-made credential goes in the run folder, which every fence hides, and is flushed before it is renamed in.
      const tmp = join(dirname(path), ...SECRETS_TMP_DIR_SEGMENTS, `${basename(path)}.${process.pid}.tmp`);
      mkdirSync(dirname(tmp), { recursive: true, mode: 0o700 });
      const r = await run(["systemd-creds", ...creds.args, "encrypt", name, "-", tmp], fresh);
      if (!r.ok) { rmSync(tmp, { force: true }); throw new ContractError("locked", "systemd-creds could not seal the secrets file's key"); }
      chmodSync(tmp, 0o600);
      flushFile(tmp);
      await renameDurably(tmp, path);
    }
    const r = await run(["systemd-creds", ...creds.args, "decrypt", name, path, "-"]);
    const k = Buffer.from(r.out.trim(), "base64");
    if (!r.ok || k.length !== 32) throw new ContractError("locked", "systemd-creds could not open the secrets file's key");
    return (cached = k);
  };
}

/** What `moss doctor` and the daemon's log say about a store's status: a warning when the key sits unsealed, so a
 *  plaintext key is never a silent default (the controller's condition); null when there's nothing to warn of. */
export function secretStoreWarning(status: SecretStoreStatus): string | null {
  if (status.state === "locked") return `saved logins are locked: ${status.reason ?? "unlock the keyring"}`;
  if (status.plaintext) return "saved logins are encrypted with a key kept unsealed in a file (no keyring, no systemd-creds here): anyone who can read your files can read them";
  return null;
}

/** A headless computer's last resort: the key in a file only the user can read (status `plaintext`). */
export function keyFileKey(path: string, secretsFile: string): () => Promise<Buffer> {
  return async () => {
    if (!existsSync(path)) {
      if (secretsFileMade(secretsFile)) throw missingKey("its key file (secrets.key)");
      await writePrivateFile(path, randomBytes(32), secretDisk(secretsFile));
    }
    const k = readFileSync(path);
    if (k.length !== 32) throw new ContractError("invalid", "the key file is damaged");
    return k;
  };
}

function writeOwnerOnly(path: string, data: Buffer | string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, "", { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") chmodSync(tmp, 0o600);
  writeFileSync(tmp, data, { flag: "r+" });
  renameSync(tmp, path);
}

export interface MossSecretStoreOptions {
  /** The MOSS home: the index is `credentials/index.json` there. */
  home: string;
  values: ValueBackend;
  status: SecretStoreStatus;
  clock?: Pick<Clock, "now">;
  /** Starts locked with this reason (a keyring still locked at the login screen). */
  locked?: string;
}

interface Index { version: 1; items: Record<string, SecretMeta> }

export class MossSecretStore implements SecretStore {
  readonly #o: MossSecretStoreOptions;
  readonly #listeners = new Listeners<SecretChange>();
  readonly #indexPath: string;
  readonly #unlockedStatus: SecretStoreStatus;
  #status: SecretStoreStatus;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(o: MossSecretStoreOptions) {
    this.#o = o;
    this.#indexPath = join(o.home, "credentials", "index.json");
    this.#unlockedStatus = { ...o.status };
    this.#status = o.locked === undefined ? { ...o.status } : { ...o.status, state: "locked", reason: o.locked };
  }

  status(): SecretStoreStatus { return { ...this.#status }; }

  /** The store's key became unreachable (the keyring locked). */
  lock(reason = "the keyring is locked"): void {
    this.#status = { ...this.#unlockedStatus, state: "locked", reason };
    this.#listeners.emit({ status: this.status() });
  }

  unlock(): void {
    this.#status = { ...this.#unlockedStatus };
    this.#listeners.emit({ status: this.status() });
  }

  #index(): Index {
    try {
      const i = JSON.parse(readFileSync(this.#indexPath, "utf8")) as Index;
      return i.version === 1 && typeof i.items === "object" ? i : { version: 1, items: {} };
    } catch { return { version: 1, items: {} }; }
  }

  #save(i: Index): void { writeOwnerOnly(this.#indexPath, JSON.stringify(i)); }

  #unlocked(): void {
    if (this.#status.state === "locked") throw new ContractError("locked", `the secret store is locked${this.#status.reason ? `: ${this.#status.reason}` : ""}`);
  }

  /** One write at a time: the index and the encrypted file are read and rewritten whole. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async get(ref: SecretRef): Promise<SecretValue | null> {
    this.#unlocked();
    const key = secretRefKey(ref);
    const meta = this.#index().items[key];
    if (!meta) return null;
    const value = await this.#o.values.get(key);
    return value === null ? null : { value: new Secret(value), generation: meta.generation };
  }

  set(ref: SecretRef, value: string | Secret, opts: { synced?: boolean } = {}): Promise<SecretMeta> {
    return this.#serial(async () => {
      this.#unlocked();
      if (!SECRET_NAME_RE.test(ref.name)) throw new ContractError("invalid", "a secret's name is 1–128 of A-Z a-z 0-9 . _ : -");
      const key = secretRefKey(ref);
      const index = this.#index();
      const meta: SecretMeta = {
        ref: { owner: { ...ref.owner }, name: ref.name },
        generation: (index.items[key]?.generation ?? 0) + 1,
        updatedAt: this.#o.clock?.now() ?? Date.now(),
        synced: ref.owner.kind === "device" ? false : (opts.synced ?? true),
      };
      await this.#o.values.set(key, value instanceof Secret ? value.reveal() : value);
      index.items[key] = meta;
      this.#save(index);
      this.#listeners.emit({ meta: { ...meta }, deleted: false });
      return { ...meta };
    });
  }

  delete(ref: SecretRef): Promise<boolean> {
    return this.#serial(async () => {
      this.#unlocked();
      const key = secretRefKey(ref);
      const index = this.#index();
      const meta = index.items[key];
      if (!meta) return false;
      await this.#o.values.delete(key);
      delete index.items[key];
      this.#save(index);
      this.#listeners.emit({ meta: { ...meta }, deleted: true });
      return true;
    });
  }

  async list(owner?: SecretOwner): Promise<SecretMeta[]> {
    const want = owner ? secretOwnerKey(owner) : undefined;
    return Object.values(this.#index().items)
      .filter((m) => want === undefined || secretOwnerKey(m.ref.owner) === want)
      .map((m) => ({ ...m, ref: { owner: { ...m.ref.owner }, name: m.ref.name } }))
      .sort((a, b) => secretRefKey(a.ref).localeCompare(secretRefKey(b.ref)));
  }

  watch(fn: (change: SecretChange) => void): () => void { return this.#listeners.add(fn); }

  /** Removes the index (tests' and an uninstaller's clean-up; the values go with their backend). */
  dropIndex(): void { rmSync(this.#indexPath, { force: true }); }
}

/** What `chooseFileStore` settled on for the secrets file on this computer. */
export interface FileStoreChoice {
  /** Where the file's key is kept (and what the file's header records). */
  readonly source: SecretKeySource;
  /** Reads the key (making it on first use, only while there is no secrets file). */
  readonly key: () => Promise<Buffer>;
  /** `systemd-creds` sealed it with the TPM's help. */
  readonly tpm?: boolean;
  /** What the OS store that holds MOSS's older items said when asked (Linux: the Secret Service; Windows: always there). */
  readonly osStore?: "absent" | "locked" | "unlocked";
  /** Set when the key can't be reached now (a locked keyring, a keyring that isn't running, a file that may have been
   *  replaced): the store answers `locked` with this reason, and never opens or writes the file. */
  readonly locked?: string;
}

export interface FileStoreOptions {
  /** The MOSS home: the file is `secrets.enc` there. */
  home: string;
  /** The daemon's Keychain service (`keychainService(profile, home)`): the file's key is `<service>.key`. */
  service: string;
  os: "windows" | "linux";
  vault?: (service: string) => Vault;
  interactive?: boolean;
  /** Linux: what `systemd-creds` offers (`probeSystemdCreds`); probed when not given. */
  systemdCreds?: SystemdCreds | null;
  credsRunner?: CredsRunner;
}

/** Where the key of this computer's secrets file is kept, decided as spec §8.5 says: a file already made keeps its
 *  key's source and waits while that source can't be reached (#205's S3); a new one takes Credential Manager on
 *  Windows, an unlocked Secret Service on Linux, a locked one that someone can unlock (waited for), `systemd-creds`
 *  where the computer has it, and last a key file only the user can read (labelled `plaintext`). The one decision both
 *  the contract store (`openMossSecretStore`) and the flat-name store's backend (`fileSecretsBackend`) take their file
 *  from, so the two can never disagree about where the key is. */
export async function chooseFileStore(o: FileStoreOptions): Promise<FileStoreChoice> {
  const seen: { osStore?: "absent" | "locked" | "unlocked" } = {};
  const c = await chooseFileStoreInner(o, seen);
  return seen.osStore === undefined ? c : { ...c, osStore: seen.osStore };
}

async function chooseFileStoreInner(o: FileStoreOptions, seen: { osStore?: "absent" | "locked" | "unlocked" }): Promise<FileStoreChoice> {
  const { os } = o;
  const vault = o.vault ?? bunVault;
  const file = join(o.home, SECRETS_FILE_NAME);
  const keyFile = join(o.home, SECRETS_KEY_FILE_NAME);
  const sealedFile = join(o.home, SECRETS_SEALED_KEY_FILE_NAME);
  const keys = vault(`${o.service}.key`);
  // The previous whole file speaks for a file that is damaged or gone (`EncryptedFileValues` reads from it).
  let recorded = recordedKeySource(file);
  if (recorded === null || recorded === "unreadable") {
    const previous = recordedKeySource(join(o.home, ...SECRETS_BACKUP_SEGMENTS));
    if (previous !== null && previous !== "unreadable") recorded = previous;
  }
  if (recorded === "unreadable") {
    return { source: os === "windows" ? "credential-manager" : "key-file", key: async () => { throw new ContractError("invalid", "the secrets file is not one this store wrote"); }, locked: "the secrets file isn't one this store wrote" };
  }

  if (os === "windows") {
    if (recorded !== null && recorded !== "credential-manager") return { source: recorded, key: keyFileKey(keyFile, file), locked: `the secrets file's key is kept in ${recorded}, which Windows doesn't have` };
    const answers = await vaultAnswers(keys);
    seen.osStore = answers === "yes" ? "unlocked" : "locked";
    return { source: "credential-manager", key: vaultKey(keys, file, undefined, "Credential Manager"), ...(answers === "yes" ? {} : { locked: "Credential Manager didn't answer" }) };
  }

  // Linux. A file already made keeps its key's source, and is locked while that source can't be reached (#205's S3).
  const service = await probeSecretService(keys);
  seen.osStore = service;
  // A file that claims a weaker key than this computer keeps (a planted secrets.enc saying `key-file`, with a planted
  // secrets.key) is taken as replaced: locked, never opened or written under the weaker key (#205's check 2).
  // A keyring that is there but locked (or unreadable) may hold the real key, so a file claiming the unsealed key
  // file waits until the keyring answers (#205's check 3).
  if (recorded === "key-file" && service === "locked") {
    return { source: "key-file", key: async () => { throw new ContractError("locked", "the keyring is locked"); }, locked: "the keyring is locked, and the secrets file claims an unsealed key: saved logins stay locked until the keyring answers" };
  }
  if (recorded !== null) {
    const rank: Record<SecretKeySource, number> = { "key-file": 0, "systemd-creds": 1, "secret-service": 2, "credential-manager": 2 };
    let vaultHasKey = false;
    try { vaultHasKey = (await keys.get("secrets-file-key")) !== null; } catch { /* unreachable: no evidence either way */ }
    const strongest = vaultHasKey ? 2 : existsSync(sealedFile) ? 1 : 0;
    if (rank[recorded] < strongest) {
      return { source: recorded, key: async () => { throw new ContractError("locked", "the secrets file may have been replaced"); }, locked: "the secrets file claims a weaker key than this computer keeps: it may have been replaced, so saved logins stay locked" };
    }
  }
  const interactive = o.interactive ?? Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  const credsOf = async () => (o.systemdCreds !== undefined ? o.systemdCreds : await probeSystemdCreds(o.credsRunner));
  const sealed = (creds: SystemdCreds): FileStoreChoice => ({ source: "systemd-creds", key: systemdCredsKey(sealedFile, creds, file, o.credsRunner), tpm: creds.tpm });
  if (recorded === "secret-service") return { source: "secret-service", key: vaultKey(keys, file), ...(service === "unlocked" ? {} : { locked: service === "absent" ? "the keyring that holds the key isn't running" : "the keyring is locked: unlock it to use saved logins" }) };
  if (recorded === "systemd-creds") {
    const creds = await credsOf();
    return creds ? sealed(creds) : { source: "systemd-creds", key: async () => { throw missingKey("systemd-creds"); }, locked: "systemd-creds, which holds the key, isn't available here" };
  }
  if (recorded === "key-file") return { source: "key-file", key: keyFileKey(keyFile, file) };
  if (recorded === "credential-manager") return { source: "credential-manager", key: vaultKey(keys, file), locked: "the secrets file's key is kept in Credential Manager, which Linux doesn't have" };

  // A new store: the Secret Service when it answers; a keyring that is there but locked (or that answered strangely)
  // is never passed over for the unsealed key file (#205's S3): it's waited for, or systemd-creds seals the key.
  if (service === "unlocked") return { source: "secret-service", key: vaultKey(keys, file) };
  if (service !== "absent" && interactive) return { source: "secret-service", key: vaultKey(keys, file), locked: "the keyring is locked: unlock it to use saved logins" };
  const creds = await credsOf();
  if (creds) return sealed(creds);
  if (service !== "absent") return { source: "secret-service", key: vaultKey(keys, file), locked: "the keyring is locked, and there's no systemd-creds to seal the key with instead" };
  return { source: "key-file", key: keyFileKey(keyFile, file) };
}

/** What a store's status says about a choice: its backend, where the key is, the `plaintext` label. */
export function fileStoreStatus(c: FileStoreChoice): SecretStoreStatus {
  return { backend: "encrypted-file", keySource: c.source, ...(c.source === "systemd-creds" ? { tpm: c.tpm ?? false } : {}), plaintext: c.source === "key-file", state: "unlocked" };
}

/** This computer's store (spec §8.5): the Keychain on macOS; on Windows and Linux the encrypted file, its key in
 *  Credential Manager or the Secret Service, or on a headless Linux computer a key file labelled `plaintext`
 *  sealed by `systemd-creds` where it is here, and only as a last resort a key file labelled `plaintext`, which
 *  `secretStoreWarning` turns into a warning. `vault` stands in for `Bun.secrets` (tests). */
export async function openMossSecretStore(o: {
  home: string;
  /** The daemon's Keychain service (`keychainService(profile, home)`); the store keeps its items under `<service>.items`
   *  and the file's key under `<service>.key`, apart from the inherited items. */
  service: string;
  os?: "macos" | "windows" | "linux";
  vault?: (service: string) => Vault;
  clock?: Pick<Clock, "now">;
  interactive?: boolean;
  /** Linux: what `systemd-creds` offers (`probeSystemdCreds`); probed when not given. */
  systemdCreds?: SystemdCreds | null;
  credsRunner?: CredsRunner;
}): Promise<MossSecretStore> {
  const os = o.os ?? (process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux");
  const vault = o.vault ?? bunVault;
  const clock = o.clock ? { clock: o.clock } : {};
  if (os === "macos") return new MossSecretStore({ home: o.home, values: new KeychainValues(vault(`${o.service}.items`)), status: { backend: "keychain", plaintext: false, state: "unlocked" }, ...clock });
  const c = await chooseFileStore({ ...o, os, vault });
  return new MossSecretStore({
    home: o.home, values: new EncryptedFileValues(join(o.home, SECRETS_FILE_NAME), c.key, c.source), status: fileStoreStatus(c),
    ...(c.locked !== undefined ? { locked: c.locked } : {}), ...clock,
  });
}

/** Whether an OS vault answers at all (a read). */
async function vaultAnswers(v: Vault): Promise<"yes" | "no"> {
  try { await v.get("probe"); return "yes"; } catch { return "no"; }
}

/** The Secret Service, probed by a write (a service with no login collection answers reads and refuses writes, measured
 *  on the Ubuntu 26.04 VM). `absent` only when the session bus says no such service is there (or there's no bus);
 *  any other refusal is `locked`, never taken for "no keyring" (#205's S3). */
export async function probeSecretService(keys: Vault): Promise<"unlocked" | "locked" | "absent"> {
  try { await keys.set("probe", "1"); await keys.delete("probe"); return "unlocked"; }
  catch (e) {
    const m = String(e);
    return /ServiceUnknown|was not provided by any|NoServer|Cannot autolaunch|DBUS_SESSION_BUS_ADDRESS|Failed to connect to socket|No such file or directory|not supported on this platform/i.test(m) ? "absent" : "locked";
  }
}
