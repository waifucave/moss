// The Windows fence, end to end, for real (lane WS; spec §4, §9.1, §14.1 item 2): a bot's Bash and PowerShell through
// the core's tools (`windowsShellTools`) and the computer node's Bash (`fencedExecutor`), each through the fenced
// spawner's Windows leg, as pool principals the workflow's `moss-core sandbox setup` provisioned, under the settings
// the daemon gives a bot's runtime. Every refusal is asserted against a positive control by the test's own process
// (the user), so a refusal is the fence's and not a missing file or a broken shell.
//
// Runs only on Windows with MOSS_WIN_FENCE_E2E=1 (the windows-fence workflow, after setup; the launcher is the protected
// copy's, as the daemon finds it, with no override). It writes a throwaway MOSS home in the runner's own profile (`.moss-e2e`) and a few
// files beside it, and prints only dummy values (`PROBE_SECRET=dummy123`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/moss-protocol";
import { MossFence } from "../../src/fence/fence";
import { fencedSpawner } from "../../src/fence/fenced-process";
import { botSandboxSettings } from "../../src/fence/sandbox-settings";
import { botSandbox, withBotKeyReads, withSecretReads } from "../../src/runtime-sdk/turn-loop/driver";
import { windowsShellTools } from "../../src/fence/win-shell-tools";
import { profileExcludeCandidates, QUARANTINE_COPY_LIMITS, quarantineWin } from "../../src/fence/win-fenced";
import { fencedExecutor } from "../../src/computers/fenced-executor";
import { resolveEndpoint } from "../../src/platform/transport";
import { currentUserSid, lockPipeDacl } from "../../src/platform/win-pipe";
import type { CoreToolDef } from "../../src/runtime-sdk/turn-loop/servers";
import { createThrowawaySecretStore } from "@waifucave/moss-test-harness";
import { encryptedFileStatus } from "../../src/contracts/secret-store";
import { fileSecretsBackend } from "../../src/secrets/file-backend";
import { EncryptedFileValues, MossSecretStore, vaultKey } from "../../src/secrets/moss-secret-store";

const run = process.platform === "win32" && process.env.MOSS_WIN_FENCE_E2E === "1";
const home = process.env.USERPROFILE ?? "C:\\Users\\nobody";
const moss = join(home, ".moss-e2e");
const BOT = "alpha";
const scratch = join(moss, "scratch", BOT);
const botRoot = join(moss, "bots", BOT);
const SECRET = "PROBE_SECRET=dummy123";
const CALLER: Extract<Caller, { kind: "session" }> = { kind: "session", sessionId: "e2e-bot", sessionKind: "bot", bot: BOT } as Extract<Caller, { kind: "session" }>;

let fence: MossFence;
let tools: Record<string, CoreToolDef>;
let sideTools: Record<string, CoreToolDef>;
const sandboxFor = () => {
  const settings = botSandboxSettings(fence.forCaller(CALLER).policy(), {
    mossHome: moss, userHome: home, level: undefined, windows: true, ownFolders: [scratch, botRoot], pathFolders: [],
  });
  return botSandbox(withBotKeyReads(withSecretReads(settings, { userHome: home, os: "windows" }), { home: moss }), { userHome: home, os: "windows" });
};
/** One call; a launch refusal (`was refused:`) fails the test there, so no refusal of the fence's own launch can pass
 *  as the fence refusing what the command did. `refusal: true` for the one call that must be refused by the tool. */
const call = async (t: CoreToolDef, input: Record<string, unknown>, o: { refusal?: boolean; signal?: AbortSignal } = {}) => {
  const started = Date.now();
  const r = await t.run(input, o.signal === undefined ? undefined : { signal: o.signal });
  console.log(`[e2e] ${t.name} ${JSON.stringify(input.command).slice(0, 120)} -> ${r.isError ? "error" : "ok"} in ${Date.now() - started} ms: ${r.text.slice(0, 300).replace(/\s+/g, " ")}`);
  if (o.refusal !== true) expect(r.text).not.toContain("was refused:");
  return r;
};
const fresh = (name: string) => { const p = join(home, name); rmSync(p, { force: true }); return p; };

describe.skipIf(!run)("the Windows fence, end to end (windows-latest)", () => {
  beforeAll(() => {
    rmSync(moss, { recursive: true, force: true });
    for (const d of [scratch, join(botRoot, "memory"), join(moss, "run"), join(moss, "notes"), join(moss, "outputs", "e2e-code")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(moss, "settings.json"), "{\"level\":\"ask\"}\n");
    writeFileSync(join(moss, "run", "token"), `${SECRET}\n`);
    writeFileSync(join(moss, "secrets.enc"), `${SECRET}\n`);
    writeFileSync(join(moss, "notes", "readme.txt"), "a note any bot may read\n");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "id_e2e"), `${SECRET}\n`);
    // In a folder of the home: srt-win's profile read grant leaves the profile ROOT's own files unreadable but for a
    // named list (profile_plan.rs), unlike macOS, where a bot reads an ordinary file at the home's top.
    mkdirSync(join(home, "ws-e2e-plain"), { recursive: true });
    writeFileSync(join(home, "ws-e2e-plain", "plain.txt"), "an ordinary file in the home\n");
    // What a real MOSS home holds that the profile grant can't exclude by name (glob denies): a transcript's
    // provider-state and auto-state sidecars.
    mkdirSync(join(moss, "projects", "e2e-project"), { recursive: true });
    writeFileSync(join(moss, "projects", "e2e-project", "s1.provider-state.jsonl"), `${SECRET}\n`);
    writeFileSync(join(moss, "projects", "e2e-project", "s1.auto-state.json"), "{}\n");
    fence = new MossFence({ home, mossHome: moss });
    const spawner = fencedSpawner({ fence });
    const mk = (kind: "bot" | "side-thread") => Object.fromEntries(windowsShellTools({
      spawner, caller: CALLER, kind, cwd: () => scratch, sandbox: sandboxFor, userHome: home, temp: fence.temp, mossHome: moss,
    }).map((t) => [t.name, t]));
    tools = mk("bot");
    sideTools = mk("side-thread");
  });
  afterAll(() => { for (const d of [moss, join(home, "ws-e2e-plain"), join(home, "ws-escape-dir")]) rmSync(d, { recursive: true, force: true }); });

  test("a sidecar the grant can't exclude by name is still never read; a secret folder made after the daemon started too", async () => {
    // `~/.oci` (a secret place) made after the spawner made its grant: a per-exec read deny then, not an exclusion.
    rmSync(join(home, ".oci"), { recursive: true, force: true });
    mkdirSync(join(home, ".oci"), { recursive: true });
    writeFileSync(join(home, ".oci", "config"), `${SECRET}\n`);
    const r = await call(tools.Bash!, { command: `cat '${join(moss, "projects", "e2e-project", "s1.provider-state.jsonl").replace(/\\/g, "/")}' '${join(home, ".oci", "config").replace(/\\/g, "/")}'; echo done` });
    expect(r.text).toContain("done");
    expect(r.text).not.toContain("dummy123");
    rmSync(join(home, ".oci"), { recursive: true, force: true });
  }, 900_000);

  test("Bash and PowerShell run as a pool principal, never as the user", async () => {
    const b = await call(tools.Bash!, { command: "whoami" });
    expect(b.isError).toBe(false);
    expect(b.text).toContain("moss-sb-");
    const p = await call(tools.PowerShell!, { command: "[Environment]::UserName" });
    expect(p.isError).toBe(false);
    expect(p.text).toContain("moss-sb-");
  }, 1_800_000); // the first command writes the profile read grant, which walks the whole profile once

  test("a write inside the bot's own scratch folder lands; one outside its folders is refused (the user can)", async () => {
    const ok = await call(tools.Bash!, { command: "echo inside > inside.txt && cat inside.txt" });
    expect(ok.isError).toBe(false);
    expect(readFileSync(join(scratch, "inside.txt"), "utf8").trim()).toBe("inside");
    const outside = fresh("ws-outside.txt");
    writeFileSync(outside, "control\n"); rmSync(outside); // the user writes there: a refusal below is the fence's
    const b = await call(tools.Bash!, { command: `echo nope > '${outside.replace(/\\/g, "/")}'` });
    expect(b.isError).toBe(true);
    expect(existsSync(outside)).toBe(false);
    const p = await call(tools.PowerShell!, { command: `Set-Content -LiteralPath '${outside}' -Value nope` });
    expect(p.isError).toBe(true);
    expect(existsSync(outside)).toBe(false);
  }, 900_000);

  test("the fenced set: MOSS's settings are never written; the run folder, the secrets file and ~/.ssh are never read", async () => {
    const before = readFileSync(join(moss, "settings.json"), "utf8");
    const w = await call(tools.Bash!, { command: `echo '{"level":"automatic"}' > '${join(moss, "settings.json").replace(/\\/g, "/")}'` });
    expect(w.isError).toBe(true);
    expect(readFileSync(join(moss, "settings.json"), "utf8")).toBe(before);
    const pw = await call(tools.PowerShell!, { command: `Set-Content -LiteralPath '${join(moss, "settings.json")}' -Value x` });
    expect(pw.isError).toBe(true);
    expect(readFileSync(join(moss, "settings.json"), "utf8")).toBe(before);
    for (const secret of [join(moss, "run", "token"), join(moss, "secrets.enc"), join(home, ".ssh", "id_e2e")]) {
      expect(readFileSync(secret, "utf8")).toContain("dummy123"); // the user reads it
      const r = await call(tools.Bash!, { command: `cat '${secret.replace(/\\/g, "/")}'` });
      expect(r.text).not.toContain("dummy123");
      const p = await call(tools.PowerShell!, { command: `Get-Content -LiteralPath '${secret}'` });
      expect(p.text).not.toContain("dummy123");
    }
    // The control: a plain note in the MOSS home is read (a bot's open access), and a plain file in a home folder.
    const note = await call(tools.Bash!, { command: `cat '${join(moss, "notes", "readme.txt").replace(/\\/g, "/")}' '${join(home, "ws-e2e-plain", "plain.txt").replace(/\\/g, "/")}'` });
    expect(note.text).toContain("a note any bot may read");
    expect(note.text).toContain("an ordinary file in the home");
  }, 900_000);

  test("the files the real store wrote (the secrets file, its previous copy, the index) and the key in Credential Manager: the principal reads none of them (lane SE)", async () => {
    // The store itself writes them, as the daemon does on Windows (owner-only ACL, the key in the user's Credential Manager
    // under a throwaway service); the test's earlier hand-written stand-in goes first.
    const store = createThrowawaySecretStore({ id: `wfe-${process.pid}` });
    const vault = { get: (n: string) => store.get(n), set: (n: string, v: string) => store.set(n, v), delete: (n: string) => store.delete(n) };
    const file = join(moss, "secrets.enc");
    rmSync(file, { force: true });
    try {
      const flat = fileSecretsBackend({ home: moss, service: store.service, os: "windows", vault: () => vault, interactive: false, moveFrom: null, log: () => {} });
      await flat.set({ service: store.service, name: "anthropic:default", value: SECRET });
      await flat.set({ service: store.service, name: "anthropic:default", value: `${SECRET}-2` }); // the previous copy exists
      const contract = new MossSecretStore({ home: moss, values: new EncryptedFileValues(file, vaultKey(vault, file), "credential-manager"), status: encryptedFileStatus("credential-manager") });
      await contract.set({ owner: { kind: "device" }, name: "device:link-key" }, SECRET);
      expect(await store.get("secrets-file-key")).not.toBeNull(); // the key is in the user's Credential Manager
      const files = [file, join(moss, "credentials", "secrets.enc.bak"), join(moss, "credentials", "index.json"), join(moss, "credentials", "index.json.bak")];
      // A leak is found by each file's own first bytes (ciphertext and names, not the dummy), as base64.
      const needleOf = (p: string) => readFileSync(p).subarray(0, 30).toString("base64");
      // The controls (review should-fix 6): the principal's own Bash and PowerShell DO base64 a file it may read, so an
      // absent needle below is a refusal, not a tool that never worked.
      const readable = join(moss, "notes", "readme.txt");
      const readableNeedle = needleOf(readable);
      const bc = await call(tools.Bash!, { command: `base64 -w0 '${readable.replace(/\\/g, "/")}'; echo; echo done` });
      expect(bc.text).toContain(readableNeedle);
      const pc = await call(tools.PowerShell!, { command: `[Convert]::ToBase64String([IO.File]::ReadAllBytes('${readable}'))` });
      expect(pc.text).toContain(readableNeedle);
      for (const p of files) {
        const needle = needleOf(p);
        // The control: the user reads the bytes the same way the principal's commands try to.
        const own = Bun.spawnSync(["powershell", "-NoProfile", "-Command", `[Convert]::ToBase64String([IO.File]::ReadAllBytes('${p}'))`]).stdout.toString();
        expect([p, own.includes(needle)]).toEqual([p, true]);
        const b = await call(tools.Bash!, { command: `base64 -w0 '${p.replace(/\\/g, "/")}' || echo BASH-NOREAD; cat '${p.replace(/\\/g, "/")}' | base64 -w0; echo done` });
        expect(b.text).toContain("done");
        expect([p, b.text.includes("BASH-NOREAD")]).toEqual([p, true]); // base64 itself said it could not read the file
        expect([p, b.text.includes(needle)]).toEqual([p, false]);
        const ps = await call(tools.PowerShell!, { command: `try { [Convert]::ToBase64String([IO.File]::ReadAllBytes('${p}')) } catch { 'DENIED' }; 'done'` });
        expect(ps.text).toContain("done");
        expect([p, ps.text.includes("DENIED")]).toEqual([p, true]); // the read threw: refused, not empty
        expect([p, ps.text.includes(needle)]).toEqual([p, false]);
      }
      // Credential Manager is per user: the principal's own lists nothing of the user's. The control: the user's lists the key.
      const target = store.service.toLowerCase();
      const mine = Bun.spawnSync(["cmdkey", "/list"]).stdout.toString().toLowerCase();
      expect(mine.includes(target)).toBe(true);
      const theirs = await call(tools.PowerShell!, { command: "cmdkey /list; 'done'" });
      expect(theirs.text).toContain("done");
      expect(theirs.text.toLowerCase().includes(target)).toBe(false);
      const theirsBash = await call(tools.Bash!, { command: "cmdkey.exe /list; echo done" });
      expect(theirsBash.text).toContain("done");
      expect(theirsBash.text.toLowerCase().includes(target)).toBe(false);
    } finally {
      await store.dispose();
      // The tests after this one read the hand-written stand-in: put it back, and take away what the store wrote.
      for (const p of [file, join(moss, "credentials"), join(moss, "run", "secrets-file.lock"), join(moss, "run", "secrets-index.lock")]) rmSync(p, { recursive: true, force: true });
      for (const n of readdirSync(join(moss, "run"))) if (n.endsWith(".tmp")) rmSync(join(moss, "run", n), { force: true });
      writeFileSync(file, `${SECRET}\n`);
    }
  }, 900_000);

  test("no network: a public address, a loopback listener outside the proxy range and the metadata address are refused", async () => {
    // Controls: the test's own process reaches each (the metadata address answers on GitHub's Azure runners).
    const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const proxyRange = Bun.listen({ hostname: "127.0.0.1", port: 60081, socket: { data() {} } });
    const reach = async (host: string, port: number) => {
      try { const s = await Promise.race([Bun.connect({ hostname: host, port, socket: { data() {} } }), Bun.sleep(5000).then(() => null)]); if (s) { s.end(); return true; } return false; } catch { return false; }
    };
    const controls = { public: await reach("1.1.1.1", 443), loopback: await reach("127.0.0.1", listener.port), metadata: await reach("169.254.169.254", 80) };
    console.log(`[e2e] network controls from the user: ${JSON.stringify(controls)}`);
    expect(controls.public && controls.loopback).toBe(true);
    const probe = (host: string, port: number) => `timeout 8 bash -c 'exec 3<>/dev/tcp/${host}/${port}' && echo CONNECTED || echo REFUSED`;
    const pub = await call(tools.Bash!, { command: probe("1.1.1.1", 443) });
    expect(pub.text).toContain("REFUSED");
    const lo = await call(tools.Bash!, { command: probe("127.0.0.1", listener.port) });
    expect(lo.text).toContain("REFUSED");
    if (controls.metadata) {
      const md = await call(tools.Bash!, { command: probe("169.254.169.254", 80) });
      expect(md.text).toContain("REFUSED");
    }
    const psNet = await call(tools.PowerShell!, { command: "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('1.1.1.1', 443); 'CONNECTED' } catch { 'REFUSED' }" });
    expect(psNet.text).toContain("REFUSED");
    // The proxy range srt-win's filters keep open on loopback (60080-60089): recorded, not hidden.
    const range = await call(tools.Bash!, { command: probe("127.0.0.1", 60081) });
    console.log(`[e2e] loopback proxy range 60081 from the fenced command: ${range.text.includes("CONNECTED") ? "CONNECTED (open by srt-win's design)" : "REFUSED"}`);
    listener.stop(true); proxyRange.stop(true);
  }, 900_000);

  test("pipes: MOSS's own (an owner-only DACL), and Docker's and ssh-agent's where present, are unreachable", async () => {
    const path = resolveEndpoint(mkdtempSync(join(tmpdir(), "moss-e2e-pipe-"))).path;
    const server = Bun.listen({ unix: path, socket: { data() {} } });
    expect(lockPipeDacl(path, currentUserSid()!)).toBeGreaterThan(0);
    const control = await Bun.connect({ unix: path, socket: { data() {} } }); // the user connects
    control.end();
    const pipes = [path.replace(/^\\\\\.\\pipe\\/, ""), ...["docker_engine", "openssh-ssh-agent"].filter((n) => existsSync(`\\\\.\\pipe\\${n}`))];
    for (const name of pipes) {
      const r = await call(tools.PowerShell!, { command: `try { $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${name}', [System.IO.Pipes.PipeDirection]::InOut); $c.Connect(3000); 'PIPE-OPEN' } catch { 'PIPE-REFUSED ' + $_.Exception.GetType().Name }` });
      console.log(`[e2e] pipe ${name}: ${r.text.trim()}`);
      expect(r.text).toContain("PIPE-REFUSED");
    }
    server.stop(true);
  }, 900_000);

  test("a timeout ends everything the command started: a delayed grandchild never writes its marker", async () => {
    const marker = join(scratch, "late.txt");
    rmSync(marker, { force: true });
    const r = await call(tools.Bash!, { command: "(sleep 5; echo late > late.txt) & sleep 60", timeout: 2000 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Command timed out");
    await Bun.sleep(8000);
    expect(existsSync(marker)).toBe(false);
  }, 900_000);

  test("two commands at once run as two principals (a principal per running command)", async () => {
    const [a, b] = await Promise.all([call(tools.Bash!, { command: "whoami; sleep 3" }), call(tools.Bash!, { command: "whoami; sleep 3" })]);
    expect(a.text).toContain("moss-sb-");
    expect(b.text).toContain("moss-sb-");
    expect(a.text.trim()).not.toBe(b.text.trim());
  }, 900_000);

  test("nothing carries over: what a command leaves in its account's real profile and hive is gone when that account runs again", async () => {
    // The account's real profile, by its SID in ProfileList (past the command's own HOME), and its hive
    // (HKCU\\Environment, which a later logon would load into the next command's environment).
    const realProfile = "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $p = (Get-ItemProperty \"HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\$sid\").ProfileImagePath";
    const plant = await call(tools.PowerShell!, { command: `${realProfile}; Set-Content -LiteralPath (Join-Path $p 'carry.txt') -Value planted; [Environment]::SetEnvironmentVariable('MOSS_CARRY', 'planted', 'User'); 'as=' + [Environment]::UserName + ' in ' + $p` });
    const who = /as=(moss-sb-\S+)/.exec(plant.text)?.[1];
    expect(who).toBeDefined();
    let seen = false;
    for (let i = 0; i < 10 && !seen; i++) {
      const look = await call(tools.PowerShell!, { command: `${realProfile}; 'user=' + [Environment]::UserName + ' file=' + (Test-Path -LiteralPath (Join-Path $p 'carry.txt')) + ' env=' + [Environment]::GetEnvironmentVariable('MOSS_CARRY', 'User') + ' process=' + $env:MOSS_CARRY` });
      console.log(`[e2e] after the plant by ${who}: ${look.text.trim()}`);
      expect(look.text).toContain("file=False");
      expect(look.text).not.toContain("planted");
      if (look.text.includes(`user=${who} `)) seen = true;
    }
    expect(seen).toBe(true); // the planting account ran again, on a profile and hive made fresh
  }, 900_000);

  test("the escape floor holds where nothing exists yet: a PowerShell profile planted under Documents is moved aside", async () => {
    mkdirSync(join(home, "Documents"), { recursive: true });
    const dir = join(home, "Documents", "WindowsPowerShell");
    rmSync(dir, { recursive: true, force: true });
    const r = await call(tools.PowerShell!, { command: `New-Item -ItemType Directory -Force -Path '${dir}' | Out-Null; Set-Content -LiteralPath '${join(dir, "Microsoft.PowerShell_profile.ps1")}' -Value 'planted'; 'made'`, dangerouslyDisableSandbox: true });
    expect(r.text).toContain("made");
    expect(existsSync(join(dir, "Microsoft.PowerShell_profile.ps1"))).toBe(false);
  }, 900_000);

  test("nothing runs later: in a repo that was there, a risky git key is reverted and a planted hook moved aside; a .git made by the command goes whole", async () => {
    // A repo the user made (the command can't write its .git: a held name), with its hooks folder.
    rmSync(join(scratch, "repo"), { recursive: true, force: true });
    mkdirSync(join(scratch, "repo", ".git", "hooks"), { recursive: true });
    writeFileSync(join(scratch, "repo", ".git", "config"), "[core]\n\tbare = false\n");
    const r = await call(tools.Bash!, { command: "git -C repo config core.hooksPath /c/elsewhere; printf '#!/bin/sh\\necho planted\\n' > repo/.git/hooks/post-checkout; echo done" });
    expect(r.text).toContain("done");
    expect(readFileSync(join(scratch, "repo", ".git", "config"), "utf8")).not.toContain("hooksPath");
    expect(existsSync(join(scratch, "repo", ".git", "hooks", "post-checkout"))).toBe(false);
    // A repo the command makes: its .git is a held name made under a root, moved aside after the run (Linux's way;
    // the Mac refuses the write).
    rmSync(join(scratch, "repo2"), { recursive: true, force: true });
    const m = await call(tools.Bash!, { command: "git init -q repo2; echo made" });
    expect(m.text).toContain("made");
    expect(existsSync(join(scratch, "repo2", ".git"))).toBe(false);
    expect(m.text).toContain("quarantined");
  }, 900_000);

  test("nothing runs later: the run-later names a command makes under its roots are moved aside and named; a plain file stays", async () => {
    const names = [".vscode/tasks.json", ".envrc", ".mcp.json", ".claude/settings.json", ".husky/pre-commit", "deep/er/.vscode/settings.json"];
    for (const n of [".vscode", ".envrc", ".mcp.json", ".claude", ".husky", "deep", "notes.txt"]) rmSync(join(scratch, n), { recursive: true, force: true });
    const make = names.map((n) => `mkdir -p "$(dirname '${n}')" && echo planted > '${n}'`).join(" && ");
    const r = await call(tools.Bash!, { command: `${make} && echo kept > notes.txt && echo made` });
    expect(r.text).toContain("made");
    for (const n of names) expect(existsSync(join(scratch, ...n.split("/")))).toBe(false);
    for (const n of [".vscode", ".envrc", ".mcp.json", ".claude", ".husky"]) expect(r.text).toContain(join(scratch, n));
    // The positive control: an ordinary file the command wrote is still there.
    expect(readFileSync(join(scratch, "notes.txt"), "utf8").trim()).toBe("kept");
  }, 900_000);

  test("a fenced command can't register a scheduled task as its account (something that would run later, outside a command)", async () => {
    // A program that exists and a trigger any account may register for itself (`/sc once`): the test's own process
    // registers the very same task first (the control), so a refusal is the fence's, never a bad path or argument.
    const tr = "C:\\Windows\\System32\\cmd.exe";
    const args = ["/create", "/tn", "moss-e2e-control", "/tr", tr, "/sc", "once", "/st", "23:59", "/f"];
    const control = Bun.spawnSync(["schtasks", ...args], { stdout: "pipe", stderr: "pipe" });
    console.log(`[e2e] schtasks /create as the user (control): exit ${control.exitCode} ${control.stdout.toString().trim()} ${control.stderr.toString().trim()}`);
    expect(control.exitCode).toBe(0);
    Bun.spawnSync(["schtasks", "/delete", "/tn", "moss-e2e-control", "/f"]);
    const ps = await call(tools.PowerShell!, { command: `schtasks /create /tn moss-e2e-planted /tr '${tr}' /sc once /st 23:59 /f 2>&1 | Out-String; 'exit=' + $LASTEXITCODE` });
    // The Task Scheduler's own COM door, step by step, so a refusal names the step that refused (and its HRESULT):
    // the same script registers as the user first (the control), then is deleted.
    const com = (name: string) => `$step='create'; try { $s = New-Object -ComObject Schedule.Service; $step='Connect'; $s.Connect(); $step='GetFolder'; $f = $s.GetFolder('\\'); $step='NewTask'; $d = $s.NewTask(0); $t = $d.Triggers.Create(1); $t.StartBoundary = (Get-Date).AddHours(6).ToString('s'); $a = $d.Actions.Create(0); $a.Path = '${tr}'; $step='RegisterTaskDefinition'; $f.RegisterTaskDefinition('${name}', $d, 6, $null, $null, 3) | Out-Null; 'REGISTERED' } catch { 'REFUSED at ' + $step + ': 0x' + ('{0:X8}' -f $_.Exception.HResult) + ' ' + $_.Exception.Message }`;
    const comControl = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", com("moss-e2e-control2")], { stdout: "pipe", stderr: "pipe" });
    console.log(`[e2e] COM RegisterTaskDefinition as the user (control): ${comControl.stdout.toString().trim()} ${comControl.stderr.toString().trim().slice(0, 300)}`);
    expect(comControl.stdout.toString()).toContain("REGISTERED");
    Bun.spawnSync(["schtasks", "/delete", "/tn", "moss-e2e-control2", "/f"]);
    const cim = await call(tools.PowerShell!, { command: com("moss-e2e-planted2") });
    const exists = (n: string) => Bun.spawnSync(["schtasks", "/query", "/tn", n], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
    const made = exists("moss-e2e-planted"), made2 = exists("moss-e2e-planted2");
    console.log(`[e2e] schtasks /create as the account: ${ps.text.trim().replace(/\s+/g, " ").slice(0, 400)}; task exists: ${made}`);
    console.log(`[e2e] COM RegisterTaskDefinition as the account: ${cim.text.trim().replace(/\s+/g, " ").slice(0, 400)}; task exists: ${made2}`);
    for (const [n, m] of [["moss-e2e-planted", made], ["moss-e2e-planted2", made2]] as const) if (m) Bun.spawnSync(["schtasks", "/delete", "/tn", n, "/f"]);
    expect(made).toBe(false);
    expect(made2).toBe(false);
    expect(ps.text).not.toContain("exit=0");
    expect(cim.text).not.toContain("REGISTERED");
  }, 900_000);

  test("outside the profile: a folder Users may modify (a made-up one on the system drive, and Public) is never written", async () => {
    // Controls: the folder exists, the fenced command READS it (so a refusal of the write is the fence's, not a missing
    // path), and the same command writes its own scratch folder.
    const made = "C:\\moss-e2e-users-modify";
    rmSync(made, { recursive: true, force: true });
    mkdirSync(made, { recursive: true });
    expect(Bun.spawnSync(["icacls", made, "/grant", "*S-1-5-32-545:(OI)(CI)M"], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    writeFileSync(join(made, "seen.txt"), "visible\n");
    const pub = join(process.env.PUBLIC ?? "C:\\Users\\Public", "Documents");
    try {
      for (const dir of [made, pub]) {
        const target = join(dir, "moss-e2e-written.txt");
        rmSync(target, { force: true });
        const u = dir.replace(/\\/g, "/");
        const b = await call(tools.Bash!, { command: `cat '${u}/seen.txt' 2>/dev/null; ls '${u}' >/dev/null && echo LISTED; echo w > '${u}/moss-e2e-written.txt' && echo WROTE || echo REFUSED; echo ok > own.txt && echo OWN` });
        const p = await call(tools.PowerShell!, { command: `try { Set-Content -LiteralPath '${target}' -Value w -ErrorAction Stop; 'WROTE' } catch { 'REFUSED' }` });
        const wrote = existsSync(target);
        console.log(`[e2e] write outside the profile into ${dir}: bash ${b.text.includes("WROTE") ? "WROTE" : "REFUSED"}, powershell ${p.text.includes("WROTE") ? "WROTE" : "REFUSED"}, file there: ${wrote}`);
        rmSync(target, { force: true });
        expect(b.text).toContain("LISTED");
        if (dir === made) expect(b.text).toContain("visible");
        expect(b.text).toContain("OWN");
        expect(wrote).toBe(false);
        expect(b.text).toContain("REFUSED");
        expect(p.text).toContain("REFUSED");
      }
    } finally { rmSync(made, { recursive: true, force: true }); }
  }, 900_000);

  test("the move aside across drives and never through a link: quarantined on another drive, a junction on the way named and left", async () => {
    const other = ["D:\\", "E:\\"].find((d) => { try { return lstatSync(d).isDirectory() && d.toUpperCase()[0] !== moss.toUpperCase()[0]; } catch { return false; } });
    console.log(`[e2e] another drive: ${other ?? "none"}`);
    if (other === undefined) return;
    const root = join(other, `moss-e2e-q-${process.pid}`);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, "real"), { recursive: true });
    try {
      const planted = join(root, ".envrc");
      writeFileSync(planted, "planted\n");
      const line = quarantineWin(new Map([[planted, false]]), moss);
      console.log(`[e2e] across drives: ${line?.trim()}`);
      expect(existsSync(planted)).toBe(false);
      expect(line).toContain("quarantined");
      expect(readdirSync(join(moss, "quarantine")).some((n) => n.startsWith(".envrc.quarantined-"))).toBe(true);
      // A junction on the way: the move would act through it, so it is left and named.
      expect(Bun.spawnSync(["cmd", "/c", "mklink", "/J", join(root, "via"), join(root, "real")], { stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
      const through = join(root, "via", ".mcp.json");
      writeFileSync(through, "planted\n");
      const left = quarantineWin(new Map([[through, false]]), moss);
      console.log(`[e2e] through a junction: ${left?.trim()}`);
      expect(left).toContain("could NOT be moved");
      expect(left).toContain(through);
      expect(existsSync(join(root, "real", ".mcp.json"))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 900_000);

  test("two commands at once: when one ends, the one still running still can't read a denied file, and its own grants hold", async () => {
    // B reads the run token every half second for 20 s, starting before A and ending well after A's end (and A's
    // end-of-command revoke, before the fix).
    const loop = `for i in $(seq 1 40); do cat '${join(moss, "run", "token").replace(/\\/g, "/")}' 2>/dev/null; echo tick > /dev/null; sleep 0.5; done; echo b-done > b.txt; echo finished`;
    const b = call(tools.Bash!, { command: loop, timeout: 120_000 });
    await Bun.sleep(1_000);
    const a = await call(tools.Bash!, { command: "whoami" });
    expect(a.text).toContain("moss-sb-");
    const bb = await b;
    expect(bb.text).toContain("finished");
    expect(bb.text).not.toContain("dummy123");
    expect(readFileSync(join(scratch, "b.txt"), "utf8").trim()).toBe("b-done"); // B's write root held to its end
  }, 900_000);

  test("can a pool account start a process that outlives its command (outside the launcher's kill-on-close job)? recorded", async () => {
    // Lane WS6 (the WS5 reviewer's question): a fenced PowerShell command tries three ways to start a process that
    // outlives it, each tagged with its own marker in the command line: WMI's Win32_Process.Create (made by the WMI
    // provider host), the Shell.Application object (an out-of-process COM server when one is there), and plain
    // Start-Process (the control: inside the job). After the command has ended, the test's own process (an
    // administrator) lists every process whose command line carries a marker, and ends what it finds (processes
    // this test made). Recorded, not asserted: what it finds is the answer to the question.
    const tag = `moss-outlive-${process.pid}`;
    const ping = (how: string) => `cmd.exe /c title ${tag}-${how} & ping -n 90 127.0.0.1`;
    const r = await call(tools.PowerShell!, { command: [
      `try { $w = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${ping("wmi")}' } -ErrorAction Stop; 'wmi=' + $w.ReturnValue } catch { 'wmi=REFUSED ' + $_.Exception.Message }`,
      `try { (New-Object -ComObject Shell.Application).ShellExecute('cmd.exe', '/c title ${tag}-shell & ping -n 90 127.0.0.1', '', 'open', 0); 'shell=started' } catch { 'shell=REFUSED ' + $_.Exception.Message }`,
      `try { Start-Process -FilePath cmd.exe -ArgumentList '/c title ${tag}-start & ping -n 90 127.0.0.1' -WindowStyle Hidden -ErrorAction Stop; 'start=started' } catch { 'start=REFUSED ' + $_.Exception.Message }`,
    ].join("; ") });
    console.log(`[e2e] outlive probe, inside the command: ${r.text.replace(/\s+/g, " ").slice(0, 600)}`);
    await Bun.sleep(5_000);
    const list = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${tag}*' } | ForEach-Object { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwner; "$($_.ProcessId) $($o.Domain)\\$($o.User) $($_.CommandLine)" }`],
      { stdout: "pipe", stderr: "pipe" }).stdout.toString().trim();
    const survivors = list.split(/\r?\n/).filter((l) => l.trim() !== "" && !l.includes("Get-CimInstance"));
    console.log(`[e2e] outlive probe, after the command ended: ${survivors.length === 0 ? "nothing outlived it" : survivors.join(" | ")}`);
    for (const l of survivors) { const pid = Number(l.split(" ")[0]); if (pid > 0) Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"]); }
  }, 900_000);

  test("a stop reaches the command: it ends at once, with what it started, never waiting for its time limit", async () => {
    const marker = join(scratch, "late-abort.txt");
    const began = join(scratch, "began-abort.txt");
    for (const f of [marker, began]) rmSync(f, { force: true });
    // The stop comes 2 s after the command has really started (it writes `began-abort.txt` first), never at a fixed
    // time from the call: a launch that waits on a fresh account or a session grant would be stopped before it ran.
    const ac = new AbortController();
    let started = 0;
    const watch = setInterval(() => { if (existsSync(began)) { clearInterval(watch); started = Date.now(); setTimeout(() => ac.abort(), 2_000); } }, 100);
    const r = await call(tools.Bash!, { command: "echo began > began-abort.txt; (sleep 10; echo late > late-abort.txt) & sleep 300", timeout: 600_000 }, { signal: ac.signal });
    clearInterval(watch);
    expect(started).toBeGreaterThan(0);
    const took = Date.now() - started;
    console.log(`[e2e] stopped after ${took} ms`);
    expect(r.isError).toBe(true);
    expect(took).toBeLessThan(120_000);
    await Bun.sleep(12_000);
    expect(existsSync(marker)).toBe(false);
  }, 900_000);

  test("a fenced file the user's daemon replaces while a command runs stays unreadable to it (a new file in the MOSS home mid-run)", async () => {
    const secret = join(moss, "secrets.enc");
    const loop = `for i in $(seq 1 30); do cat '${secret.replace(/\\/g, "/")}' 2>/dev/null; cat '${join(moss, "fresh-mid-run.enc").replace(/\\/g, "/")}' 2>/dev/null; sleep 0.5; done; echo finished`;
    const b = call(tools.Bash!, { command: loop, timeout: 120_000 });
    await Bun.sleep(4_000);
    // The daemon's way of writing: a temporary file in the same folder, renamed over the old one; and a new file.
    writeFileSync(join(moss, "secrets.enc.tmp"), `${SECRET}\n`);
    renameSync(join(moss, "secrets.enc.tmp"), secret);
    writeFileSync(join(moss, "fresh-mid-run.enc"), `${SECRET}\n`);
    const bb = await b;
    console.log(`[e2e] mid-run replace: dummy visible = ${bb.text.includes("dummy123")}`);
    expect(bb.text).toContain("finished");
    expect(bb.text).not.toContain("dummy123");
  }, 900_000);

  test("the escape: a bot's own conversation's approved command writes the home, never MOSS's settings, and has the network but the metadata address", async () => {
    mkdirSync(join(home, "ws-escape-dir"), { recursive: true });
    const target = join(home, "ws-escape-dir", "x.txt");
    rmSync(target, { force: true });
    const e = await call(tools.Bash!, { command: `echo escaped > '${target.replace(/\\/g, "/")}'; whoami`, dangerouslyDisableSandbox: true });
    expect(e.isError).toBe(false);
    expect(readFileSync(target, "utf8").trim()).toBe("escaped");
    expect(e.text).toMatch(/moss-sb-[0-9a-f]{6}-e/); // the escape account, never a pool account nor the user
    const before = readFileSync(join(moss, "settings.json"), "utf8");
    const s = await call(tools.Bash!, { command: `echo x > '${join(moss, "settings.json").replace(/\\/g, "/")}'`, dangerouslyDisableSandbox: true });
    expect(s.isError).toBe(true);
    expect(readFileSync(join(moss, "settings.json"), "utf8")).toBe(before);
    const probe = (host: string, port: number) => `timeout 8 bash -c 'exec 3<>/dev/tcp/${host}/${port}' && echo CONNECTED || echo REFUSED`;
    const n = await call(tools.Bash!, { command: probe("1.1.1.1", 443), dangerouslyDisableSandbox: true });
    expect(n.text).toContain("CONNECTED");
    const psNet = await call(tools.PowerShell!, { command: "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('1.1.1.1', 443); 'CONNECTED' } catch { 'REFUSED' }", dangerouslyDisableSandbox: true });
    expect(psNet.text).toContain("CONNECTED");
    // The metadata address: refused to the escape account wherever the user reaches it.
    const reach = async (host: string, port: number) => {
      try { const c = await Promise.race([Bun.connect({ hostname: host, port, socket: { data() {} } }), Bun.sleep(5000).then(() => null)]); if (c) { c.end(); return true; } return false; } catch { return false; }
    };
    const metadata = await reach("169.254.169.254", 80);
    const md = await call(tools.Bash!, { command: probe("169.254.169.254", 80), dangerouslyDisableSandbox: true });
    console.log(`[e2e] escape network: public ${n.text.includes("CONNECTED")}, metadata from the user ${metadata}, from the escape ${md.text.includes("CONNECTED")}`);
    if (metadata) expect(md.text).toContain("REFUSED");
    // Every other metadata address patch 0003 blocks (lane WS4): another in the link-local /16, Azure's WireServer,
    // Alibaba's, Oracle's; each asserted where the user reaches it (the WireServer answers on GitHub's Azure runners).
    for (const [host, port] of [["168.63.129.16", 80], ["169.254.169.253", 53], ["100.100.100.200", 80], ["192.0.0.192", 80]] as const) {
      const ctl = await reach(host, port);
      const got = await call(tools.Bash!, { command: probe(host, port), dangerouslyDisableSandbox: true });
      console.log(`[e2e] escape to ${host}:${port}: from the user ${ctl}, from the escape ${got.text.includes("CONNECTED")}`);
      if (ctl) expect(got.text).toContain("REFUSED");
    }
    // The IPv4-mapped IPv6 spelling of the main one, from a dual-mode socket: the same script as the user (the control)
    // and as the escape.
    const mapped = "try { $s = New-Object Net.Sockets.Socket([Net.Sockets.AddressFamily]::InterNetworkV6, [Net.Sockets.SocketType]::Stream, [Net.Sockets.ProtocolType]::Tcp); $s.DualMode = $true; $r = $s.BeginConnect([Net.IPAddress]::Parse('::ffff:169.254.169.254'), 80, $null, $null); if ($r.AsyncWaitHandle.WaitOne(6000) -and $s.Connected) { 'CONNECTED' } else { 'REFUSED' } } catch { 'REFUSED' }";
    const mappedCtl = Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command", mapped], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
    const mappedEsc = await call(tools.PowerShell!, { command: mapped, dangerouslyDisableSandbox: true });
    console.log(`[e2e] escape to ::ffff:169.254.169.254: from the user ${mappedCtl.includes("CONNECTED")}, from the escape ${mappedEsc.text.includes("CONNECTED")}`);
    if (mappedCtl.includes("CONNECTED")) expect(mappedEsc.text).toContain("REFUSED");
    // The same bot's next command in the sandbox has no network again.
    const back = await call(tools.Bash!, { command: probe("1.1.1.1", 443) });
    expect(back.text).toContain("REFUSED");
    // A side thread's command never leaves the sandbox, whatever it asks.
    const side = await call(sideTools.Bash!, { command: "echo hi", dangerouslyDisableSandbox: true }, { refusal: true });
    expect(side.isError).toBe(true);
    expect(side.text).toContain("never leave the sandbox");
  }, 900_000);

  test("two coding sessions at once: a session's new outputs folder (a write root, read included) never opens to the other's running command", async () => {
    // B's command runs first and reads A's outputs folder in a loop; A's folder is made only after B started (B's plan
    // can't deny it by name), and then A's first command makes it a write root. The wait keeps them apart (rule 3b with
    // write roots, lane WS4): A starts only after B ends, and B never reads A's file.
    const exec = fencedExecutor({ spawner: fencedSpawner({ fence }), home, temp: fence.temp, mossHome: moss, os: "windows" });
    const ctxOf = (id: string, cwd: string) => ({ as: { kind: "session", sessionId: id, sessionKind: "coding" } as Caller, cwd, signal: new AbortController().signal, output: () => {} }) as unknown as Parameters<ReturnType<typeof fencedExecutor>["run"]>[2];
    const outA = join(moss, "outputs", "e2e-ov-a"), outB = join(moss, "outputs", "e2e-ov-b");
    for (const d of [outA, outB]) rmSync(d, { recursive: true, force: true });
    mkdirSync(outB, { recursive: true });
    const secretA = join(outA, "secret.txt").replace(/\\/g, "/");
    const bRun = exec.run("Bash", { command: `echo began > began.txt; for i in $(seq 1 40); do cat '${secretA}' 2>/dev/null; sleep 0.5; done; echo b-finished` }, ctxOf("e2e-ov-b", outB)).then((r) => ({ r, at: Date.now() }));
    for (let i = 0; i < 1200 && !existsSync(join(outB, "began.txt")); i++) await Bun.sleep(100);
    expect(existsSync(join(outB, "began.txt"))).toBe(true);
    mkdirSync(outA, { recursive: true });
    writeFileSync(join(outA, "secret.txt"), `${SECRET}\n`);
    expect(readFileSync(join(outA, "secret.txt"), "utf8")).toContain("dummy123"); // the control: the file is there
    const aStarted = Date.now();
    const a = await exec.run("Bash", { command: "echo mine > own.txt && echo a-done" }, ctxOf("e2e-ov-a", outA));
    const aEnded = Date.now();
    const b = await bRun;
    const bText = JSON.stringify(b.r.output);
    console.log(`[e2e] overlap: A waited ${aEnded - aStarted} ms, B ended ${b.at <= aEnded ? "before" : "after"} A; B saw the dummy: ${bText.includes("dummy123")}`);
    expect(JSON.stringify(a.output)).toContain("a-done");
    expect(bText).toContain("b-finished");
    expect(bText).not.toContain("dummy123");
    expect(b.at).toBeLessThanOrEqual(aEnded);
    // The reviewer's open question, on the runner: A's write root carries a group entry that includes read, and it
    // outlives A's command.
    const acl = Bun.spawnSync(["icacls", outA], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
    const line = acl.split(/\r?\n/).find((l) => /sandbox-runtime-users/i.test(l));
    console.log(`[e2e] A's outputs folder after A's command: ${line?.trim()}`);
    expect(line).toBeDefined();
    expect(/\((?:[A-Z]+,)*(?:RX|R|M|F|GR)(?:,[A-Z]+)*\)/.test(line!)).toBe(true);
    // B's later command: A's folder exists now, so B's plan denies it by name (and rule 3c by the root this process
    // granted): still unread.
    const again = await exec.run("Bash", { command: `cat '${secretA}' 2>&1; echo b2` }, ctxOf("e2e-ov-b", outB));
    console.log(`[e2e] B's later read of A's folder: dummy visible = ${JSON.stringify(again.output).includes("dummy123")}`);
    expect(JSON.stringify(again.output)).toContain("b2");
    expect(JSON.stringify(again.output)).not.toContain("dummy123");
  }, 1_800_000);

  test("the move across drives is capped: a planted tree over the entries cap on another drive stays and is named", async () => {
    const other = ["D:\\", "E:\\"].find((d) => { try { return lstatSync(d).isDirectory() && d.toUpperCase()[0] !== moss.toUpperCase()[0]; } catch { return false; } });
    console.log(`[e2e] another drive for the cap: ${other ?? "none"}`);
    if (other === undefined) return;
    const root = join(other, `moss-e2e-cap-${process.pid}`);
    rmSync(root, { recursive: true, force: true });
    const tree = join(root, ".husky");
    mkdirSync(tree, { recursive: true });
    try {
      for (let i = 0; i <= QUARANTINE_COPY_LIMITS.entries; i++) writeFileSync(join(tree, `h${i}`), "x");
      const started = Date.now();
      const line = quarantineWin(new Map([[tree, false]]), moss);
      console.log(`[e2e] over the cap (${QUARANTINE_COPY_LIMITS.entries + 2} entries) in ${Date.now() - started} ms: ${line?.trim()}`);
      expect(line).toContain("could NOT be moved aside");
      expect(line).toContain(tree);
      expect(existsSync(join(tree, `h${QUARANTINE_COPY_LIMITS.entries}`))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 900_000);

  test("the computer node's Bash (no runtime settings): a coding session writes its own outputs and nothing of the MOSS home", async () => {
    const outputs = join(moss, "outputs", "e2e-code");
    const exec = fencedExecutor({ spawner: fencedSpawner({ fence }), home, temp: fence.temp, mossHome: moss, os: "windows" });
    const as = { kind: "session", sessionId: "e2e-code", sessionKind: "coding" } as Caller;
    const ctx = { as, cwd: outputs, signal: new AbortController().signal, output: () => {} } as unknown as Parameters<ReturnType<typeof fencedExecutor>["run"]>[2];
    const ok = await exec.run("Bash", { command: "echo out > out.txt && whoami" }, ctx);
    console.log(`[e2e] node Bash: ${JSON.stringify(ok.output).slice(0, 300)}`);
    expect(ok.isError).toBe(false);
    expect(readFileSync(join(outputs, "out.txt"), "utf8").trim()).toBe("out");
    const before = readFileSync(join(moss, "settings.json"), "utf8");
    const no = await exec.run("Bash", { command: `echo x > '${join(moss, "settings.json").replace(/\\/g, "/")}'` }, ctx);
    expect(no.isError).toBe(true);
    expect(JSON.stringify(no.output)).not.toContain("refused:");
    expect(readFileSync(join(moss, "settings.json"), "utf8")).toBe(before);
    const read = await exec.run("Bash", { command: `cat '${join(moss, "notes", "readme.txt").replace(/\\/g, "/")}'` }, ctx);
    expect(JSON.stringify(read.output)).not.toContain("refused:");
    expect(JSON.stringify(read.output)).not.toContain("a note any bot may read"); // the MOSS home is default-deny for a coding session
  }, 900_000);

  test("two engines, two homes, one Windows user: neither's grant opens the other's secrets; a grant in force without them fails closed", async () => {
    // A second engine's home (the developers' and the test twin's way): its own spawner, so its own profile grant, made
    // AFTER this home's; its exclusions are added to the ones in force, never replacing this home's.
    const mossB = join(home, ".moss-e2e-b");
    rmSync(mossB, { recursive: true, force: true });
    for (const d of [join(mossB, "run"), join(mossB, "scratch", BOT), join(mossB, "bots", BOT, "memory")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(mossB, "run", "token"), `${SECRET}\n`);
    writeFileSync(join(mossB, "secrets.enc"), `${SECRET}\n`);
    const fenceB = new MossFence({ home, mossHome: mossB });
    const toolsB = Object.fromEntries(windowsShellTools({
      spawner: fencedSpawner({ fence: fenceB }), caller: CALLER, kind: "bot", cwd: () => join(mossB, "scratch", BOT), userHome: home, temp: fenceB.temp, mossHome: mossB,
      sandbox: () => {
        const settings = botSandboxSettings(fenceB.forCaller(CALLER).policy(), { mossHome: mossB, userHome: home, level: undefined, windows: true, ownFolders: [join(mossB, "scratch", BOT), join(mossB, "bots", BOT)], pathFolders: [] });
        return botSandbox(withBotKeyReads(withSecretReads(settings, { userHome: home, os: "windows" }), { home: mossB }), { userHome: home, os: "windows" });
      },
    }).map((t) => [t.name, t]));
    const u = (p: string) => p.replace(/\\/g, "/");
    const readBoth = `cat '${u(join(moss, "secrets.enc"))}' '${u(join(moss, "run", "token"))}' '${u(join(mossB, "secrets.enc"))}' '${u(join(mossB, "run", "token"))}' 2>/dev/null; echo done`;
    try {
      const b = await call(toolsB.Bash!, { command: readBoth });
      expect(b.text).toContain("done");
      expect(b.text).not.toContain("dummy123");
      const a = await call(tools.Bash!, { command: readBoth });
      expect(a.text).toContain("done");
      expect(a.text).not.toContain("dummy123");
      // Fail closed: a grant in force made WITHOUT this home's exclusions (as a replacing run of another engine leaves
      // it): this engine still believes its grant holds, reads back what the grant in force excludes, and stamps the
      // rest for the command.
      const launcher = join(process.env.ProgramFiles ?? "C:\\Program Files", "MOSS Sandbox", currentUserSid()!, "srt-win.exe");
      const replaced = Bun.spawnSync([launcher, "profile", "grant", "--quiet", "--json", "--replace-excludes"], { stdout: "pipe", stderr: "pipe" });
      console.log(`[e2e] a replacing grant with no added exclusions: exit ${replaced.exitCode}`);
      expect(replaced.exitCode).toBe(0);
      // The precondition: the grant in force no longer excludes this home's secrets (so the pass below is the
      // per-command stamps', not the grant's).
      const st = Bun.spawnSync([launcher, "profile", "status"], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
      const listed = (JSON.parse(st) as { exclusions?: string[] }).exclusions ?? [];
      const has = (p: string) => listed.some((e) => e.replace(/^\\\\\?\\/, "").toLowerCase() === p.toLowerCase());
      console.log(`[e2e] after the replacing grant, excluded: run ${has(join(moss, "run"))}, secrets.enc ${has(join(moss, "secrets.enc"))}`);
      expect(has(join(moss, "run")) || has(join(moss, "secrets.enc"))).toBe(false);
      // (This home's own secrets: the other home's exclusions are gone with the replacing run, and this engine's plan
      // knows nothing of that home; no run of this version replaces.)
      const c = await call(tools.Bash!, { command: `cat '${u(join(moss, "secrets.enc"))}' '${u(join(moss, "run", "token"))}' 2>/dev/null; echo done` });
      console.log(`[e2e] two homes, after the replacing grant: dummy visible = ${c.text.includes("dummy123")}`);
      expect(c.text).toContain("done");
      expect(c.text).not.toContain("dummy123");
    } finally {
      // The exclusions of both homes again, as each engine's next start would make them.
      const launcher = join(process.env.ProgramFiles ?? "C:\\Program Files", "MOSS Sandbox", currentUserSid()!, "srt-win.exe");
      const ex = [...profileExcludeCandidates(fence), ...profileExcludeCandidates(fenceB)].filter((p) => existsSync(p));
      Bun.spawnSync([launcher, "profile", "grant", "--quiet", "--json", ...ex.flatMap((p) => ["--exclude", p])], { stdout: "pipe", stderr: "pipe" });
      rmSync(mossB, { recursive: true, force: true });
    }
  }, 1_800_000);
});
