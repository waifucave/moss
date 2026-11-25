import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encryptedFileStatus } from "../../src/contracts/secret-store";
import { fileSecretsBackend } from "../../src/secrets/file-backend";
import { EncryptedFileValues, MossSecretStore, keyFileKey } from "../../src/secrets/moss-secret-store";

// Another account on the same computer reads none of the store's files (lane SE; spec §9.1). Linux, on a CI runner only:
// a throwaway user is made with `sudo -n useradd` and removed after; the files are the ones the real store wrote (the
// key-file source, so the key itself is a file here too). Each refusal has a positive control: the same user reads a
// plain file beside them once the folders are opened, so a refusal is the file's own mode, not a missing path.
// Windows: the same property is the owner-only ACL read back with icacls (secrets-file-backend.test.ts) and a pool
// principal, another account, refused every file the store wrote (win-fenced.e2e.test.ts).

// On Linux under CI this never skips (review should-fix 7): a runner where `sudo -n` doesn't work fails the test, so a
// green run means the property was tried. It runs in the `core · linux` jobs (packages/core's tests).
const onLinuxCi = process.platform === "linux" && process.env.CI !== undefined;

describe.skipIf(!onLinuxCi)("another account on this computer", () => {
  test("sudo works on this CI runner, so the proof below runs (a runner without it fails here, never skips)", () => {
    expect(Bun.spawnSync(["sudo", "-n", "true"]).exitCode).toBe(0);
  });

  test("reads none of the secrets file, its key file, its previous copy or the index, even with every folder opened", async () => {
    const user = `moss-se-${Math.random().toString(36).slice(2, 8)}`;
    // Under /tmp itself, not the preload's per-process root (made 0700): every folder above the home must be one the other
    // user can pass through, or the control below could not read. This exact folder is removed after.
    const h = realpathSync(mkdtempSync("/tmp/moss-other-"));
    const VALUE = ["other", "account", Math.random().toString(36).slice(2)].join("-");
    expect(Bun.spawnSync(["sudo", "-n", "useradd", "--no-create-home", "--shell", "/usr/sbin/nologin", user]).exitCode).toBe(0);
    try {
      const none = { get: async () => null, set: async () => { throw new Error("org.freedesktop.DBus.Error.ServiceUnknown"); }, delete: async () => false };
      const flat = fileSecretsBackend({ home: h, service: "svc", os: "linux", vault: () => none, interactive: false, systemdCreds: null, moveFrom: null, log: () => {} });
      await flat.set({ service: "svc", name: "anthropic:default", value: VALUE });
      await flat.set({ service: "svc", name: "anthropic:default", value: `${VALUE}-2` });
      const file = join(h, "secrets.enc");
      await new MossSecretStore({ home: h, values: new EncryptedFileValues(file, keyFileKey(join(h, "secrets.key"), file), "key-file"), status: encryptedFileStatus("key-file") })
        .set({ owner: { kind: "device" }, name: "device:link-key" }, VALUE);
      const files = [file, join(h, "secrets.key"), join(h, "credentials", "secrets.enc.bak"), join(h, "credentials", "index.json"), join(h, "credentials", "index.json.bak"),
        join(h, "credentials", "index.made"), join(h, "credentials", "secrets-file.made")];
      // The run folder (locks and half-made copies) can't be listed or entered by the other account either.
      const runList = Bun.spawnSync(["sudo", "-n", "-u", user, "ls", join(h, "run")]);
      expect([runList.exitCode !== 0, runList.stdout.length]).toEqual([true, 0]);
      const as = (path: string) => Bun.spawnSync(["sudo", "-n", "-u", user, "cat", path]);

      // As made: refused, whatever the folders' modes.
      for (const f of files) { const r = as(f); expect([f, r.exitCode !== 0, r.stdout.length]).toEqual([f, true, 0]); }
      // Every folder opened to everyone: the files' own modes still refuse. The control: a plain file beside them reads.
      for (const d of [h, join(h, "credentials")]) chmodSync(d, 0o755);
      writeFileSync(join(h, "credentials", "plain.txt"), "control\n", { mode: 0o644 });
      chmodSync(join(h, "credentials", "plain.txt"), 0o644);
      expect(as(join(h, "credentials", "plain.txt")).stdout.toString()).toBe("control\n");
      for (const f of files) {
        const r = as(f);
        expect([f, r.exitCode !== 0, r.stdout.length]).toEqual([f, true, 0]);
        expect(r.stderr.toString()).toContain("Permission denied");
      }
    } finally {
      Bun.spawnSync(["sudo", "-n", "userdel", user]);
      rmSync(h, { recursive: true, force: true });
    }
  }, 60_000);
});
