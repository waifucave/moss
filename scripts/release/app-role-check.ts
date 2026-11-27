// The app role on an installed Linux or Windows build, through the engine's DEFAULT caller check (lane XC; the controller's
// ask before xc-app-role merges): no test seam and no injected `appPeer`, the release engine as installed. On a disposable
// CI runner only (a person's computer is never a target): the installed engine on a home of this run's own, then each
// installed app started on that home, and the engine's own log must say it took the app's connection (with which branch
// of the image check: "verified image" for a root-owned package install, "unverified image" for a user-writable one), and
// its host must say `host.ready`. And the negative: a script holding the home's app token is refused the app role.
//
//   bun scripts/release/app-role-check.ts --core <installed moss-core> --app <installed app exe> [--app …] --expect verified|unverified
//
// Linux runs it under xvfb-run and scripts/with-private-secret-service.sh (the apps draw windows; the engine's secrets go
// to a private keyring). The engine's keychain service is a throwaway one of this run's.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hello } from "../acceptance/client";
import { coreEndpoint, killTree } from "../acceptance/win";
import { MOSS_PROTOCOL_VERSION } from "../../packages/protocol/src/index";

function arg(name: string): string[] {
  const out: string[] = [];
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i] === name && a[i + 1] !== undefined) out.push(a[++i]!);
  return out;
}

const core = arg("--core")[0];
const apps = arg("--app");
const expect = arg("--expect")[0];
if (core === undefined || apps.length === 0 || (expect !== "verified" && expect !== "unverified")) {
  console.log("usage: bun scripts/release/app-role-check.ts --core <moss-core> --app <exe> [--app <exe>] --expect verified|unverified");
  process.exit(2);
}

const home = realpathSync.native(mkdtempSync(join(tmpdir(), "moss-app-role-check-")));
const env: Record<string, string> = {
  ...(process.env as Record<string, string>), MOSS_HOME: home, MOSS_KEYCHAIN_SERVICE: `moss-app-role-check-${process.pid}`,
};
const started: ChildProcess[] = [];
const log = () => { try { return readFileSync(join(home, "logs", "daemon.log"), "utf8"); } catch { return ""; } };
/** What each started process printed, and how it ended (said when a step fails). */
const output = new Map<string, { text: string; exit?: string }>();
const watch = (name: string, p: ChildProcess) => {
  const o = { text: "" } as { text: string; exit?: string };
  output.set(name, o);
  const add = (b: Buffer) => { o.text = (o.text + b.toString()).slice(-20_000); };
  p.stdout?.on("data", add);
  p.stderr?.on("data", add);
  p.on("exit", (code, signal) => { o.exit = `exited ${code ?? signal}`; });
  p.on("error", (e) => { o.exit = `didn't start: ${e.message}`; });
};
const said = () => [...output].map(([n, o]) => `--- ${n} (${o.exit ?? "running"}) ---\n${o.text.split("\n").slice(-40).join("\n")}`).join("\n");
const say = (s: string) => console.log(`app-role-check: ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, ms: number, f: () => T | undefined | Promise<T | undefined>): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`${what}: not within ${ms} ms\n--- the engine's log (last 60 lines) ---\n${log().split("\n").slice(-60).join("\n")}\n${said()}`);
    await sleep(500);
  }
}
const stop = (p: ChildProcess) => {
  if (p.pid === undefined || p.exitCode !== null) return;
  if (process.platform === "win32") killTree(p.pid);
  else { try { process.kill(-p.pid, "SIGKILL"); } catch { try { p.kill("SIGKILL"); } catch { /* gone */ } } }
};

let failed = false;
try {
  const engine = spawn(core, ["daemon", "run"], { env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  started.push(engine);
  watch("the engine", engine);
  const token = await until("the engine's app token", 120_000, () => (existsSync(join(home, "run", "app.token")) ? readFileSync(join(home, "run", "app.token"), "utf8").trim() : undefined));
  say(`the installed engine (${core}) is up on its own home`);

  // The negative: this script (Bun) holds the token and says hello as the app.
  const refused = await hello(coreEndpoint(home), "app", token, "app-role-check", MOSS_PROTOCOL_VERSION).then((d) => { d.client.close(); return undefined; }, (e: unknown) => (e instanceof Error ? e.message : String(e)));
  if (refused === undefined) throw new Error("a script holding the app token was given the app role");
  say(`a script holding the app token is refused the app role: ${refused.slice(0, 160)}`);

  for (const app of apps) {
    const before = log().length;
    const p = spawn(app, [], { env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    started.push(p);
    watch(app, p);
    const line = await until(`${app}: the engine taking its app connection`, 180_000, () => {
      const fresh = log().slice(before);
      const refusedLine = /\[moss\] an app connection was refused: .*/.exec(fresh)?.[0];
      if (refusedLine !== undefined) throw new Error(`${app} was refused the app role: ${refusedLine}`);
      return /\[moss\] app connection from .*/.exec(fresh)?.[0];
    });
    say(line);
    const branch = line.includes("verified image (root-owned install)") ? "verified" : line.includes("unverified image") ? "unverified" : "other";
    if (branch !== expect) throw new Error(`${app}: the image check took the ${branch} branch, expected ${expect}`);
    say(`${app}: the app role, by the "${branch}" branch`);
  }
  const ready = await until("the host's host.ready", 180_000, () => /\[host\] ready: .*/.exec(log())?.[0]);
  say(`the host said host.ready: ${ready}`);
} catch (e) {
  failed = true;
  const message = e instanceof Error ? e.message : String(e);
  console.log(`app-role-check: FAILED: ${message}`);
  if (!message.includes("--- the engine (")) console.log(said());
} finally {
  // The engine first (it ends the host it started), then what is left.
  spawnSync(core, ["autostart", "stop"], { env, stdio: "ignore", timeout: 30_000, windowsHide: true });
  for (const p of started.reverse()) stop(p);
  await sleep(1_000);
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
process.exitCode = failed ? 1 : 0;
