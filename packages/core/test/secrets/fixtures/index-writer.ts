// A child process of secret-index.test.ts: writes its own items through the contract store (`MossSecretStore`) into one
// home, on the key file (no keyring, no systemd-creds: the same on every OS), as the daemon and the CLI would at once.
// Exit 0 when every write answered.
import { join } from "node:path";
import { EncryptedFileValues, MossSecretStore, keyFileKey } from "../../../src/secrets/moss-secret-store";
import { encryptedFileStatus } from "../../../src/contracts/secret-store";

const [home, tag, countText] = process.argv.slice(2);
const file = join(home!, "secrets.enc");
const store = new MossSecretStore({ home: home!, values: new EncryptedFileValues(file, keyFileKey(join(home!, "secrets.key"), file), "key-file"), status: encryptedFileStatus("key-file") });
const count = Number(countText);
for (let i = 0; i < count; i++) await store.set({ owner: { kind: "core" }, name: `${tag}-${i}` }, `${tag}-value-${i}`);
