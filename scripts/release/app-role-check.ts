// The app role on an installed Linux or Windows build, through the engine's DEFAULT caller check (lane XC; the controller's
// ask before xc-app-role merges): no test seam and no injected `appPeer`, the release engine as installed. On a disposable
// CI runner only (a person's computer is never a target): the installed engine on a home of this run's own, then each
// installed app started on that home, and the engine's own log must say it took the app's connection (with which branch
// of the image check: "verified image" for a root-owned package install, "unverified image" for a user-writable one), and
// its host must say `host.ready`. And the negative: a script holding the home's app token is refused the app role.
//
//   bun scripts/release/app-role-check.ts --core <installed moss-core> --app <installed app exe> [--app …] [--host <installed host exe> | --engine-starts-host] --expect verified|unverified
//
// Linux runs it under xvfb-run and scripts/with-private-secret-service.sh (the apps draw windows; the engine's secrets go
// to a private keyring). The engine keeps its own keychain service (a release refuses a test's).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { hello } from "../acceptance/client";
import { coreEndpoint, killTree } from "../acceptance/win";
import { MOSS_PROTOCOL_VERSION } from "../../packages/protocol/src/index";
import { USAGE_INERT_ENV } from "../../packages/core/src/usage/wiring";

function arg(name: string): string[] {
  const out: string[] = [];
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) if (a[i] === name && a[i + 1] !== undefined) out.push(a[++i]!);
  return out;
}

const core = arg("--core")[0];
const apps = arg("--app");
const expect = arg("--expect")[0];
// How the host starts. `--engine-starts-host` (Windows): the real path. The engine starts the host through its task
// `\MOSS\moss-host` (packages/core/src/host/world.ts), which the login manager writes on `moss-core autostart enable`
// from the apps' records (lane MQ's mq-12, platform/login/host-exe.ts). `autostart` serves only the profile's DEFAULT
// home, and the task starts the host with no environment of its own (so on the default home), so this mode runs on the
// runner's default home: only under GitHub Actions, and only when that home doesn't exist yet. The apps connect (the
// engine writes their records), `autostart enable` writes the task, the engine's next start of the host goes through
// it (its starts retry for about two minutes), and the host's connection must pass the same default check.
// `--host <exe>` (Linux): the stand-in. The engine starts the host there through `systemctl --user start
// moss-host.service`, which needs a user systemd manager with a graphical session in its environment (world.ts reads
// DISPLAY or WAYLAND_DISPLAY from `systemctl --user show-environment`); the packages job's runner has no user manager
// for the runner account and its display is xvfb-run's, outside any systemd session. So this script plays the unit: it
// starts the installed host itself, outside the engine's tree, as `<exe> --moss-program=host` on the same home, and
// its connection goes through the same default check.
const host = arg("--host")[0];
const engineStartsHost = process.argv.includes("--engine-starts-host");
if (core === undefined || apps.length === 0 || (expect !== "verified" && expect !== "unverified") || (engineStartsHost && host !== undefined)) {
  console.log("usage: bun scripts/release/app-role-check.ts --core <moss-core> --app <exe> [--app <exe>] [--host <exe> | --engine-starts-host] --expect verified|unverified");
  process.exit(2);
}
const defaultHome = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".moss");
if (engineStartsHost && (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "win32" || existsSync(defaultHome))) {
  console.log(`app-role-check: --engine-starts-host runs only on a fresh Windows GitHub runner (the default home ${defaultHome} must not exist yet)`);
  process.exit(2);
}

const home = engineStartsHost ? (mkdirSync(defaultHome, { recursive: true }), realpathSync.native(defaultHome)) : realpathSync.native(mkdtempSync(join(tmpdir(), "moss-app-role-check-")));
// The release engine as a person runs it: its own keychain service (a release refuses a test's MOSS_KEYCHAIN_SERVICE,
// run 45988405527), on a disposable runner whose keychain is its own (Linux: the private keyring of
// with-private-secret-service.sh; Windows: the runner's Credential Manager, gone with the runner).
const { MOSS_KEYCHAIN_SERVICE: _test, MOSS_HOME: _home, ...inherited } = process.env as Record<string, string>;
// Usage-inert as every daemon outside the tests (test/usage/script-daemons.test.ts): no usage source of the runner's is read.
// On the default home no MOSS_HOME is set (the apps, the engine, `autostart` and the host's task all resolve it alike).
const env: Record<string, string> = { ...inherited, ...USAGE_INERT_ENV, ...(engineStartsHost ? {} : { MOSS_HOME: home }) };
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
  if (host !== undefined) {
    const before = log().length;
    const p = spawn(host, ["--moss-program=host"], { env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    started.push(p);
    watch(`${host} (the host)`, p);
    say(`started the installed host as its task would: ${host} --moss-program=host`);
    const line = await until(`${host}: the engine taking the host's connection`, 180_000, () => {
      const fresh = log().slice(before);
      const refusedLine = /\[moss\] an app connection was refused: .*/.exec(fresh)?.[0];
      if (refusedLine !== undefined) throw new Error(`the host was refused: ${refusedLine}`);
      // Its own line (an app's reconnect meanwhile says its own path).
      return fresh.split("\n").find((l) => l.includes("[moss] app connection from ") && l.includes(basename(host)));
    });
    say(line);
  }
  if (engineStartsHost) {
    // The apps' records are the engine's now; the login manager writes the host's task from them.
    const before = log().length;
    const en = spawnSync(core, ["autostart", "enable"], { env, encoding: "utf8", timeout: 120_000, windowsHide: true });
    say(`moss-core autostart enable: exit ${en.status}: ${`${en.stdout ?? ""}${en.stderr ?? ""}`.trim().slice(0, 400)}`);
    if (en.status !== 0) throw new Error("autostart enable failed");
    const query = spawnSync("schtasks", ["/Query", "/TN", "\\MOSS\\moss-host", "/XML"], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    const command = /<Command>([^<]*)<\/Command>/.exec(query.stdout ?? "")?.[1];
    say(`the host's task: ${query.status === 0 ? `runs ${command ?? "(no command)"}` : `not there (${(query.stderr ?? "").trim().slice(0, 200)})`}`);
    if (query.status !== 0 || command === undefined) throw new Error("autostart enable wrote no host task");
    // The engine's next start goes through the task (nothing here starts the host); its connection is checked like any
    // app's, and only a host connection the check took can say host.ready (below).
    const ready = await until("the host started by the engine through its task saying host.ready", 180_000, () => {
      const fresh = log().slice(before);
      const refusedLine = /\[moss\] an app connection was refused: .*/.exec(fresh)?.[0];
      if (refusedLine !== undefined) throw new Error(`a connection was refused: ${refusedLine}`);
      return /\[host\] ready: .*/.exec(fresh)?.[0];
    });
    const startLine = log().slice(before).split("\n").find((l) => l.includes("[host] starting the host from"));
    say(`the engine: ${startLine?.replace(/^.*?\[host\]/, "[host]") ?? "(no start line)"}`);
    if (startLine === undefined) throw new Error("host.ready came without the engine starting the host");
    say(`the host said host.ready: ${ready}`);
  }
  if (!engineStartsHost) {
    const ready = await until("the host's host.ready", 180_000, () => /\[host\] ready: .*/.exec(log())?.[0]);
    say(`the host said host.ready: ${ready}`);
  }
} catch (e) {
  failed = true;
  const message = e instanceof Error ? e.message : String(e);
  console.log(`app-role-check: FAILED: ${message}`);
  if (!message.includes("--- the engine (")) console.log(said());
} finally {
  // The engine first (it ends the host it started), then what is left. On the default home the login entries go too.
  spawnSync(core, ["autostart", engineStartsHost ? "remove" : "stop"], { env, stdio: "ignore", timeout: 60_000, windowsHide: true });
  for (const p of started.reverse()) stop(p);
  await sleep(1_000);
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
process.exitCode = failed ? 1 : 0;
