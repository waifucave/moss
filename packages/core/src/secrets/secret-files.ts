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
// macOS keeps its secrets in the Keychain and has none of these.

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
