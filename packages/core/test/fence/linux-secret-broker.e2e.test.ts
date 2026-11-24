// The Linux credential broker end to end (docs/linux-credential-broker.md), on Linux CI only (`core-linux`, under
// scripts/with-private-secret-service.sh: a private session bus and an unlocked gnome-keyring of its own, never the
// user's). Real clients inside the real fence: git's libsecret helper, `secret-tool`, `gh`, `busctl` and `systemd-run`.
// Every refusal is asserted by the broker's own text (`REFUSAL`) and paired with the same call made OUTSIDE the fence,
// which succeeds: a refusal is the fence's, never a missing daemon. `MOSS_BROKER_E2E=1` (set by the job) makes a
// missing tool a failure instead of a skip.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MossFence } from "../../src/fence/fence";
import { fencedSpawner } from "../../src/fence/fenced-process";
import { encodeMessage, MessageReader, MessageType } from "../../src/fence/dbus-wire";
import { type CredentialGrant, REFUSAL, sessionBusSecrets, unixBusPath } from "../../src/fence/linux-secret-broker";
import type { FencedRunResult } from "../../src/fence/spawn";

const which = (bin: string): string | null => {
  const r = Bun.spawnSync(["/bin/sh", "-c", `command -v ${bin}`]);
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
};
const required = process.env.MOSS_BROKER_E2E === "1";
const privateBus = process.env.MOSS_PRIVATE_SECRET_SERVICE !== undefined && process.env.MOSS_PRIVATE_SECRET_SERVICE === process.env.DBUS_SESSION_BUS_ADDRESS;
const bwrapOk = process.platform === "linux" && existsSync("/usr/bin/bwrap")
  && Bun.spawnSync(["/usr/bin/bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-net", "--unshare-pid", "/bin/true"]).exitCode === 0;
const gitHelper = process.env.MOSS_GIT_CREDENTIAL_LIBSECRET && existsSync(process.env.MOSS_GIT_CREDENTIAL_LIBSECRET) ? process.env.MOSS_GIT_CREDENTIAL_LIBSECRET : null;
const tools = { secretTool: which("secret-tool"), busctl: which("busctl"), systemdRun: which("systemd-run"), gh: which("gh"), git: which("git") };
const ready = process.platform === "linux" && bwrapOk && privateBus && gitHelper !== null && Object.values(tools).every((t) => t !== null);

if (required && !ready) {
  test("the broker's e2e has what it needs", () => {
    expect({ linux: process.platform === "linux", bwrapOk, privateBus, gitHelper, ...tools }).toEqual({ linux: true, bwrapOk: true, privateBus: true, gitHelper: expect.any(String), secretTool: expect.any(String), busctl: expect.any(String), systemdRun: expect.any(String), gh: expect.any(String), git: expect.any(String) });
  });
}

const GIT_TOKEN = "dummy-git-token-123";
const GITLAB_TOKEN = "dummy-gitlab-token-456";
const GH_TOKEN_VALUE = "dummy-gh-token-789";
const MOSS_KEY = "dummy-moss-key-000";
const GRANTS: CredentialGrant[] = [
  { label: "GitHub (git)", attributes: { "xdg:schema": "org.git.Password", server: "github.com" } },
  { label: "GitHub CLI", attributes: { service: "gh:github.com" } },
];

/** A stub on the private bus that owns systemd's and the portal's names and answers every call "stub-ok": the
 *  outside control that each refused name is really there. */
async function startStub(): Promise<() => void> {
  const path = unixBusPath(process.env.DBUS_SESSION_BUS_ADDRESS)!;
  const sock = createConnection({ path });
  const reader = new MessageReader();
  let authed = false;
  let serial = 1;
  const send = (m: Parameters<typeof encodeMessage>[0]) => sock.write(encodeMessage(m));
  const owned = new Promise<void>((resolve) => {
    let got = 0;
    sock.on("data", (d: Buffer) => {
      reader.push(d);
      if (!authed) {
        const b = reader.peek();
        const nl = b.indexOf("\r\n");
        if (nl < 0) return;
        reader.take(nl + 2);
        authed = true;
        sock.write("BEGIN\r\n");
        send({ type: 1, flags: 0, serial: serial++, dest: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", iface: "org.freedesktop.DBus", member: "Hello", signature: "", body: [] });
        for (const n of ["org.freedesktop.systemd1", "org.freedesktop.portal.Desktop"]) {
          send({ type: 1, flags: 0, serial: serial++, dest: "org.freedesktop.DBus", path: "/org/freedesktop/DBus", iface: "org.freedesktop.DBus", member: "RequestName", signature: "su", body: [n, 4] });
        }
      }
      for (let m = reader.next(); m !== null; m = reader.next()) {
        if (m.type === MessageType.Return && m.replySerial !== undefined && m.replySerial >= 2 && ++got === 2) resolve();
        if (m.type === MessageType.Call && m.sender !== undefined) {
          send({ type: MessageType.Return, flags: 1, serial: serial++, replySerial: m.serial, dest: m.sender, signature: "s", body: ["stub-ok"] });
        }
      }
    });
  });
  sock.on("connect", () => sock.write(`\0AUTH EXTERNAL ${Buffer.from(String(process.getuid!())).toString("hex")}\r\n`));
  await Promise.race([owned, Bun.sleep(10_000).then(() => { throw new Error("the stub didn't get its names"); })]);
  return () => sock.destroy();
}

/** A command outside the fence, run without blocking this process's loop (the stub above answers from it). */
const sh = async (cmd: string, env: Record<string, string>, stdin?: string) => {
  const p = Bun.spawn(["/bin/sh", "-c", cmd], { env, stdin: stdin === undefined ? "ignore" : Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
};

describe.skipIf(!ready)("linux: the credential broker inside the real fence", () => {
  let root = "";
  let home = "";
  let stopStub = () => {};
  let mossBunAttrs: Record<string, string> = {};
  const outsideEnv = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS!, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? "" });
  const inEnv = () => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, GH_CONFIG_DIR: join(home, "gh"), GH_NO_UPDATE_NOTIFIER: "1", GIT_TERMINAL_PROMPT: "0" });
  let fence: MossFence;
  const run = (command: string, grants: CredentialGrant[] | null, refused?: (i: { label: string }) => void): Promise<FencedRunResult> =>
    fencedSpawner({ fence }).run({ command, cwd: join(home, "project"), env: inEnv(), timeoutMs: 60_000, who: { caller: { kind: "session", sessionId: "c1", sessionKind: "coding" } },
      ...(grants === null ? {} : { credentials: { grants, ...(refused ? { refused } : {}) } }) });
  const outOf = (r: FencedRunResult) => (r.kind === "refused" ? `refused: ${r.reason}` : `${r.stdout}\n${r.stderr}`);
  const code = (r: FencedRunResult) => (r.kind === "exited" ? r.code : -1);

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "moss-broker-")));
    home = join(root, "home");
    for (const d of [join(home, ".moss"), join(home, "project"), join(home, "gh"), join(root, "tmp")]) mkdirSync(d, { recursive: true });
    fence = new MossFence({ os: "linux", home, mossHome: join(home, ".moss"), temp: join(root, "tmp") });
    const env = outsideEnv();
    // The keyring: git's two logins through git's own helper, gh's token as go-keyring keeps it, and MOSS's own items,
    // one by secret-tool and one by Bun.secrets (the store MOSS really uses).
    for (const [host, token] of [["github.com", GIT_TOKEN], ["gitlab.com", GITLAB_TOKEN]] as const) {
      expect((await sh(`'${gitHelper}' store`, env, `protocol=https\nhost=${host}\nusername=octo\npassword=${token}\n\n`)).code).toBe(0);
    }
    for (const user of ["", "octo"]) {
      expect((await sh(`secret-tool store --label="gh:github.com" service gh:github.com username '${user}'`, env, GH_TOKEN_VALUE)).code).toBe(0);
    }
    expect((await sh(`secret-tool store --label="MOSS key" service com.waifucave.moss.core.key account file`, env, MOSS_KEY)).code).toBe(0);
    const bun = Bun.spawnSync([process.execPath, "-e", `await Bun.secrets.set({ service: "com.waifucave.moss.core.items", name: "device-key", value: ${JSON.stringify(MOSS_KEY)} })`], { env });
    expect(bun.exitCode).toBe(0);
    // Find the Bun.secrets item's attributes outside (names and values, never its secret), to ask for it by exact name.
    const backend = sessionBusSecrets()!;
    for (const ref of await backend.search({})) {
      const item = await backend.item(ref);
      if (item !== null && (item.label.includes("com.waifucave.moss.core.items") || Object.values(item.attributes).some((v) => v.includes("com.waifucave.moss.core.items")))) mossBunAttrs = item.attributes;
    }
    backend.close();
    expect(Object.keys(mossBunAttrs).length).toBeGreaterThan(0);
    writeFileSync(join(home, "gh", "hosts.yml"), "github.com:\n    git_protocol: https\n    users:\n        octo:\n    user: octo\n");
    stopStub = await startStub();
  }, 60_000);

  afterAll(() => {
    stopStub();
    rmSync(root, { recursive: true, force: true });
  });

  test("git's libsecret helper reads the ONE granted login, and not the other host's", async () => {
    const cmd = (host: string) => `printf 'protocol=https\\nhost=${host}\\nusername=octo\\n\\n' | '${gitHelper}' get`;
    // Outside: both logins are there.
    expect((await sh(cmd("github.com"), outsideEnv())).out).toContain(`password=${GIT_TOKEN}`);
    expect((await sh(cmd("gitlab.com"), outsideEnv())).out).toContain(`password=${GITLAB_TOKEN}`);
    const refused: { label: string }[] = [];
    const gh = await run(cmd("github.com"), GRANTS, (i) => refused.push(i));
    expect(outOf(gh)).toContain(`password=${GIT_TOKEN}`);
    const gl = await run(`${cmd("gitlab.com")}; ${cmd("github.com")}`, GRANTS, (i) => refused.push(i));
    expect(outOf(gl)).not.toContain(GITLAB_TOKEN);
    expect(outOf(gl).match(/password=/g)).toHaveLength(1); // github.com's, from the same run: the broker answered
    expect(refused.map((r) => r.label).join(" ")).toContain("gitlab.com");
    // And git itself, through `git credential fill`.
    const fill = await run(`printf 'protocol=https\\nhost=github.com\\nusername=octo\\n\\n' | git -c credential.helper='${gitHelper}' credential fill`, GRANTS);
    expect(outOf(fill)).toContain(`password=${GIT_TOKEN}`);
  }, 120_000);

  test("gh reads its token from the keyring inside the fence", async () => {
    const cmd = "gh auth token --hostname github.com";
    expect((await sh(cmd, { ...outsideEnv(), GH_CONFIG_DIR: join(home, "gh"), GH_NO_UPDATE_NOTIFIER: "1" })).out.trim()).toBe(GH_TOKEN_VALUE);
    const r = await run(cmd, GRANTS);
    expect(outOf(r).trim().split("\n")[0]).toBe(GH_TOKEN_VALUE);
    // Without gh's grant, the same command gets nothing.
    const without = await run(cmd, [GRANTS[0]!]);
    expect(outOf(without)).not.toContain(GH_TOKEN_VALUE);
  }, 120_000);

  test("MOSS's own items are refused even when asked for by exact name and granted", async () => {
    const lookup = "secret-tool lookup service com.waifucave.moss.core.key account file";
    expect((await sh(lookup, outsideEnv())).out).toBe(MOSS_KEY);
    const bunLookup = `secret-tool lookup ${Object.entries(mossBunAttrs).map(([k, v]) => `'${k}' '${v}'`).join(" ")}`;
    expect((await sh(bunLookup, outsideEnv())).out).toBe(MOSS_KEY);
    const greedy: CredentialGrant[] = [...GRANTS, { label: "everything MOSS", attributes: { service: "com.waifucave.moss.core.key", account: "file" } },
      { label: "the device key", attributes: Object.fromEntries(Object.entries(mossBunAttrs).filter(([k]) => k !== "xdg:schema")) }];
    // Each command ends with a granted lookup, so the run proves the broker answered it.
    for (const cmd of [lookup, bunLookup, "secret-tool search --all service com.waifucave.moss.core.key"]) {
      const r = await run(`${cmd}; echo; secret-tool lookup service gh:github.com username octo`, greedy);
      expect(outOf(r)).not.toContain(MOSS_KEY);
      expect(outOf(r)).toContain(GH_TOKEN_VALUE);
    }
  }, 120_000);

  test("systemd, the portal, the bus's name list and owning a name are refused inside; the same calls work outside", async () => {
    const calls = [
      "busctl --user call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager GetUnit s moss.service",
      "busctl --user call org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop org.freedesktop.portal.Settings Read ss org.gnome a",
    ];
    for (const c of calls) {
      const outside = await sh(c, outsideEnv());
      expect(outside.code).toBe(0);
      expect(outside.out).toContain("stub-ok");
      const inside = await run(c, GRANTS);
      expect(code(inside)).not.toBe(0);
      expect(outOf(inside)).toContain(REFUSAL);
      expect(outOf(inside)).not.toContain("stub-ok");
    }
    const sr = await run("systemd-run --user --wait /bin/true", GRANTS);
    expect(code(sr)).not.toBe(0);
    expect(outOf(sr)).toContain(REFUSAL);
    const names = await run("busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ListNames", GRANTS);
    expect(outOf(names)).not.toContain("systemd1");
    expect(outOf(names)).not.toContain("portal");
    // Owning a name: the real bus grants it outside (`u 1`); inside, the broker's AccessDenied, which busctl prints as
    // its errno text only (the real bus never answers RequestName with AccessDenied for a free name).
    const request = "busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus RequestName su org.example.MossProbe 4";
    const ownOutside = await sh(request, outsideEnv());
    expect(ownOutside.code).toBe(0);
    expect(ownOutside.out).toContain("u 1");
    const own = await run(request, GRANTS);
    expect(code(own)).not.toBe(0);
    expect(outOf(own)).toContain("Access denied");
  }, 180_000);

  test("without grants a run reaches no bus at all, as before", async () => {
    const r = await run("busctl --user call org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus ListNames; echo addr=$DBUS_SESSION_BUS_ADDRESS", null);
    expect(outOf(r)).not.toContain(REFUSAL);
    expect(outOf(r)).toContain("addr=\n");
    const s = await run("secret-tool lookup service gh:github.com username octo", null);
    expect(code(s)).not.toBe(0);
    expect(outOf(s)).not.toContain(GH_TOKEN_VALUE);
  }, 120_000);

  test("with grants but no session bus in the engine, a run behaves as before: no bus address, no broker", async () => {
    const saved = process.env.DBUS_SESSION_BUS_ADDRESS;
    delete process.env.DBUS_SESSION_BUS_ADDRESS;
    try {
      const r = await run("echo addr=$DBUS_SESSION_BUS_ADDRESS; secret-tool lookup service gh:github.com username octo", GRANTS);
      expect(outOf(r)).toContain("addr=\n");
      expect(outOf(r)).not.toContain(GH_TOKEN_VALUE);
      expect(outOf(r)).not.toContain(REFUSAL);
      expect(code(r)).not.toBe(0);
    } finally {
      process.env.DBUS_SESSION_BUS_ADDRESS = saved;
    }
  }, 120_000);

  test("garbage and a flood on the sandbox's bus port end only that connection; the command still gets its login", async () => {
    // A hostile client inside: raw bytes to the port, then many connections, then the real helper.
    const cmd = [
      "port=${DBUS_SESSION_BUS_ADDRESS##*port=}",
      "for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do (printf 'garbage\\r\\n' > /dev/tcp/127.0.0.1/$port) 2>/dev/null; done",
      "head -c 5000000 /dev/zero > /dev/tcp/127.0.0.1/$port 2>/dev/null",
      `printf 'protocol=https\\nhost=github.com\\nusername=octo\\n\\n' | '${gitHelper}' get`,
    ].join("; ");
    const r = await run(`bash -c '${cmd.replaceAll("'", "'\\''")}'`, GRANTS);
    expect(outOf(r)).toContain(`password=${GIT_TOKEN}`);
  }, 120_000);
});
