// A child process of review-round.test.ts: on one home, makes the device key (the contract store) or the pairing tokens
// (the flat-name store over the secrets file), as a daemon and a CLI starting together would, and prints what it got:
// the device id, or the tokens' digest. Key-file source: the same on every OS, no keyring.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { encryptedFileStatus } from "../../../src/contracts/secret-store";
import { DeviceKey } from "../../../src/identity/device-key";
import { KeychainSecretStore } from "../../../src/auth/secret-store";
import { TokenAuthority } from "../../../src/auth/tokens";
import { fileSecretsBackend } from "../../../src/secrets/file-backend";
import { EncryptedFileValues, MossSecretStore, keyFileKey } from "../../../src/secrets/moss-secret-store";

const [home, what] = process.argv.slice(2);
const file = join(home!, "secrets.enc");
if (what === "device") {
  const store = new MossSecretStore({ home: home!, values: new EncryptedFileValues(file, keyFileKey(join(home!, "secrets.key"), file), "key-file"), status: encryptedFileStatus("key-file") });
  process.stdout.write((await DeviceKey.loadOrCreate(store)).id);
} else {
  const none = { get: async () => null, set: async () => { throw new Error("org.freedesktop.DBus.Error.ServiceUnknown"); }, delete: async () => false };
  const backend = fileSecretsBackend({ home: home!, service: "svc", os: "linux", vault: () => none, interactive: false, systemdCreds: null, moveFrom: null, log: () => {} });
  const tokens = await new TokenAuthority(new KeychainSecretStore(backend, "svc")).ensureTokens();
  process.stdout.write(createHash("sha256").update(JSON.stringify(tokens)).digest("hex"));
}
