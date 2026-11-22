// The Windows fence, end to end, for real (lane WS; spec §4, §9.1, §14.1 item 2): a bot's Bash and PowerShell through
// the core's tools (`windowsShellTools`) and the computer node's Bash (`fencedExecutor`), each through the fenced
// spawner's Windows leg, as pool principals the workflow's `moss-core sandbox setup` provisioned, under the settings
// the daemon gives a bot's runtime. Every refusal is asserted against a positive control by the test's own process
// (the user), so a refusal is the fence's and not a missing file or a broken shell.
//
// Runs only on Windows with MOSS_WIN_FENCE_E2E=1 (the windows-fence workflow, after setup, with MOSS_SRT_WIN naming the
// protected copy's launcher). It writes a throwaway MOSS home in the runner's own profile (`.moss-e2e`) and a few
// files beside it, and prints only dummy values (`PROBE_SECRET=dummy123`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const call = async (t: CoreToolDef, input: Record<string, unknown>) => {
  const started = Date.now();
  const r = await t.run(input);
  console.log(`[e2e] ${t.name} ${JSON.stringify(input.command).slice(0, 120)} -> ${r.isError ? "error" : "ok"} in ${Date.now() - started} ms: ${r.text.slice(0, 300).replace(/\s+/g, " ")}`);
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
    writeFileSync(join(home, "ws-plain.txt"), "an ordinary file in the home\n");
    fence = new MossFence({ home, mossHome: moss });
    const spawner = fencedSpawner({ fence });
    const mk = (kind: "bot" | "side-thread") => Object.fromEntries(windowsShellTools({
      spawner, caller: CALLER, kind, cwd: () => scratch, sandbox: sandboxFor, userHome: home, temp: fence.temp, mossHome: moss,
    }).map((t) => [t.name, t]));
    tools = mk("bot");
    sideTools = mk("side-thread");
  });
  afterAll(() => { rmSync(moss, { recursive: true, force: true }); });

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
  }, 300_000);

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
    // The control: a plain note in the MOSS home is read (a bot's open access), and a plain file in the home.
    const note = await call(tools.Bash!, { command: `cat '${join(moss, "notes", "readme.txt").replace(/\\/g, "/")}' '${join(home, "ws-plain.txt").replace(/\\/g, "/")}'` });
    expect(note.text).toContain("a note any bot may read");
    expect(note.text).toContain("an ordinary file in the home");
  }, 300_000);

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
  }, 300_000);

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
  }, 300_000);

  test("a timeout ends everything the command started: a delayed grandchild never writes its marker", async () => {
    const marker = join(scratch, "late.txt");
    rmSync(marker, { force: true });
    const r = await call(tools.Bash!, { command: "(sleep 5; echo late > late.txt) & sleep 60", timeout: 2000 });
    expect(r.isError).toBe(true);
    await Bun.sleep(8000);
    expect(existsSync(marker)).toBe(false);
  }, 300_000);

  test("two commands at once run as two principals (a principal per running command)", async () => {
    const [a, b] = await Promise.all([call(tools.Bash!, { command: "whoami; sleep 3" }), call(tools.Bash!, { command: "whoami; sleep 3" })]);
    expect(a.text).toContain("moss-sb-");
    expect(b.text).toContain("moss-sb-");
    expect(a.text.trim()).not.toBe(b.text.trim());
  }, 300_000);

  test("nothing carries over: what one command leaves in its account's profile and hive is gone before the next", async () => {
    // A command plants in its own account's real profile (by absolute path, past its per-command HOME) and in its
    // hive (HKCU\\Environment, which a later logon would load into a command's environment).
    const plant = await call(tools.PowerShell!, { command: [
      "$p = [Environment]::GetFolderPath('UserProfile')",
      "Set-Content -LiteralPath (Join-Path $p 'carry.txt') -Value planted",
      "[Environment]::SetEnvironmentVariable('MOSS_CARRY', 'planted', 'User')",
      "'planted in ' + $p + ' as ' + [Environment]::UserName",
    ].join("; ") });
    expect(plant.text).toContain("planted in");
    const who = /as (moss-sb-\S+)/.exec(plant.text)?.[1];
    // Every later command, whichever account it gets, sees neither (the reset deleted the profile and its hive).
    for (let i = 0; i < 3; i++) {
      const look = await call(tools.PowerShell!, { command: [
        "$p = [Environment]::GetFolderPath('UserProfile')",
        "'user=' + [Environment]::UserName + ' file=' + (Test-Path -LiteralPath (Join-Path $p 'carry.txt')) + ' env=' + [Environment]::GetEnvironmentVariable('MOSS_CARRY', 'User') + ' process=' + $env:MOSS_CARRY",
      ].join("; ") });
      console.log(`[e2e] after the plant by ${who}: ${look.text.trim()}`);
      expect(look.text).toContain("file=False");
      expect(look.text).not.toContain("planted");
    }
  }, 600_000);

  test("nothing runs later: a risky git key is reverted and a planted hook is moved aside", async () => {
    const r = await call(tools.Bash!, { command: "rm -rf repo && git init -q repo && git -C repo config core.hooksPath /c/elsewhere && printf '#!/bin/sh\\necho planted\\n' > repo/.git/hooks/post-checkout && echo done" });
    expect(r.text).toContain("done");
    const config = readFileSync(join(scratch, "repo", ".git", "config"), "utf8");
    expect(config).not.toContain("hooksPath");
    expect(existsSync(join(scratch, "repo", ".git", "hooks", "post-checkout"))).toBe(false);
  }, 300_000);

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
    const side = await call(sideTools.Bash!, { command: "echo hi", dangerouslyDisableSandbox: true });
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
    expect(readFileSync(join(moss, "settings.json"), "utf8")).toBe(before);
    const read = await exec.run("Bash", { command: `cat '${join(moss, "notes", "readme.txt").replace(/\\/g, "/")}'` }, ctx);
    expect(JSON.stringify(read.output)).not.toContain("a note any bot may read"); // the MOSS home is default-deny for a coding session
  }, 300_000);
});
