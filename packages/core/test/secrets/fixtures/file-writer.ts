// A child process of secrets-file-backend.test.ts: writes its own items into one home's secrets file, on the key file (no
// keyring, no systemd-creds: the same on every OS), as the daemon and the CLI would at once. Exit 0 when every write answered.
import { fileSecretsBackend } from "../../../src/secrets/file-backend";

const [home, tag, countText] = process.argv.slice(2);
const none = { get: async () => null, set: async () => { throw new Error("org.freedesktop.DBus.Error.ServiceUnknown"); }, delete: async () => false };
const backend = fileSecretsBackend({ home: home!, service: "svc", os: "linux", vault: () => none, interactive: false, systemdCreds: null, moveFrom: null });
const count = Number(countText);
for (let i = 0; i < count; i++) await backend.set({ service: "svc", name: `${tag}-${i}`, value: `${tag}-value-${i}` });
