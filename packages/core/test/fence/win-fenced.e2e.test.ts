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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller } from "@waifucave/moss-protocol";
import { MossFence } from "../../src/fence/fence";
import { fencedSpawner } from "../../src/fence/fenced-process";
import { botSandboxSettings } from "../../src/fence/sandbox-settings";
import { botSandbox, withBotKeyReads, withSecretReads } from "../../src/runtime-sdk/turn-loop/driver";
import { windowsShellTools } from "../../src/fence/win-shell-tools";
import { fencedExecutor } from "../../src/computers/fenced-executor";
import { resolveEndpoint } from "../../src/platform/transport";
import { currentUserSid, lockPipeDacl } from "../../src/platform/win-pipe";
import type { CoreToolDef } from "../../src/runtime-sdk/turn-loop/servers";

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
    fence = new MossFence({ home, mossHome: moss });
    const spawner = fencedSpawner({ fence });
    const mk = (kind: "bot" | "side-thread") => Object.fromEntries(windowsShellTools({
      spawner, caller: CALLER, kind, cwd: () => scratch, sandbox: sandboxFor, userHome: home, temp: fence.temp, mossHome: moss,
    }).map((t) => [t.name, t]));
    tools = mk("bot");
    sideTools = mk("side-thread");
  });
  afterAll(() => { for (const d of [moss, join(home, "ws-e2e-plain"), join(home, "ws-escape-dir")]) rmSync(d, { recursive: true, force: true }); });

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
    const r = await call(tools.PowerShell!, { command: "schtasks /create /tn moss-e2e-planted /tr 'cmd /c echo planted' /sc onlogon /f 2>&1; 'exit=' + $LASTEXITCODE" });
    const made = Bun.spawnSync(["schtasks", "/query", "/tn", "moss-e2e-planted"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
    console.log(`[e2e] schtasks /create as the account: ${r.text.trim().slice(0, 200)}; task exists: ${made}`);
    if (made) Bun.spawnSync(["schtasks", "/delete", "/tn", "moss-e2e-planted", "/f"]);
    expect(made).toBe(false);
    expect(r.text).not.toContain("exit=0");
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

  test("a stop reaches the command: it ends at once, with what it started, never waiting for its time limit", async () => {
    const marker = join(scratch, "late-abort.txt");
    rmSync(marker, { force: true });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 4_000);
    const started = Date.now();
    const r = await call(tools.Bash!, { command: "(sleep 10; echo late > late-abort.txt) & sleep 300", timeout: 600_000 }, { signal: ac.signal });
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

  test("the escape: a bot's own conversation's approved command writes the home, never MOSS's settings, and has no network", async () => {
    mkdirSync(join(home, "ws-escape-dir"), { recursive: true });
    const target = join(home, "ws-escape-dir", "x.txt");
    rmSync(target, { force: true });
    const e = await call(tools.Bash!, { command: `echo escaped > '${target.replace(/\\/g, "/")}'`, dangerouslyDisableSandbox: true });
    expect(e.isError).toBe(false);
    expect(readFileSync(target, "utf8").trim()).toBe("escaped");
    const before = readFileSync(join(moss, "settings.json"), "utf8");
    const s = await call(tools.Bash!, { command: `echo x > '${join(moss, "settings.json").replace(/\\/g, "/")}'`, dangerouslyDisableSandbox: true });
    expect(s.isError).toBe(true);
    expect(readFileSync(join(moss, "settings.json"), "utf8")).toBe(before);
    const n = await call(tools.Bash!, { command: "timeout 8 bash -c 'exec 3<>/dev/tcp/1.1.1.1/443' && echo CONNECTED || echo REFUSED", dangerouslyDisableSandbox: true });
    expect(n.text).toContain("REFUSED");
    // A side thread's command never leaves the sandbox, whatever it asks.
    const side = await call(sideTools.Bash!, { command: "echo hi", dangerouslyDisableSandbox: true }, { refusal: true });
    expect(side.isError).toBe(true);
    expect(side.text).toContain("never leave the sandbox");
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
});
