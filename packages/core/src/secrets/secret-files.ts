// The files that hold MOSS's secrets on Windows and Linux (spec §9.1 "The secret store", §8.5; spike S8): the ONE spelling.
// Everything that names them (the fence's layout, the bot and agent deny lists, the other-installs check, the old-home
// copy, the Windows sandbox's DACL denies) takes the names from here, so a file added to the list is hidden everywhere
// at once. A leaf module: nothing imported.
//
//   secrets.enc        every secret, AES-256-GCM, one file (`secrets/moss-secret-store.ts`)
//   secrets.key        the file's key, only on a headless computer with no keyring and no systemd-creds (labelled plaintext)
//   secrets.key.cred   the file's key sealed by `systemd-creds` (headless Linux)
//   run/secrets-file.lock   the lock the processes of one user take around a write (inside the run folder, which is
//                      fenced and read-denied; it holds a pid and a time, never a secret)
//   credentials/secrets.enc.bak   the previous whole secrets file, kept until the next write is durable (a file that is
//                      damaged or lost is read from it); inside the credentials folder, which is fenced and read-denied
//   credentials/secrets-file.made  a note that a secrets file was made here, so a deleted file with its key still in the
//                      OS store is answered "locked", never a quiet new empty store (no secret in it)
//   run/<name>.<pid>.<id>.tmp      the half-made copy of any of these while a write is under way: always in the run
//                      folder, never beside the file under a name a deny list does not know
//   credentials/index.json, index.json.bak, index.made, run/secrets-index.lock   the contract store's index (names,
//                      generations and times, never a value), its second copy, the note that one was made, its lock
//                      (every OS, macOS included)
// macOS keeps its secrets in the Keychain and has none of these but the index's.

/** The encrypted secrets file's name, in the MOSS home. */
export const SECRETS_FILE_NAME = "secrets.enc";
/** The unsealed key file (a headless Linux computer's last resort). */
export const SECRETS_KEY_FILE_NAME = "secrets.key";
/** The key sealed by `systemd-creds`. */
export const SECRETS_SEALED_KEY_FILE_NAME = "secrets.key.cred";

/** Every file that holds the secrets or the key to them, by name in the MOSS home. Read-denied to every tool runner. */
export const SECRET_FILE_NAMES: readonly string[] = [SECRETS_FILE_NAME, SECRETS_KEY_FILE_NAME, SECRETS_SEALED_KEY_FILE_NAME];

/** The same names as path segments (`["secrets.enc"]`), the shape the fence's deny lists use. */
export const SECRET_FILE_SEGMENTS: readonly (readonly string[])[] = SECRET_FILE_NAMES.map((n) => [n]);

/** The lock's place relative to the MOSS home. */
export const SECRETS_LOCK_SEGMENTS: readonly string[] = ["run", "secrets-file.lock"];

/** The previous whole secrets file, relative to the MOSS home. */
export const SECRETS_BACKUP_SEGMENTS: readonly string[] = ["credentials", "secrets.enc.bak"];
/** The note that a secrets file was made here, relative to the MOSS home. */
export const SECRETS_MADE_SEGMENTS: readonly string[] = ["credentials", "secrets-file.made"];
/** The folder the half-made copies are made in, relative to the MOSS home. */
export const SECRETS_TMP_DIR_SEGMENTS: readonly string[] = ["run"];

// The contract store's index (`MossSecretStore`, every OS): each item's owner, name, generation and time, never a value.
// All of it in the credentials folder and the run folder, which every fence read-denies.
/** The index, relative to the MOSS home. */
export const SECRETS_INDEX_SEGMENTS: readonly string[] = ["credentials", "index.json"];
/** Its second whole copy, written after it, read when it is damaged or gone. */
export const SECRETS_INDEX_COPY_SEGMENTS: readonly string[] = ["credentials", "index.json.bak"];
/** The note that an index was made here: with both copies gone, the list is `locked`, never a quiet empty one. */
export const SECRETS_INDEX_MADE_SEGMENTS: readonly string[] = ["credentials", "index.made"];
/** The lock a write of the index (and its item) holds, across this user's processes. Taken before the file's own lock. */
export const SECRETS_INDEX_LOCK_SEGMENTS: readonly string[] = ["run", "secrets-index.lock"];
