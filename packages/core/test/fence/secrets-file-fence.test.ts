import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Caller } from "@waifucave/moss-protocol";
import { BOT_READ_DENIED } from "../../src/contracts/fence";
import { fenceLayout } from "../../src/fence/layout";
import { fencedSpawner } from "../../src/fence/fenced-process";
import { MossFence } from "../../src/fence/fence";
import { LEFT_OUT_TOP } from "../../src/migration/old-home/copy";
import { homeNamedDenials } from "../../src/runtime-sdk/turn-loop/home-deny";
import { fileSecretsBackend } from "../../src/secrets/file-backend";
import { SECRETS_INDEX_COPY_SEGMENTS, SECRETS_INDEX_LOCK_SEGMENTS, SECRETS_INDEX_MADE_SEGMENTS, SECRETS_INDEX_SEGMENTS } from "../../src/secrets/secret-files";
import { SECRET_FILE_NAMES, SECRETS_BACKUP_SEGMENTS, SECRETS_FILE_NAME, SECRETS_KEY_FILE_NAME, SECRETS_MADE_SEGMENTS, SECRETS_SEALED_KEY_FILE_NAME, SECRETS_TMP_DIR_SEGMENTS } from "../../src/secrets/secret-files";

// The secrets file and its key material are hidden from every tool runner (spec §9.1; lane SF): one list of names
// (`secrets/secret-files.ts`) that the fence's layout, the bots' deny list, the home's named denials and the old-home copy
// all read, and, on Linux, the real sandbox refusing a command that tries every way to reach them.

describe("one list of names for the secrets file and its key", () => {
  test("the previous copy, the note and the half-made copies live in folders every deny list already names", () => {
    // Review item 11: not under names of their own that a deny list would have to know, but inside `credentials/` and `run/`.
    expect(SECRETS_BACKUP_SEGMENTS[0]).toBe("credentials");
    expect(SECRETS_MADE_SEGMENTS[0]).toBe("credentials");
    expect(SECRETS_TMP_DIR_SEGMENTS).toEqual(["run"]);
    // The contract store's index, its second copy, its note and its lock (lane SE): in the same two folders.
    for (const segs of [SECRETS_INDEX_SEGMENTS, SECRETS_INDEX_COPY_SEGMENTS, SECRETS_INDEX_MADE_SEGMENTS]) expect(segs[0]).toBe("credentials");
    expect(SECRETS_INDEX_LOCK_SEGMENTS[0]).toBe("run");
    for (const dir of ["credentials", "run"]) {
      if (dir === "credentials") expect(BOT_READ_DENIED.some((rel) => rel.length === 1 && rel[0] === dir)).toBe(true); // `run` is the fence's run-folder kind
      expect([dir, homeNamedDenials("/h/.moss", "linux").includes(join(resolve("/h/.moss"), dir))]).toEqual([dir, true]);
    }
  });

  test("the names are the three files, and every deny list is built from them", () => {
    expect(SECRET_FILE_NAMES).toEqual(["secrets.enc", "secrets.key", "secrets.key.cred"]);
    for (const os of ["linux", "windows"] as const) {
      const home = os === "windows" ? "C:\\Users\\me\\.moss" : "/h/.moss";
      const layout = fenceLayout(home, os);
      const sep = os === "windows" ? "\\" : "/";
      expect(layout["secrets-file"]).toEqual([`${home}${sep}${SECRETS_FILE_NAME}`]);
      expect(layout["key-file"]).toEqual([`${home}${sep}${SECRETS_KEY_FILE_NAME}`, `${home}${sep}${SECRETS_SEALED_KEY_FILE_NAME}`]);
    }
    // macOS keeps its secrets in the Keychain: the layout names no file there, though the names stay denied by name.
    expect(fenceLayout("/h/.moss", "macos")["secrets-file"]).toEqual([]);
    expect(fenceLayout("/h/.moss", "macos")["key-file"]).toEqual([]);
    for (const n of SECRET_FILE_NAMES) {
      expect(BOT_READ_DENIED.some((rel) => rel.length === 1 && rel[0] === n)).toBe(true);
      expect(LEFT_OUT_TOP).toContain(n);
      expect(homeNamedDenials("/h/.moss", "linux")).toContain(join(resolve("/h/.moss"), n)); // as the host spells it
    }
  });

  test("the policy every runner gets read-denies all three on Linux and Windows, and the fence refuses a read and a write of each", () => {
    // The paths are written POSIX-style for both OSes, as lane B's conformance suite writes them (the fence's own Windows
    // path forms are judged on a Windows runner by the suites that run there).
    for (const os of ["linux", "windows"] as const) {
      const moss = "/Users/me/.moss";
      const fence = new MossFence({ os, home: "/Users/me", mossHome: moss, temp: "/tmp" });
      for (const n of SECRET_FILE_NAMES) {
        const path = join(resolve(moss), n); // the host's own spelling of the path (a Windows runner makes it `D:\\Users\\me\\.moss\\…`)
        expect([os, n, fence.policy().denyRead.includes(path)]).toEqual([os, n, true]);
        expect([os, n, fence.check({ op: "read", path }).allowed, fence.check({ op: "write", path }).allowed]).toEqual([os, n, false, false]);
      }
    }
  });
});

// Linux: the sandbox for real. On a CI runner bubblewrap must work here: a run that could not start is a failure, never a
// quiet pass (the fence tests elsewhere return when the sandbox is unavailable).
const bot = (name: string, sessionId: string): Caller => ({ kind: "session", sessionId, sessionKind: "bot", bot: name });
const coding: Caller = { kind: "session", sessionId: "c1", sessionKind: "coding" };

(process.platform === "linux" ? describe : describe.skip)("bubblewrap, live: the secrets file and the key material", () => {
  const MARKER = `marker-${Math.random().toString(36).slice(2)}`;

  /** A home whose secrets file was written by the real store (key file: no keyring needed), a sealed-key stand-in and a run folder. */
  async function world() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "moss-sf-fence-")));
    const home = join(root, "home"), moss = join(home, ".moss"), temp = join(root, "tmp");
    for (const d of [join(home, "project"), temp, join(moss, "run"), join(moss, "credentials")]) mkdirSync(d, { recursive: true });
    const none = { get: async () => null, set: async () => { throw new Error("org.freedesktop.DBus.Error.ServiceUnknown"); }, delete: async () => false };
    const backend = fileSecretsBackend({ home: moss, service: "svc", os: "linux", vault: () => none, interactive: false, systemdCreds: null, moveFrom: null });
    await backend.set({ service: "svc", name: "anthropic:default", value: MARKER });
    await backend.set({ service: "svc", name: "anthropic:default", value: `${MARKER}-2` }); // a second write: the previous copy exists
    writeFileSync(join(moss, SECRETS_SEALED_KEY_FILE_NAME), MARKER);
    writeFileSync(join(moss, "run", "app.token"), MARKER);
    writeFileSync(join(moss, "credentials", "index.json"), MARKER);
    const spawner = fencedSpawner({ fence: new MossFence({ os: "linux", home, mossHome: moss, temp }) });
    if (!spawner.available && process.env.CI !== undefined) throw new Error("bubblewrap cannot start on this CI runner, so the fence's proof did not run");
    const env: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: home, ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}) };
    const run = (command: string, caller: Caller) => spawner.run({ command, cwd: join(home, "project"), env, timeoutMs: 60_000, who: { caller } });
    return { root, home, moss, spawner, run };
  }
  const text = (r: Awaited<ReturnType<Awaited<ReturnType<typeof world>>["run"]>>) => (r.kind === "exited" ? `${r.stdout}\n${r.stderr}` : r.kind === "refused" ? `refused: ${r.reason}` : "timeout");
  const ran = (r: Awaited<ReturnType<Awaited<ReturnType<typeof world>>["run"]>>) => r.kind === "exited";

  /** Real bytes, not the fixture's marker: `secrets.enc` and `secrets.key` hold ciphertext and random bytes, so a leak is
   *  found by the real file's own first bytes (as base64, 30 bytes = 40 exact characters) in what the shell printed. */
  const needleOf = (path: string) => readFileSync(path).subarray(0, 30).toString("base64");
  const base64 = (path: string) => `base64 -w0 '${path}'`;

  for (const [label, caller] of [["a coding agent's command", coding], ["a bot's command", bot("luna", "s1")]] as const) {
    test(`${label} reads none of the file, the key files or the run folder, by any road`, async () => {
      const w = await world();
      if (!w.spawner.available) return;
      const secret = (n: string) => join(w.moss, n);
      const prev = join(w.moss, ...SECRETS_BACKUP_SEGMENTS);
      const real = [secret(SECRETS_FILE_NAME), secret(SECRETS_KEY_FILE_NAME), prev, join(w.moss, ...SECRETS_MADE_SEGMENTS)];
      const needles = real.map(needleOf);
      expect(real.every((p) => existsSync(p))).toBe(true); // the store made all of them: the file, its key, the previous copy, the note
      const project = join(w.home, "project");
      const probes: string[] = [];
      for (const f of real) {
        probes.push(
          `cat '${f}' | base64 -w0`, base64(f), `head -c 4000 '${f}' | base64 -w0`, `dd if='${f}' bs=64 count=1 2>/dev/null | base64 -w0`,
          `python3 -c "import base64,sys; sys.stdout.write(base64.b64encode(open(sys.argv[1],'rb').read()).decode())" '${f}'`,
          `cp '${f}' '${project}/copy'; base64 -w0 '${project}/copy'`,
          // A link planted in a writable folder, soft and hard: the target is not there for either.
          `ln -s '${f}' '${project}/soft'; base64 -w0 '${project}/soft'`,
          `ln '${f}' '${project}/hard'; base64 -w0 '${project}/hard'`,
          // Through the shell's own spellings and through /proc.
          `base64 -w0 "$HOME/.moss/${f.slice(w.moss.length + 1)}"; base64 -w0 "$HOME/.moss/../.moss/${f.slice(w.moss.length + 1)}"`,
          `base64 -w0 /proc/self/root'${f}'`,
          `rm -f '${project}/copy' '${project}/soft' '${project}/hard'`,
        );
      }
      probes.push(`cat '${join(w.moss, "run", "app.token")}'`, `cat '${join(w.moss, "credentials", "index.json")}'`, `cat '${secret(SECRETS_SEALED_KEY_FILE_NAME)}'`);

      // The control: unfenced, the same reads print the real bytes, so what the fenced runs below do not print is the fence's doing.
      const sh = (cmd: string) => Bun.spawnSync(["/bin/sh", "-c", cmd], { env: { PATH: "/usr/bin:/bin", HOME: w.home } }).stdout.toString();
      for (const f of real) expect([f, sh(base64(f)).includes(needleOf(f))]).toEqual([f, true]);
      expect(sh(`cat '${secret(SECRETS_SEALED_KEY_FILE_NAME)}'`)).toBe(MARKER);

      for (const p of probes) {
        const r = await w.run(p, caller);
        const out = text(r);
        expect([label, p, ran(r) || out.startsWith("refused")]).toEqual([label, p, true]);
        expect([label, p, needles.filter((n) => out.includes(n)).length]).toEqual([label, p, 0]);
        expect([label, p, out.includes(MARKER)]).toEqual([label, p, false]);
      }
      expect(existsSync(join(project, "copy"))).toBe(false);
      expect(existsSync(join(project, "hard"))).toBe(false);

      // Listings name none of the files (the names are absent, not refused), and a search finds none.
      for (const p of [`ls -la '${w.moss}'`, `ls -la '${join(w.moss, "credentials")}' 2>&1`, `find '${w.moss}' -maxdepth 3 2>&1`, `find '${w.home}' -name 'secrets*' 2>&1`, `ls -la '${w.moss}/..' 2>&1`]) {
        const out = text(await w.run(p, caller));
        for (const n of [...SECRET_FILE_NAMES, "secrets.enc.bak", "secrets-file.made"]) expect([label, p, n, out.includes(n)]).toEqual([label, p, n, false]);
      }
    }, 300_000);

    test(`${label} neither changes nor moves the file, nor makes its key over again`, async () => {
      const w = await world();
      if (!w.spawner.available) return;
      const before = readFileSync(join(w.moss, SECRETS_FILE_NAME));
      const keyBefore = readFileSync(join(w.moss, SECRETS_KEY_FILE_NAME));
      const runBefore = readFileSync(join(w.moss, "run", "app.token"));
      for (const p of [
        `echo x > '${join(w.moss, SECRETS_FILE_NAME)}'`, `echo x >> '${join(w.moss, SECRETS_FILE_NAME)}'`, `rm -f '${join(w.moss, SECRETS_FILE_NAME)}'`,
        `mv '${join(w.moss, SECRETS_FILE_NAME)}' '${join(w.home, "project", "gone")}'`,
        `mv '${w.moss}' '${w.moss}.away'`, `rm -rf '${join(w.moss, "run")}'`, `rm -rf '${join(w.moss, "credentials")}'`,
        `echo x > '${join(w.moss, ...SECRETS_BACKUP_SEGMENTS)}'`, `rm -f '${join(w.moss, ...SECRETS_MADE_SEGMENTS)}'`,
        `echo x > '${join(w.moss, SECRETS_KEY_FILE_NAME)}'`,
      ]) await w.run(p, caller);
      expect(readFileSync(join(w.moss, SECRETS_FILE_NAME)).equals(before)).toBe(true);
      expect(existsSync(`${w.moss}.away`)).toBe(false);
      expect(existsSync(join(w.home, "project", "gone"))).toBe(false);
      expect(readFileSync(join(w.moss, SECRETS_KEY_FILE_NAME)).equals(keyBefore)).toBe(true); // the store's own key file, byte for byte
      expect(readFileSync(join(w.moss, "run", "app.token")).equals(runBefore)).toBe(true); // `rm -rf run` took nothing
      expect(existsSync(join(w.moss, "run"))).toBe(true);
      expect(readFileSync(join(w.moss, ...SECRETS_BACKUP_SEGMENTS)).length).toBeGreaterThan(0);
    }, 240_000);

    test(`${label}: a secrets file made while the command runs never shows in it`, async () => {
      const w = await world();
      if (!w.spawner.available) return;
      const late = join(w.moss, "secrets.enc.late");
      const loop = `i=0; while [ $i -lt 60 ]; do for f in '${late}' '${join(w.moss, SECRETS_FILE_NAME)}'; do [ -e "$f" ] && cat "$f"; done; i=$((i+1)); sleep 0.1; done; echo done`;
      const pending = w.run(loop, caller);
      await new Promise((r) => setTimeout(r, 800));
      writeFileSync(late, MARKER); // appears on the real disk after the command's mounts were made
      const r = await pending;
      expect(ran(r)).toBe(true);
      expect(text(r)).toContain("done");
      expect(text(r).includes(MARKER)).toBe(false);
    }, 240_000);
  }

  test("the user's session bus is closed: the Secret Service and systemd-run --user are out of reach, as an unfenced command's are not", async () => {
    const w = await world();
    if (!w.spawner.available) return;
    const address = process.env.DBUS_SESSION_BUS_ADDRESS;
    // Connect to the session bus' socket, whatever its form (a path, or an abstract name), and say what happened.
    const probe = `python3 - <<'PY'\nimport os, socket, sys\na = os.environ.get('DBUS_SESSION_BUS_ADDRESS', '')\nfor part in a.split(','):\n  pass\nif a.startswith('unix:path='):\n  addr = a[len('unix:path='):].split(',')[0]\nelif a.startswith('unix:abstract='):\n  addr = '\\0' + a[len('unix:abstract='):].split(',')[0]\nelse:\n  print('no-bus'); sys.exit(0)\ntry:\n  s = socket.socket(socket.AF_UNIX); s.connect(addr); print('connected')\nexcept Exception as e:\n  print('refused')\nPY`;
    if (address === undefined) {
      // No private bus here (a developer machine): the sandbox still hides the bus' usual place.
      const r = await w.run(`test -S /run/user/$(id -u)/bus && echo reachable || echo hidden`, coding);
      expect(text(r)).toContain("hidden");
      return;
    }
    const outside = Bun.spawnSync(["/bin/sh", "-c", probe], { env: { ...process.env } }).stdout.toString().trim();
    expect(outside).toBe("connected"); // the control: this process can reach the bus
    for (const caller of [coding, bot("luna", "s1")]) {
      const r = await w.run(probe, caller);
      expect(text(r)).toContain("refused");
      expect(text(r)).not.toContain("connected");
      const sd = await w.run("systemd-run --user --wait true", caller);
      expect(ran(sd) && sd.kind === "exited" && sd.code === 0).toBe(false);
      const ss = await w.run("secret-tool lookup service svc 2>&1; echo $?", caller);
      expect(text(ss)).not.toMatch(/\n0\n?$/);
    }
  }, 240_000);
});
