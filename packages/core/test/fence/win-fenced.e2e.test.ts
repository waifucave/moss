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
import { botSandboxSettings, runLaterByName } from "../../src/fence/sandbox-settings";
import { botFileFence, botSandbox, withBotKeyReads, withSecretReads } from "../../src/runtime-sdk/turn-loop/driver";
import { fileToolFenceRefusal } from "../../src/runtime-sdk/turn-loop/file-fence";
import { fileToolRefusal } from "../../src/agents/moss-code/backend";
import { secretReadPlaces } from "../../src/contracts/fence";
import { rmdirSync, symlinkSync } from "node:fs";
import { MossApprovalBroker } from "../../src/approvals/broker";
import { botApprovalCheck, runsLaterPlace, windowsFileToolInput } from "../../src/approvals/bot-check";
import { FakeClock } from "../../src/contracts/fakes/clock";
import type { BotSessionContext } from "../../src/bots/service";
import type { CanUseTool } from "@waifucave/clover-agent-sdk";
import { agentShellTools, stopWindowsBackground, windowsShellTools } from "../../src/fence/win-shell-tools";
import { planFromSettings, profileExcludeCandidates, QUARANTINE_COPY_LIMITS, quarantineWin, watchedReadDenies, windowsShells } from "../../src/fence/win-fenced";
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
let bgTools: Record<string, CoreToolDef>;
const wakes: { task: string; status: string; text: string }[] = [];
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
  // A background start says "started", never "ok": it answers before its launch is known (the standard-user job's
  // fail-closed check counts every "-> ok" as a command that ran).
  const how = r.isError ? "error" : input.run_in_background === true ? "started" : "ok";
  console.log(`[e2e] ${t.name} ${JSON.stringify(input.command).slice(0, 120)} -> ${how} in ${Date.now() - started} ms: ${r.text.slice(0, 300).replace(/\s+/g, " ")}`);
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
    bgTools = Object.fromEntries(windowsShellTools({
      spawner, caller: CALLER, kind: "bot", cwd: () => scratch, sandbox: sandboxFor, userHome: home, temp: fence.temp, mossHome: moss,
      wake: async (w) => { wakes.push(w); },
    }).map((t) => [t.name, t]));
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

  test("8.3 short names and junctions (lane WS8, the reviewer's finding): the coding agent's and a bot's file tools refuse a denied folder and the MOSS home by any spelling", async () => {
    // A folder's short name, from Windows itself (the Scripting runtime's ShortPath; the path in the environment, never quoted).
    const shortOf = (p: string) => {
      const r = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:WS8_P).ShortPath"], { env: { ...process.env, WS8_P: p } });
      return r.stdout.toString().trim();
    };
    // One the volume made, or one set now (`fsutil file setshortname`; with the volume's 8.3 names off, they are let on
    // first, and the volume's setting is put back after). `fsutil` only on CI's own runner, and only as an administrator.
    const elevated = Bun.spawnSync(["net", "session"]).exitCode === 0;
    const mayChange = process.env.CI !== undefined && elevated;
    const drive = home.slice(0, 2);
    const volumeState = /state is:?\s*(\d)/i.exec(Bun.spawnSync(["fsutil", "8dot3name", "query", drive]).stdout.toString())?.[1];
    let volumeChanged = false;
    const shortened = (p: string, name: string): string | undefined => {
      const has = () => { const s = shortOf(p); return s !== "" && s.toLowerCase() !== p.toLowerCase() ? s : undefined; };
      let s = has();
      if (s === undefined && mayChange) { Bun.spawnSync(["fsutil", "file", "setshortname", p, name]); s = has(); }
      if (s === undefined && mayChange && volumeState !== undefined && volumeState !== "0") {
        Bun.spawnSync(["fsutil", "8dot3name", "set", drive, "0"]); volumeChanged = true;
        Bun.spawnSync(["fsutil", "file", "setshortname", p, name]); s = has();
      }
      return s;
    };
    const ssh = join(home, ".ssh");
    let shortSsh: string | undefined, shortMoss: string | undefined;
    try { shortSsh = shortened(ssh, "SSHE2E~1"); shortMoss = shortened(moss, "MOSSE2~1"); }
    finally { if (volumeChanged) Bun.spawnSync(["fsutil", "8dot3name", "set", drive, volumeState!]); }
    console.log(`[e2e] 8.3: ${ssh} -> ${shortSsh ?? "(no short name could be made)"}; ${moss} -> ${shortMoss ?? "(no short name could be made)"}; elevated ${elevated}; the volume's 8.3 state ${volumeState ?? "unread"}${volumeChanged ? ", changed and put back" : ""}`);
    if ((shortSsh === undefined || shortMoss === undefined) && !elevated) {
      // The standard user's job: no fsutil there, and no short name the volume made. The elevated job is the proof.
      console.log("[e2e] 8.3: SKIPPED here: no short name exists and this user can't make one (the administrator's job proves it)");
      return;
    }
    expect(shortSsh).toBeDefined();
    expect(shortMoss).toBeDefined();
    // The Windows acceptance run's refusal (lane WS8): a bot's edit of an installed plugin's file named through the home's
    // short name is not a project's `.moss`; a project's `.moss` still is.
    const pluginFile = join(shortMoss!, "plugins", "ws-greeter", "host", "index.ts");
    const homes = { userHome: home, mossHome: moss, os: "windows" as const };
    console.log(`[e2e] 8.3 run-later: ${pluginFile} held ${runLaterByName(pluginFile, homes)}; a project's .moss held ${runLaterByName(join(home, "ws8-short-project", ".moss", "x"), homes)}`);
    expect(runLaterByName(pluginFile, homes)).toBe(false);
    expect(runLaterByName(join(home, "ws8-short-project", ".moss", "x"), homes)).toBe(true);
    // The same workshop row's next step (lane WS9): the Read by the short name and the Edit by the long one hand the runtime
    // one path, so its read-before-edit check counts the Read for the Edit.
    mkdirSync(join(moss, "plugins", "ws-greeter", "host"), { recursive: true });
    writeFileSync(join(moss, "plugins", "ws-greeter", "host", "index.ts"), "export {};\n");
    const readAs = windowsFileToolInput("Read", { file_path: pluginFile }, scratch)?.["file_path"] ?? pluginFile;
    const longFile = join(moss, "plugins", "ws-greeter", "host", "index.ts");
    const editAs = windowsFileToolInput("Edit", { file_path: longFile.replace(/\\/g, "/") }, scratch)?.["file_path"] ?? longFile;
    console.log(`[e2e] read set: Read ${pluginFile} -> ${readAs}; Edit ${longFile.replace(/\\/g, "/")} -> ${editAs}; one key ${readAs === editAs}`);
    expect(readAs).toBe(editAs);
    rmSync(join(moss, "plugins", "ws-greeter"), { recursive: true, force: true });
    const project = join(home, "ws8-short-project");
    rmSync(project, { recursive: true, force: true });
    mkdirSync(project, { recursive: true });
    symlinkSync(ssh, join(project, "keys"), "junction");
    symlinkSync(moss, join(project, "mosslink"), "junction");
    const bot = botFileFence(fence, moss, "windows", home)({ caller: CALLER } as never);
    const agentFence = { denyRead: [moss, ...secretReadPlaces("windows", home).map((p) => p.path)], denyWrite: [moss] };
    const asked = [
      join(shortSsh!, "id_e2e"),                     // a secret place by its short name
      join(shortMoss!, "run", "token"),              // the MOSS home by its short name
      join(shortMoss!, "secrets.enc"),
      join(project, "keys", "id_e2e"),               // a junction in the root to a secret place
      join(project, "mosslink", "run", "token"),     // a junction in the root to the MOSS home
      `\\\\?\\${join(shortSsh!, "id_e2e")}`,     // the device prefix, with the short name
    ];
    for (const path of asked) {
      const agentWhy = fileToolRefusal({ tool_name: "Read", tool_input: { file_path: path } }, agentFence, project);
      const botWhy = fileToolFenceRefusal("Read", { file_path: path }, bot, scratch);
      console.log(`[e2e] 8.3 Read ${path}: agent refused ${agentWhy !== undefined}; bot refused ${botWhy !== undefined}`);
      expect([path, agentWhy !== undefined, botWhy !== undefined]).toEqual([path, true, true]);
    }
    // What is opened is what was judged (lane WS9): the spelling a file tool is handed through the junction is the secret
    // place itself, and that spelling is refused too, by both checks.
    const opened = windowsFileToolInput("Read", { file_path: join(project, "keys", "id_e2e") }, project)?.["file_path"];
    console.log(`[e2e] opened as judged: ${join(project, "keys", "id_e2e")} -> ${String(opened)}; refused for the agent ${fileToolRefusal({ tool_name: "Read", tool_input: { file_path: opened } }, agentFence, project) !== undefined}, for the bot ${fileToolFenceRefusal("Read", { file_path: opened }, bot, scratch) !== undefined}`);
    expect(String(opened).toLowerCase()).toBe(join(home, ".ssh", "id_e2e").toLowerCase());
    expect(fileToolRefusal({ tool_name: "Read", tool_input: { file_path: opened } }, agentFence, project)).toBeDefined();
    expect(fileToolFenceRefusal("Read", { file_path: opened }, bot, scratch)).toBeDefined();
    // The control: a plain file in the project is read by both.
    writeFileSync(join(project, "plain.txt"), "plain\n");
    expect(fileToolRefusal({ tool_name: "Read", tool_input: { file_path: join(project, "plain.txt") } }, agentFence, project)).toBeUndefined();
    expect(fileToolFenceRefusal("Read", { file_path: join(home, "ws-e2e-plain", "plain.txt") }, bot, scratch)).toBeUndefined();
    for (const link of ["keys", "mosslink"]) { try { rmdirSync(join(project, link)); } catch { /* already gone */ } } // a junction, never its target
    rmSync(project, { recursive: true, force: true });
  }, 300_000);

  test("a bot's read-only command at the ask level (lane WS9): no card while this computer's fence is set up; a writing one asks", async () => {
    // The daemon's wiring: the fence's own word that it can run here (`winSpawner.available`).
    const spawner = fencedSpawner({ fence });
    const broker = new MossApprovalBroker({ clock: new FakeClock(), levels: () => "ask", localComputer: "Studio" });
    const cards: string[] = [];
    const off = broker.watch((e) => {
      if (e.type !== "requested") return;
      cards.push(e.card.id);
      void broker.answer(e.card.id, { optionId: "deny", hash: e.card.hash, proof: { via: "sealed-frame", frame: broker.frameChannel(e.card.id)!, input: "click", at: 1 } }, { role: "app" });
    });
    const check = botApprovalCheck(broker, { commandsSandboxed: spawner.available, fencedReadOnlyCommands: () => spawner.available });
    const ctx = { botId: BOT, sessionId: "e2e-bot", kind: "bot", computer: "Studio", paths: { scratch }, caller: CALLER } as unknown as BotSessionContext;
    const opts = { signal: new AbortController().signal, toolUseID: "call_ro", requestId: "req_ro" } as Parameters<CanUseTool>[2];
    const ls = await check(ctx, () => "user")("Bash", { command: "ls -la" }, opts);
    const lsCards = cards.length;
    const npm = await check(ctx, () => "user")("Bash", { command: "npm test" }, opts);
    off();
    console.log(`[e2e] read-only rule: fence set up ${spawner.available}; \`ls -la\` -> ${ls?.behavior} with ${lsCards} card(s); \`npm test\` -> ${npm?.behavior} with ${cards.length - lsCards} card(s)`);
    expect(spawner.available).toBe(true);
    expect([ls?.behavior, lsCards]).toEqual(["allow", 0]);
    expect(cards.length - lsCards).toBe(1);
  });

  test("a project on a mapped drive (lane WS9): the coding agent's file tools work in it, and a link in it to a secret place is still refused", () => {
    const project = join(home, "ws9-mapped-project");
    rmSync(project, { recursive: true, force: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "plain.txt"), "plain\n");
    symlinkSync(join(home, ".ssh"), join(project, "keys"), "junction");
    // A free letter, mapped to this computer's own share of the project (`net use`, the session's own credentials, no prompt).
    const letter = ["Z", "Y", "X", "W", "V"].find((l) => !existsSync(`${l}:\\`));
    const share = `\\\\localhost\\${home.slice(0, 1)}$${project.slice(2)}`;
    const mapped = letter === undefined ? undefined : Bun.spawnSync(["net", "use", `${letter}:`, share, "/persistent:no"], { stdin: "ignore", timeout: 60_000 });
    const ok = mapped !== undefined && mapped.exitCode === 0 && existsSync(`${letter}:\\plain.txt`);
    console.log(`[e2e] mapped drive: ${letter ?? "(no free letter)"}: -> ${share}: mapped ${ok}${ok ? "" : ` (${(mapped?.stderr.toString() ?? "").trim().slice(0, 160)})`}`);
    try {
      if (!ok) {
        // Mapping a drive can't be done for every runner user; the unit tests hold the rule (fold-paths.test.ts).
        console.log("[e2e] mapped drive: SKIPPED here: no drive could be mapped to a share of this computer");
        return;
      }
      const root = `${letter}:\\`;
      const agentFence = { denyRead: [moss, ...secretReadPlaces("windows", home).map((p) => p.path)], denyWrite: [moss] };
      const read = (file_path: string) => fileToolRefusal({ tool_name: "Read", tool_input: { file_path } }, agentFence, root);
      const plain = read(`${root}plain.txt`), keys = read(`${root}keys\\id_e2e`);
      const glob = fileToolRefusal({ tool_name: "Glob", tool_input: { pattern: "*.txt", path: root } }, agentFence, root);
      const other = read(`\\\\localhost\\${home.slice(0, 1)}$\\Windows\\win.ini`);
      console.log(`[e2e] mapped drive: Read plain refused ${plain !== undefined}; Glob refused ${glob !== undefined}; Read through a junction to .ssh refused ${keys !== undefined}; another place on the share refused ${other !== undefined}`);
      expect(plain).toBeUndefined();
      expect(glob).toBeUndefined();
      expect(keys).toBeDefined();
      expect(other).toBeDefined();
    } finally {
      if (ok) Bun.spawnSync(["net", "use", `${letter}:`, "/delete", "/y"], { stdin: "ignore", timeout: 60_000 });
      try { rmdirSync(join(project, "keys")); } catch { /* already gone */ }
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("a junction a bot made in its workshop into a project's run-later place (lane WS9): a write through it is refused", async () => {
    const project = join(home, "ws9-junction-project");
    const workshop = join(moss, "plugins", "mine");
    rmSync(project, { recursive: true, force: true });
    mkdirSync(join(project, ".vscode"), { recursive: true });
    mkdirSync(workshop, { recursive: true });
    const j = join(workshop, "j");
    try { rmdirSync(j); } catch { /* not there */ }
    symlinkSync(project, j, "junction");
    try {
      const broker = new MossApprovalBroker({ clock: new FakeClock(), levels: () => "automatic", localComputer: "Studio" });
      const homes = { os: "windows" as const, userHome: home, mossHome: moss };
      const check = botApprovalCheck(broker, { commandsSandboxed: true, home, runsLater: (_c, p) => runsLaterPlace(p, [], homes, () => "ordinary") });
      const ctx = { botId: BOT, sessionId: "e2e-bot", kind: "bot", computer: "Studio", paths: { scratch }, caller: CALLER } as unknown as BotSessionContext;
      const opts = { signal: new AbortController().signal, toolUseID: "call_j", requestId: "req_j" } as Parameters<CanUseTool>[2];
      const through = await check(ctx, () => "user")("Write", { file_path: join(j, ".vscode", "settings.json"), content: "{}" }, opts);
      const plain = await check(ctx, () => "user")("Write", { file_path: join(workshop, "notes.txt"), content: "x" }, opts);
      console.log(`[e2e] workshop junction: Write through it to the project's .vscode -> ${through?.behavior}; a plain file in the workshop -> ${plain?.behavior}`);
      expect(through).toMatchObject({ behavior: "deny", message: expect.stringContaining("run or apply later") });
      expect(plain?.behavior).toBe("allow");
      expect(existsSync(join(project, ".vscode", "settings.json"))).toBe(false);
    } finally {
      try { rmdirSync(j); } catch { /* already gone */ }
      rmSync(project, { recursive: true, force: true });
    }
  });

  // Lane WS10, a MEASUREMENT for the controller (no fix rests on it yet). WS9 found that a fenced command's share NAME
  // never reaches Windows' name lookup (the DNS client's own log). Open: a share by IP ADDRESS (`//192.0.2.1/x`, no lookup
  // needed), and WHY the name never resolves (refused before the SMB redirector, or no network logon for the pool account:
  // the same reason would cover the address). Seen by Windows' packet monitor's own counters (`pktmon counters`, not its
  // text log) filtered on 192.0.2.1 (TEST-NET-1, routed nowhere), each window fenced and unfenced; a control whose window
  // shows no packet makes the probe BLIND, and nothing is concluded. The error each `ls` and `Get-ChildItem` prints, fenced
  // against unfenced, says where the open stops. Dummies only. Recorded, never asserted. Elevated on CI only.
  test("MEASURE (lane WS10): a fenced command's share by IP address, by packet counts, and why a share name never resolves", async () => {
    const elevated = Bun.spawnSync(["net", "session"]).exitCode === 0;
    if (!elevated || process.env.CI === undefined) { console.log(`[e2e] MEASURE: SKIPPED (elevated ${elevated}, CI ${process.env.CI !== undefined}): pktmon needs an administrator on CI's own runner`); return; }
    const pk = (...args: string[]) => { const r = Bun.spawnSync(["pktmon", ...args], { stdin: "ignore", timeout: 120_000 }); return { code: r.exitCode, out: `${r.stdout.toString()}${r.stderr.toString()}`.trim() }; };
    /** The packets the counters show, summed: from `--json` when this pktmon has it, else every number on a line naming
     *  packets, in or out. The raw text is printed too (short), so a reading that went wrong is seen. */
    const counted = (): { total: number; raw: string } => {
      const json = pk("counters", "--json");
      if (json.code === 0) {
        try {
          let total = 0;
          const walk = (v: unknown): void => {
            if (Array.isArray(v)) { v.forEach(walk); return; }
            if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (/packet/i.test(k) && typeof x === "number") total += x; else walk(x); }
          };
          walk(JSON.parse(json.out));
          return { total, raw: json.out.replace(/\s+/g, " ").slice(0, 300) };
        } catch { /* not JSON: the text below */ }
      }
      const text = pk("counters");
      const total = text.out.split(/\r?\n/).filter((l) => /\b(rx|tx|packets?|counter)\b/i.test(l)).flatMap((l) => [...l.matchAll(/\b\d[\d,]*\b/g)].map((m) => Number(m[0].replace(/,/g, "")))).reduce((a, b) => a + b, 0);
      return { total, raw: text.out.replace(/\s+/g, " ").slice(0, 300) };
    };
    const windowOf = async (label: string, attempt: () => unknown | Promise<unknown>) => {
      pk("stop");
      const started = pk("start", "--capture", "--counters-only");
      const fallback = started.code === 0 ? started : pk("start", "--capture");
      try { await attempt(); } finally { /* read before stopping: the counters are the running capture's */ }
      const c = counted();
      pk("stop");
      console.log(`[e2e] MEASURE ${label}: packets to 192.0.2.1 ${c.total} (start ${started.code}/${fallback.code}); counters: ${c.raw}`);
      return c.total;
    };
    // The unfenced control's shells, as the fence runs them (Git for Windows' bash, Windows PowerShell).
    const shells = windowsShells();
    const unfenced = (script: string, shell: "bash" | "powershell") => {
      const argv = shell === "bash" ? [shells.bash ?? "bash.exe", "-c", script] : [shells.powershell ?? "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script];
      const r = Bun.spawnSync(argv, { stdin: "ignore", timeout: 90_000 });
      return `${r.stdout.toString()}${r.stderr.toString()}`.trim().replace(/\s+/g, " ").slice(0, 300);
    };
    try {
      pk("filter", "remove");
      const added = pk("filter", "add", "WS10IP", "-i", "192.0.2.1");
      console.log(`[e2e] MEASURE pktmon filter: ${added.code} (${added.out.split(/\r?\n/)[0]?.slice(0, 120)})`);
      const quiet = await windowOf("quiet", () => Bun.sleep(3_000));
      const fencedIp = await windowOf("ip fenced (the bot's Bash)", () => call(tools.Bash!, { command: "ls //192.0.2.1/x >/dev/null 2>&1; echo done", timeout: 90_000 }));
      const controlIp = await windowOf("ip unfenced (the control)", () => unfenced("ls //192.0.2.1/x >/dev/null 2>&1; echo done", "bash"));
      const blind = controlIp <= quiet;
      console.log(`[e2e] MEASURE ip summary: ${blind ? `BLIND (the control's window showed ${controlIp} packet(s) against ${quiet} quiet)` : `fenced ${fencedIp} packet(s), control ${controlIp}, quiet ${quiet}`}`);
      // Why a share stops: what each shell says, fenced against unfenced (a name, an address, and a local path as the control
      // that the fenced shell runs at all).
      for (const [what, target] of [["name", `//ws10-why-${process.pid}.invalid/x`], ["address", "//192.0.2.1/x"]] as const) {
        const fb = await call(tools.Bash!, { command: `ls '${target}'; echo "exit $?"`, timeout: 90_000 });
        const fp = await call(tools.PowerShell!, { command: `try { Get-ChildItem -LiteralPath '${target.replace(/\//g, "\\")}' -ErrorAction Stop | Out-Null; 'ok' } catch { $_.Exception.GetType().Name + ': ' + $_.Exception.Message }`, timeout: 90_000 });
        const ub = unfenced(`ls '${target}'; echo "exit $?"`, "bash");
        const up = unfenced(`try { Get-ChildItem -LiteralPath '${target.replace(/\//g, "\\")}' -ErrorAction Stop | Out-Null; 'ok' } catch { $_.Exception.GetType().Name + ': ' + $_.Exception.Message }`, "powershell");
        console.log(`[e2e] MEASURE why (${what}) fenced bash: ${fb.text.replace(/\s+/g, " ").slice(0, 300)}`);
        console.log(`[e2e] MEASURE why (${what}) unfenced bash: ${ub}`);
        console.log(`[e2e] MEASURE why (${what}) fenced powershell: ${fp.text.replace(/\s+/g, " ").slice(0, 300)}`);
        console.log(`[e2e] MEASURE why (${what}) unfenced powershell: ${up}`);
        // The GUARD (lane WS11): the fenced shells' open of a share is refused locally, by name and by address.
        expect([what, "bash", fb.text]).toEqual([what, "bash", expect.stringContaining("Permission denied")]);
        expect([what, "powershell", fp.text]).toEqual([what, "powershell", expect.stringMatching(/UnauthorizedAccess|Access is denied/)]);
      }
      // The GUARD (lane WS11): with a control that sees its packets, a fenced command's share by address sends none. A
      // later change to the launcher's token or the pool accounts that opened shares to a fenced command fails here.
      if (blind) console.log("[e2e] MEASURE guard: BLIND, so the packet count is not judged on this run");
      else expect(fencedIp).toBe(0);
      // The layer, for the docs and the next reviewer (lane WS11; recorded, no assertion): the pool account's token under
      // the launcher, as the fenced PowerShell itself reads it (its groups and their attributes, whether the token is a
      // restricted one, whether the process is in a job), and the local logon rights that name that account.
      const facts = await call(tools.PowerShell!, { command: [
        "$sig = 'using System; using System.Runtime.InteropServices; public static class WsTok { [DllImport(\"kernel32.dll\")] public static extern IntPtr GetCurrentProcess(); [DllImport(\"kernel32.dll\")] public static extern bool IsProcessInJob(IntPtr p, IntPtr j, out bool r); [DllImport(\"advapi32.dll\")] public static extern bool OpenProcessToken(IntPtr p, uint a, out IntPtr t); [DllImport(\"advapi32.dll\")] public static extern bool IsTokenRestricted(IntPtr t); }'",
        "try { Add-Type -TypeDefinition $sig -ErrorAction Stop; $inJob = $false; [void][WsTok]::IsProcessInJob([WsTok]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$inJob); $t = [IntPtr]::Zero; [void][WsTok]::OpenProcessToken([WsTok]::GetCurrentProcess(), 8, [ref]$t); \"in a job: $inJob; a restricted token: $([WsTok]::IsTokenRestricted($t))\" } catch { \"token facts: $($_.Exception.Message)\" }",
        "$me = [Security.Principal.WindowsIdentity]::GetCurrent(); \"user: $($me.Name) $($me.User.Value); impersonation: $($me.ImpersonationLevel)\"",
        "whoami /groups /fo csv /nh | ForEach-Object { $f = $_ -split '\",\"'; ($f[0] -replace '\"','') + ' [' + (($f[3] -replace '\"','') -replace ',\\s*', '|') + ']' }",
        "whoami /priv /fo csv /nh | ForEach-Object { ($_ -split '\",\"')[0] -replace '\"','' }",
      ].join("; "), timeout: 120_000 });
      console.log(`[e2e] TOKEN (the pool account under the launcher): ${facts.text.replace(/\r?\n/g, " ; ").slice(0, 3000)}`);
      const sid = /S-1-5-21-[\d-]+/.exec(facts.text)?.[0];
      if (sid !== undefined) {
        const inf = join(tmpdir(), `ws11-rights-${process.pid}.inf`);
        Bun.spawnSync(["secedit", "/export", "/cfg", inf, "/areas", "USER_RIGHTS", "/quiet"], { stdin: "ignore", timeout: 120_000 });
        let rights: string[] = [];
        try { rights = readFileSync(inf, "utf16le").split(/\r?\n/).filter((l) => l.includes(sid)).map((l) => l.split("=")[0]!.trim()); } catch { rights = ["(the local policy couldn't be read)"]; }
        rmSync(inf, { force: true });
        console.log(`[e2e] TOKEN logon rights naming the pool account ${sid}: ${rights.length === 0 ? "none by its own SID (it holds what its groups hold)" : rights.join(", ")}`);
      }
    } finally {
      pk("stop"); pk("filter", "remove");
    }
  }, 900_000);

  test("a share back to this computer (lane WS8, the reviewer's finding): whether Windows opens it for this user, and both file tools refuse it", () => {
    let opened = false;
    try { opened = readFileSync("\\\\localhost\\C$\\Windows\\win.ini").length >= 0; } catch { opened = false; }
    const elevated = Bun.spawnSync(["net", "session"]).exitCode === 0;
    console.log(`[e2e] UNC loopback: \\\\localhost\\C$\\Windows\\win.ini opened for this user (elevated ${elevated}): ${opened}`);
    const bot = botFileFence(fence, moss, "windows", home)({ caller: CALLER } as never);
    const agentFence = { denyRead: [moss, ...secretReadPlaces("windows", home).map((p) => p.path)], denyWrite: [moss] };
    const user = home.slice(3); // `Users\<name>`
    for (const path of [`\\\\localhost\\C$\\${user}\\.ssh\\id_e2e`, `\\\\127.0.0.1\\C$\\${user}\\.moss-e2e\\run\\token`, `//LOCALHOST/c$/${user.replace(/\\/g, "/")}/.ssh/id_e2e`, `\\\\?\\UNC\\localhost\\C$\\Windows\\win.ini`]) {
      const agentWhy = fileToolRefusal({ tool_name: "Read", tool_input: { file_path: path } }, agentFence, scratch);
      const botWhy = fileToolFenceRefusal("Read", { file_path: path }, bot, scratch);
      console.log(`[e2e] UNC Read ${path}: agent refused ${agentWhy !== undefined}; bot refused ${botWhy !== undefined}`);
      expect([path, agentWhy !== undefined, botWhy !== undefined]).toEqual([path, true, true]);
    }
  });

  test("MOSS's coding agent on Windows (lane WS8): its command runs in its root, never reads the MOSS home or a secret, never leaves the sandbox, and runs beside a bot's", async () => {
    const project = join(home, "ws8-agent-project");
    rmSync(project, { recursive: true, force: true });
    mkdirSync(project, { recursive: true });
    const fwd = (p: string) => p.replace(/\\/g, "/");
    const agent = { kind: "session", sessionId: "e2e-agent", sessionKind: "agent" } as Extract<Caller, { kind: "session" }>;
    // An agent's sandbox as its backend draws it: written in its root, the MOSS home denied whole, the secret places too.
    const agentSandbox = () => botSandbox(withSecretReads({ filesystem: { allowWrite: [project], denyWrite: [], denyRead: [moss] } }, { userHome: home, os: "windows" }), { userHome: home, os: "windows" });
    const agentTools = Object.fromEntries(agentShellTools({ spawner: fencedSpawner({ fence }), caller: agent, cwd: () => project, sandbox: agentSandbox, userHome: home, temp: fence.temp, mossHome: moss }).map((t) => [t.name, t]));
    const note = join(moss, "notes", "readme.txt"), secret = join(moss, "secrets.enc"), key = join(home, ".ssh", "id_e2e");
    // The user's control: each is there and readable.
    for (const f of [note, secret, key]) expect(readFileSync(f, "utf8").length).toBeGreaterThan(0);
    const r = await call(agentTools.Bash!, { command: `echo AGENT-RAN > agent.txt; cat '${fwd(note)}' '${fwd(secret)}' '${fwd(key)}' 2>/dev/null; echo done` });
    console.log(`[e2e] agent: wrote in its root ${existsSync(join(project, "agent.txt"))}; read the MOSS home's note ${r.text.includes("a note any bot may read")}; a secret ${r.text.includes("dummy123")}`);
    expect(r.text).toContain("done");
    expect(existsSync(join(project, "agent.txt"))).toBe(true);
    expect(r.text).not.toContain("a note any bot may read");
    expect(r.text).not.toContain("dummy123");
    const ps = await call(agentTools.PowerShell!, { command: `Get-Content -LiteralPath '${secret}' -ErrorAction SilentlyContinue; 'ps-done'` });
    expect(ps.text).toContain("ps-done");
    expect(ps.text).not.toContain("dummy123");
    // No escape (no card), and no background command.
    const esc = await call(agentTools.Bash!, { command: "whoami", dangerouslyDisableSandbox: true }, { refusal: true });
    expect(esc).toMatchObject({ isError: true });
    const bg = await call(agentTools.Bash!, { command: "sleep 1", run_in_background: true }, { refusal: true });
    expect(bg.isError).toBe(true);
    // Beside a bot's command: each alone, then both at once. Under rule 3b they would wait for each other if a bot root
    // granted for the first time lay under the agent's MOSS-home deny; rule 3c denies the roots granted before by name.
    const timed = async (f: () => Promise<unknown>) => { const t0 = Date.now(); await f(); return Date.now() - t0; };
    const alone = await timed(() => call(agentTools.Bash!, { command: "sleep 3; echo A" })) + await timed(() => call(tools.Bash!, { command: "sleep 3; echo B" }));
    let a = "", b = "";
    const both = await timed(async () => { const [x, y] = await Promise.all([call(agentTools.Bash!, { command: "sleep 3; echo A" }), call(tools.Bash!, { command: "sleep 3; echo B" })]); a = x.text; b = y.text; });
    console.log(`[e2e] agent beside a bot: one after the other ${alone} ms, together ${both} ms`);
    expect(a).toMatch(/^A$/m);
    expect(b).toMatch(/^B$/m);
    rmSync(project, { recursive: true, force: true });
  }, 900_000);

  test("rule 8c (lane WS8): a new conversation's sidecar made while a background command runs is stamped for it, and it runs on; a new protected root ends it", async () => {
    wakes.length = 0;
    // The sidecar and, as the control, the transcript beside it (a bot reads transcripts): made after the command started.
    const sidecar = join(moss, "projects", "e2e-project", "s9.provider-state.jsonl");
    const transcript = join(moss, "projects", "e2e-project", "s9.jsonl");
    for (const f of [sidecar, transcript]) rmSync(f, { force: true });
    const fwd = (p: string) => p.replace(/\\/g, "/");
    const r = await call(bgTools.Bash!, {
      command: `for i in $(seq 1 40); do a=shut; b=no; cat '${fwd(sidecar)}' >/dev/null 2>&1 && a=read; cat '${fwd(transcript)}' >/dev/null 2>&1 && b=ok; echo "tick-$i $a $b"; sleep 1; done; echo all-done`,
      run_in_background: true,
    });
    const id = /win_bg_[0-9a-f]{8}/.exec(r.text)![0];
    const log = /written to (\S+\.log)/.exec(r.text)![1]!;
    const logText = () => { try { return readFileSync(log, "utf8"); } catch { return ""; } };
    for (let i = 0; i < 600 && !logText().includes("tick-3 "); i++) await Bun.sleep(100);
    writeFileSync(sidecar, `${SECRET}\n`);
    writeFileSync(transcript, "{}\n");
    for (let i = 0; i < 1200 && !wakes.some((w) => w.task === id); i++) await Bun.sleep(100);
    const end = wakes.find((w) => w.task === id);
    const lines = logText().split(/\r?\n/).filter((l) => /^tick-\d+ /.test(l));
    console.log(`[e2e] rule 8c sidecar: told ${JSON.stringify(end?.status)}; ticks ${lines.length}; the sidecar read on ${lines.filter((l) => l.includes(" read ")).length} tick(s) (before its stamp); the last ten: ${lines.slice(-10).map((l) => l.split(" ").slice(1).join("/")).join(",")}`);
    // It ran to its end (not ended), and from its stamp on the sidecar is shut to it while the transcript beside it reads.
    expect(end).toMatchObject({ status: "completed" });
    expect(lines.length).toBe(40);
    expect(lines.slice(-10).every((l) => l.endsWith(" shut ok"))).toBe(true);
    for (const f of [sidecar, transcript]) rmSync(f, { force: true });
    // A new protected root (a place the profile grant must now exclude): the command is ended, told why.
    const root = profileExcludeCandidates(fence).find((p) => !existsSync(p));
    expect(root).toBeDefined();
    const r2 = await call(bgTools.Bash!, { command: "for i in $(seq 1 120); do echo tick-$i; sleep 1; done; echo all-done", run_in_background: true });
    const id2 = /win_bg_[0-9a-f]{8}/.exec(r2.text)![0];
    const log2 = /written to (\S+\.log)/.exec(r2.text)![1]!;
    for (let i = 0; i < 600 && !(() => { try { return readFileSync(log2, "utf8"); } catch { return ""; } })().includes("tick-2"); i++) await Bun.sleep(100);
    mkdirSync(root!, { recursive: true });
    for (let i = 0; i < 1200 && !wakes.some((w) => w.task === id2); i++) await Bun.sleep(100);
    const end2 = wakes.find((w) => w.task === id2);
    console.log(`[e2e] rule 8c new root ${root}: told ${JSON.stringify(end2?.status)}: ${(end2?.text ?? "").slice(0, 160)}`);
    expect(end2).toMatchObject({ status: "stopped" });
    expect(end2!.text).toContain("something the sandbox protects appeared");
    rmSync(root!, { recursive: true, force: true });
  }, 900_000);

  test("a background command (rule B): answers at once, logs as it goes, tells its end; TaskStop ends it and its account's processes", async () => {
    const poolProcs = () => Bun.spawnSync(["powershell", "-NoProfile", "-NonInteractive", "-Command",
      "@(Get-Process -IncludeUserName -ErrorAction SilentlyContinue | Where-Object { $_.UserName -like '*\\moss-sb-*' }).Count"], { stdout: "pipe" }).stdout.toString().trim();
    wakes.length = 0;
    const started = Date.now();
    // The command goes for its own log first (the daemon writes it, outside the sandbox): append to every log there,
    // and plant a name in the logs' folder (where a link or junction would go). Neither may land.
    const logs = join(moss, "logs", "background").replace(/\\/g, "/");
    const planted = join(moss, "logs", "background", "planted");
    rmSync(planted, { force: true });
    const r = await call(bgTools.Bash!, {
      command: `sleep 1; for f in '${logs}'/*/*.log; do echo INJECTED >> "$f"; done 2>/dev/null; touch '${logs}/planted' 2>/dev/null && echo PLANTED; for i in 1 2 3; do echo tick-$i; sleep 2; done; echo all-done`,
      run_in_background: true,
    });
    const answered = Date.now() - started;
    expect(r.isError).toBe(false);
    const id = /win_bg_[0-9a-f]{8}/.exec(r.text)![0];
    const log = /written to (\S+\.log)/.exec(r.text)![1]!;
    expect(log).toBe(join(moss, "logs", "background", CALLER.sessionId, `${id}.log`));
    let midway = "";
    for (let i = 0; i < 600 && !midway.includes("tick-1"); i++) { await Bun.sleep(100); try { midway = readFileSync(log, "utf8"); } catch { /* not yet */ } }
    const sawEnd = () => wakes.some((w) => w.task === id);
    console.log(`[e2e] background: answered in ${answered} ms; log while running: ${JSON.stringify(midway.slice(0, 60))}; ended already: ${sawEnd()}`);
    expect(midway).toContain("tick-1");
    for (let i = 0; i < 1200 && !sawEnd(); i++) await Bun.sleep(100);
    const end = wakes.find((w) => w.task === id);
    expect(end).toMatchObject({ status: "completed" });
    const whole = readFileSync(log, "utf8");
    console.log(`[e2e] background: the command's own log written by it: ${whole.includes("INJECTED")}; a name planted beside the logs: ${existsSync(planted) || whole.includes("PLANTED")}`);
    expect(whole).toContain("all-done");
    // Rule 8c's cost: one look at what a bot's background command's watch covers (it looks every 30 s while it runs).
    const denyRead = planFromSettings(sandboxFor()).denyRead;
    const t0 = performance.now();
    const watched = watchedReadDenies(denyRead);
    console.log(`[e2e] rule 8c watch: ${denyRead.length} read denies, ${watched.length} there now, one look ${(performance.now() - t0).toFixed(1)} ms`);
    expect(whole).not.toContain("INJECTED");
    expect(whole).not.toContain("PLANTED");
    expect(existsSync(planted)).toBe(false);
    // A long one: its account runs it (the lease is held) until TaskStop's stop ends it, with what it started: a child
    // that would write `late-bg.txt` 10 s on never does. (The pool's processes are counted too, but only an
    // administrator sees their owners: the standard user's run reads 0 there, so the marker is the proof.)
    const began = join(scratch, "began-bg.txt"), late = join(scratch, "late-bg.txt");
    for (const f of [began, late]) rmSync(f, { force: true });
    const long = await call(bgTools.Bash!, { command: "echo began > began-bg.txt; (sleep 10; echo late > late-bg.txt) & sleep 600; echo never", run_in_background: true });
    const lid = /win_bg_[0-9a-f]{8}/.exec(long.text)![0];
    for (let i = 0; i < 240 && !existsSync(began); i++) await Bun.sleep(500);
    const running = poolProcs();
    const stopped = await stopWindowsBackground(CALLER.sessionId, lid);
    await Bun.sleep(15_000);
    const after = poolProcs();
    console.log(`[e2e] background stop: it began: ${existsSync(began)}; the child's late write after the stop: ${existsSync(late)}; pool processes seen while it ran ${running}, after the stop ${after}; told: ${JSON.stringify(wakes.find((w) => w.task === lid)?.status)}`);
    expect(existsSync(began)).toBe(true);
    expect(stopped?.isError).toBe(false);
    expect(wakes.find((w) => w.task === lid)).toMatchObject({ status: "stopped" });
    expect(existsSync(late)).toBe(false);
    expect(after).toBe("0");
    expect(readFileSync(/written to (\S+\.log)/.exec(long.text)![1]!, "utf8")).not.toContain("never");
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
