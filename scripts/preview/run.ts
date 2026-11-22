// The live preview: MOSS Code from source in ONE visible window, on a throwaway home with sample sessions, reloaded when the look's
// source changes. Nothing is installed; the person's apps, home, keychain, login item and update feed are never touched.
//
//   scripts/pinned-bun scripts/preview/run.ts                       start it (watching)
//   scripts/pinned-bun scripts/preview/run.ts --once                start it, no watching
//   scripts/pinned-bun scripts/preview/run.ts --stop                end a running preview
//   scripts/pinned-bun scripts/preview/run.ts --headless --shot <png> [--appearance light|dark]
//                                                                   offscreen: one picture of the window, then end
//
// It starts what the acceptance run starts from source (scripts/acceptance/daemon.ts as the engine, the fake model, apps/desktop built
// with `--preview`), on a temp home and the throwaway test keychain, and ends all of it, by the pids it started, when the window closes.
// scripts/preview/lib.ts holds each isolation rule (the environments, the PATH, the folders, what --stop may end) and scripts/preview/lib.test.ts checks it.
import { refusal } from "./lib";
// The first statement of the command: no folder, no process and no state exists before it (the imports below are modules that only define things).
{
  const why = refusal(process.env);
  if (why !== undefined) {
    process.stderr.write(`preview: not starting: ${why}\n`);
    process.exit(2);
  }
}
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, watch, writeFileSync, chmodSync, type FSWatcher } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MOSS_PROTOCOL_VERSION } from "../../packages/protocol/src/index";
import { TEST_KEYCHAIN_PASSWORD } from "../../packages/core/src/auth/login-keychain";
import { USAGE_INERT_ENV } from "../../packages/core/src/usage/wiring";
import { hello, MossClient } from "../acceptance/client";
import { Cdp } from "../acceptance/cdp";
import { startFakeAnthropic, type FakeProvider } from "../acceptance/fake-anthropic";
import { settingsWithFake, socketPathProblem } from "../acceptance/state";
import { listProcesses, nameLeftovers, reap, runProcesses } from "../acceptance/reaper";
import { AGENT_SHIMS, PREVIEW_PREFIX, USAGE, UsageError, WATCHED, appArgs, appEnv, baseEnv, daemonEnv, isolationProblems, layoutFor, ownRoot, parseOptions, parseRecord, reloads, sameProcess, shimScript, type Options, type Record_, type Started } from "./lib";
import { quirksOf, seed, titleFor } from "./seed";

const REPO = resolve(import.meta.dir, "..", "..");
const DESKTOP = join(REPO, "apps", "desktop");
const FAKE_ACP_AGENT = join(REPO, "packages", "core", "src", "agents", "testing", "fake-acp-agent.ts");
/** Where the one record lives (fixed, outside any run's own folder): the preview's pid, its start time, and every process and folder it made. */
const STATE_DIR = join(tmpdir(), "moss-preview-state");
const RECORD = join(STATE_DIR, "running.json");
/** How long a held turn keeps running on the fake provider: longer than anyone looks at the preview. */
const HOLD_MS = 12 * 60 * 60 * 1000;

const say = (line: string): void => { process.stderr.write(`preview: ${line}\n`); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A process's start time as `ps` prints it: with its pid, what tells a process from a later one that reused the pid. */
function startOf(pid: number): string | undefined {
  try { return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 }).trim() || undefined; } catch { return undefined; }
}
const aliveAs = (p: { pid: number; start: string }): boolean => sameProcess(p.start, startOf(p.pid));

// ── the record ───────────────────────────────────────────────────────────────────────────────────────────────────────
function writeRecord(r: Record_): void {
  const tmp = `${RECORD}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(r), { mode: 0o600 });
  renameSync(tmp, RECORD);
}
function readRecord(): Record_ | undefined {
  try { return parseRecord(readFileSync(RECORD, "utf8")); } catch { return undefined; }
}

/** Ends what a record names: each recorded process that is still the same process (pid and start time), then its folder (only one of this command's own). */
async function endRecorded(r: Record_, why: string): Promise<void> {
  for (const c of [...r.children].reverse()) {
    if (!aliveAs(c)) continue;
    say(`${why}: ending ${c.what} (pid ${c.pid})`);
    for (const sig of ["SIGTERM", "SIGKILL"] as const) {
      try { process.kill(-c.pid, sig); } catch { try { process.kill(c.pid, sig); } catch { /* gone */ } }
      for (let i = 0; i < 20 && aliveAs(c); i++) await sleep(250);
      if (!aliveAs(c)) break;
    }
  }
  removeRoot(r.root);
}
function removeRoot(root: string): void {
  if (root === "") return;
  if (!ownRoot(root, tmpdir())) { say(`not removing ${root}: it is not one of this command's own folders (${PREVIEW_PREFIX}… directly under ${tmpdir()})`); return; }
  try { if (lstatSync(root).isSymbolicLink()) { say(`not removing ${root}: it is a link`); return; } } catch { return; }
  spawnSync("security", ["delete-keychain", join(root, "kc", "preview.keychain-db")], { stdio: "ignore" });
  rmSync(root, { recursive: true, force: true });
}

/** Takes the one place a preview runs from (an exclusive create), or says one runs and exits. A record whose process is gone is an unclean end: named, cleaned up exactly, and the start goes on. */
async function claim(): Promise<Record_> {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const mine: Record_ = { v: 1, pid: process.pid, start: startOf(process.pid) ?? "", root: "", at: Date.now(), children: [] };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(RECORD, "wx", 0o600);
      writeFileSync(fd, JSON.stringify(mine));
      closeSync(fd);
      return mine;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const other = readRecord();
    if (other !== undefined && aliveAs(other)) {
      say(`a preview is already running (pid ${other.pid}, started ${new Date(other.at).toISOString()}, folder ${other.root || "not made yet"}). End it with: scripts/pinned-bun scripts/preview/run.ts --stop`);
      process.exit(1);
    }
    if (other === undefined) say(`${RECORD} is not a record of this command's: removing it`);
    else {
      const left = other.children.filter(aliveAs);
      say(`an earlier preview (pid ${other.pid}) ended uncleanly: ${left.length > 0 ? `still running of it: ${left.map((c) => `${c.what} pid ${c.pid}`).join(", ")}; ` : ""}its folder ${other.root || "(none)"} is removed exactly`);
      await endRecorded(other, "leftover");
    }
    rmSync(RECORD, { force: true });
  }
  throw new Error(`could not take ${RECORD}`);
}

// ── --stop ───────────────────────────────────────────────────────────────────────────────────────────────────────────
async function stop(): Promise<number> {
  const r = readRecord();
  if (r === undefined) { say("no preview is running (no record)"); rmSync(RECORD, { force: true }); return 0; }
  if (aliveAs(r)) {
    say(`ending the preview (pid ${r.pid})`);
    try { process.kill(r.pid, "SIGTERM"); } catch { /* gone */ }
    for (let i = 0; i < 80 && aliveAs(r); i++) await sleep(250);
    if (aliveAs(r)) { say("it did not end in 20 s: ending it and what it started"); try { process.kill(r.pid, "SIGKILL"); } catch { /* gone */ } }
  }
  // Its own end removes what it made; anything still there (an end by force, a crash) is removed by the record.
  const again = readRecord();
  if (again !== undefined) { await endRecorded(again, "stop"); rmSync(RECORD, { force: true }); }
  say("stopped");
  return 0;
}

// ── a start ──────────────────────────────────────────────────────────────────────────────────────────────────────────
const children: { name: string; proc: ChildProcess }[] = [];
let record: Record_;
let fake: FakeProvider | undefined;
let root = "";
let ending = false;
let logsTo: string | undefined;

function note(name: string, proc: ChildProcess): void {
  if (proc.pid === undefined) return;
  children.push({ name, proc });
  record = { ...record, children: [...record.children, { pid: proc.pid, start: startOf(proc.pid) ?? "", what: name } satisfies Started] };
  writeRecord(record);
}

function startChild(name: string, cmd: string, args: string[], env: Record<string, string>, log: string): ChildProcess {
  const fd = openSync(log, "a");
  // Its own group (its pid the group's id): ending the group ends what it started.
  const proc = spawn(cmd, args, { cwd: REPO, env, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  note(name, proc);
  return proc;
}

const alive = (p: ChildProcess): boolean => p.exitCode === null && p.signalCode === null;

async function endChild(p: ChildProcess, graceMs = 8_000): Promise<void> {
  if (p.pid === undefined || !alive(p)) return;
  const gone = new Promise<void>((r) => p.once("exit", () => r()));
  try { process.kill(-p.pid, "SIGTERM"); } catch { /* gone */ }
  const t = setTimeout(() => { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* gone */ } }, graceMs);
  await Promise.race([gone, sleep(graceMs + 2_000)]);
  clearTimeout(t);
  try { process.kill(-p.pid, "SIGKILL"); } catch { /* none */ }
}

/** Ends everything this command started, by the groups and the folder it made: the app, the engine, the fake, the temp folders. Said once, in order. */
async function cleanup(code: number): Promise<never> {
  if (ending) await new Promise(() => undefined);
  ending = true;
  say("ending: the window's app, the engine and the fake, then the temp folders");
  for (const c of [...children].reverse()) await endChild(c.proc);
  try { fake?.close(); } catch { /* gone */ }
  // Anything of this run's still running: in one of its groups or running a program from its folder. Never by a name.
  try {
    const left = await reap({ roots: root === "" ? [] : [root], groups: children.map((c) => c.proc.pid ?? 0), settleMs: 3_000 });
    if (left.leftovers.length > 0) say(`ended ${left.leftovers.length} process(es) left behind: ${nameLeftovers(left.leftovers)}`);
    if (left.survivors.length > 0) say(`STILL RUNNING after SIGKILL: ${nameLeftovers(left.survivors)}`);
  } catch { /* ps unreadable */ }
  if (logsTo !== undefined && root !== "") {
    try {
      mkdirSync(logsTo, { recursive: true });
      for (const [from, name] of [[join(root, "logs"), "run"], [join(root, "user", ".moss", "logs"), "home"], [join(root, "agents"), "agents"]] as const) if (existsSync(from)) cpSync(from, join(logsTo, name), { recursive: true });
    } catch (err) { say(`the logs were not copied: ${err instanceof Error ? err.message : String(err)}`); }
  }
  removeRoot(root);
  if (readRecord()?.pid === process.pid) rmSync(RECORD, { force: true });
  process.exit(code);
}

function makeKeychain(path: string): void {
  const before = spawnSync("security", ["list-keychains", "-d", "user"], { encoding: "utf8" }).stdout?.trim() ?? "";
  // The tests' fixed password (packages/core/src/auth/login-keychain.ts): it guards nothing, the file is this preview's own.
  const made = spawnSync("security", ["create-keychain", "-p", TEST_KEYCHAIN_PASSWORD, path], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`security create-keychain failed: ${(made.stderr ?? "").trim().slice(0, 200)}`);
  spawnSync("security", ["set-keychain-settings", path], { stdio: "ignore" });
  const after = spawnSync("security", ["list-keychains", "-d", "user"], { encoding: "utf8" }).stdout?.trim() ?? "";
  if (after !== before) throw new Error("the keychain search list changed when the throwaway keychain was made");
}

const heavy = join(REPO, "scripts", "heavy");
function build(logFile: string, args: string[], cwd: string): boolean {
  const r = existsSync(heavy)
    ? spawnSync(heavy, [process.execPath, ...args], { cwd, encoding: "utf8", timeout: 900_000 })
    : spawnSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 900_000 });
  writeFileSync(logFile, `${r.stdout ?? ""}${r.stderr ?? ""}`, { flag: "a" });
  return r.status === 0;
}

/** The electron binary of apps/desktop (its install.js fetches it once, or takes it from Electron's cache). */
function electronExe(): string {
  const req = createRequire(join(DESKTOP, "package.json"));
  const pkgDir = dirname(req.resolve("electron/package.json"));
  if (!existsSync(join(pkgDir, "path.txt"))) {
    say("fetching the Electron binary (electron/install.js)");
    const r = spawnSync(process.execPath, [join(pkgDir, "install.js")], { cwd: pkgDir, encoding: "utf8", timeout: 600_000 });
    if (r.status !== 0 || !existsSync(join(pkgDir, "path.txt"))) throw new Error(`electron's install.js failed: ${(r.stderr ?? "").trim().slice(0, 300)}`);
  }
  return join(pkgDir, "dist", readFileSync(join(pkgDir, "path.txt"), "utf8").trim());
}

async function main(o: Options): Promise<void> {
  logsTo = o.logs === undefined ? undefined : resolve(o.logs);
  record = await claim();
  const t0 = Date.now();
  root = mkdtempSync(join(tmpdir(), PREVIEW_PREFIX));
  record = { ...record, root };
  writeRecord(record);
  process.on("SIGINT", () => void cleanup(130));
  process.on("SIGTERM", () => void cleanup(143));
  process.on("uncaughtException", (e) => { say(`failed: ${e instanceof Error ? e.message : String(e)}`); void cleanup(1); });
  const layout = layoutFor(root);
  for (const d of [layout.home, layout.userHome, layout.logs, layout.tmp, join(root, "kc"), layout.bin, layout.agents, layout.work, layout.pluginWorld]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const sockProblem = socketPathProblem(layout.home);
  if (sockProblem !== undefined) throw new Error(sockProblem);
  const service = `com.waifucave.moss.core.test.preview-${randomBytes(4).toString("hex")}`;
  const bunDir = dirname(process.execPath);
  const input = { layout, service, bunDir };
  // The run's own plug for anything that would start the engine through the OS: a program that only says it cannot (the app's `MOSS_DAEMON_BIN`).
  writeFileSync(layout.stubBin, "#!/bin/sh\necho 'preview: the app tried to start an engine through the OS' >&2\nexit 1\n", { mode: 0o700 });
  // The three agents' programs, as shims in the preview's own bin folder, first on its PATH (and nothing of the person's on it).
  for (const s of AGENT_SHIMS) writeFileSync(join(layout.bin, s.command), shimScript({ bun: process.execPath, fake: FAKE_ACP_AGENT, config: join(layout.agents, `${s.backend}.json`) }), { mode: 0o755 });
  for (const s of AGENT_SHIMS) chmodSync(join(layout.bin, s.command), 0o755);
  makeKeychain(layout.keychain);
  say(`folder ${root}`);

  const dummyKey = `sk-ant-preview-dummy-${randomBytes(12).toString("hex")}`;
  const keyedModel = "anthropic/claude-sonnet-5-5";
  fake = startFakeAnthropic({
    key: dummyKey, writePath: join(layout.work, "w.txt"), writeContent: "preview\n", titleFor, slowHoldMs: HOLD_MS,
  });
  writeFileSync(join(layout.home, "settings.json"), settingsWithFake(undefined, fake.url), { mode: 0o600 });

  // The app's isolation, said once for what a reader can check.
  const problems = [
    ...isolationProblems(daemonEnv({ ...input, runPid: process.pid, usageInert: USAGE_INERT_ENV }), layout, process.env.HOME ?? ""),
    ...isolationProblems(appEnv({ ...input, headless: o.headless, appearance: o.appearance }), layout, process.env.HOME ?? ""),
  ];
  if (problems.length > 0) throw new Error(`the preview's environment is not isolated: ${problems.join("; ")}`);

  say("building the dev bundled plugins");
  const bundled = spawnSync(process.execPath, ["-e", `
    const { buildDevBundledPlugins } = await import(${JSON.stringify(join(REPO, "packages/core/src/registry/bundled-stage.ts"))});
    const { readdirSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sources = ${JSON.stringify(join(REPO, "plugins"))};
    const ids = readdirSync(sources).filter((id) => existsSync(join(sources, id, "moss.json"))).sort();
    const built = await buildDevBundledPlugins({ sources, ids, mossHome: ${JSON.stringify(layout.home)} });
    console.log("built " + built.built.join(","));
  `], { cwd: REPO, env: baseEnv(input), encoding: "utf8", timeout: 600_000 });
  writeFileSync(join(layout.logs, "bundled-build.log"), `${bundled.stdout ?? ""}${bundled.stderr ?? ""}`);
  if (bundled.status !== 0) throw new Error(`building the dev bundled plugins failed (${layout.logs}/bundled-build.log)`);

  say("building apps/desktop with --preview");
  const rebuild = (): boolean => build(join(layout.logs, "desktop-build.log"), ["run", "build", "--preview"], DESKTOP);
  if (!rebuild()) throw new Error(`building apps/desktop failed (${layout.logs}/desktop-build.log)`);
  const exe = electronExe();

  say("starting the engine");
  startChild("engine", process.execPath, [join(REPO, "scripts", "acceptance", "daemon.ts")], daemonEnv({ ...input, runPid: process.pid, usageInert: USAGE_INERT_ENV }), join(layout.logs, "engine.log"));
  const engine = children[0]!.proc;
  const sock = join(layout.home, "run", "core.sock");
  const token = join(layout.home, "run", "app.token");
  for (let waited = 0; ; waited += 400) {
    if (!alive(engine)) throw new Error(`the engine exited (${engine.exitCode ?? engine.signalCode}); see ${layout.logs}/engine.log`);
    if (existsSync(sock) && existsSync(token)) { try { (await MossClient.connect(sock, 1_000)).close(); break; } catch { /* not yet */ } }
    if (waited > 120_000) throw new Error("the engine's socket did not come up in 2 minutes");
    await sleep(400);
  }

  say("seeding the sample sessions through the engine's own doors");
  const client = (await hello(sock, "app", readFileSync(token, "utf8").trim(), "moss-preview", MOSS_PROTOCOL_VERSION)).client;
  const seeded = await seed({
    c: client, layout, keyedModel, dummyKey, fakeAcpAgent: FAKE_ACP_AGENT, say,
    quirks: Object.fromEntries(AGENT_SHIMS.map((s) => [s.backend, quirksOf(REPO, s.backend)])),
  });
  say(`seeded: ${seeded.sessions.map((s) => s.what).join("; ")}`);
  // The window's app is not this connection: this one ends, the app dials for itself.
  client.close();

  // The window.
  const port = o.headless ? await freePort() : undefined;
  const app = startChild("app", exe, appArgs({ desktopDir: DESKTOP, headless: o.headless, ...(port !== undefined ? { port } : {}) }), appEnv({ ...input, headless: o.headless, appearance: o.appearance }), join(layout.logs, "app.out.log"));
  say(`${o.headless ? "the app is starting offscreen" : "the window is opening"} (${Math.round((Date.now() - t0) / 1000)} s since the start)`);

  if (o.headless) {
    await shot(port!, o.shot!, app, layout.home);
    await cleanup(0);
  }

  writeFileSync(layout.reloadFile, "0");
  let watcher: (() => void) | undefined;
  if (!o.once) watcher = watching(rebuild, layout.reloadFile);
  say(`the preview is up (${Math.round((Date.now() - t0) / 1000)} s). Close its window to end it, or run: scripts/pinned-bun scripts/preview/run.ts --stop`);
  await new Promise<void>((r) => app.once("exit", () => r()));
  watcher?.();
  say("the window closed");
  await cleanup(0);
}

function freePort(): Promise<number> {
  return new Promise((ok, bad) => {
    const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {}, open() {}, close() {}, error() {} } });
    const port = s.port;
    s.stop(true);
    if (port > 0) ok(port); else bad(new Error("no free port"));
  });
}

/** One picture of the window, offscreen (headless): the root document's pixels once the canvas has drawn its blocks, at a fixed size. */
async function shot(port: number, png: string, app: ChildProcess, home: string): Promise<void> {
  let cdp: Cdp | undefined;
  for (let waited = 0; cdp === undefined; waited += 500) {
    if (!alive(app)) throw new Error(`the app exited before it could be drawn: ${readFileSync(join(home, "logs", "app.log"), "utf8").split("\n").slice(-4).join(" | ")}`);
    try { cdp = await Cdp.connect(port); } catch { if (waited > 120_000) throw new Error("the app's DevTools port did not come up in 2 minutes"); await sleep(500); }
  }
  const rootSession = async (): Promise<string | undefined> => (await cdp!.documents()).find((d) => d.url === "moss-core://app/")?.session;
  let session: string | undefined;
  for (let waited = 0; session === undefined; waited += 500) { session = await rootSession(); if (session === undefined) { if (waited > 120_000) throw new Error("the window's root document did not appear"); await sleep(500); } }
  // The canvas drawn with its sessions' blocks: any document with a block in it (the canvas is a plugin's frame in the window).
  const drawn = async (): Promise<number> => {
    let n = 0;
    for (const d of await cdp!.documents()) n = Math.max(n, Number(await cdp!.evaluate(d.session, "document.querySelectorAll('.cv-node[data-block]').length").catch(() => 0)) || 0);
    return n;
  };
  // The window starts on the newest code session (Shell.tsx startRoute); the canvas is the start page, one click on "New session" away.
  for (let waited = 0; waited < 30_000; waited += 1_000) {
    let clicked = false;
    for (const d of await cdp.documents()) {
      const r = await cdp.evaluate(d.session, "(() => { const b = [...document.querySelectorAll('button, a, [role=button], [role=link]')].find((e) => (e.textContent || '').trim() === 'New session'); if (!b) return false; b.click(); return true; })()").catch(() => false);
      if (r === true) clicked = true;
    }
    if (clicked) break;
    await sleep(1_000);
  }
  let blocks = 0;
  for (let waited = 0; blocks < 7; waited += 1_000) { blocks = await drawn(); if (blocks >= 7) break; if (waited > 90_000) break; await sleep(1_000); }
  say(`the canvas drew ${blocks} block(s)`);
  await sleep(2_000);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 760, deviceScaleFactor: 2, mobile: false }, session).catch(() => undefined);
  await sleep(800);
  const picture = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" }, session);
  mkdirSync(dirname(resolve(png)), { recursive: true });
  writeFileSync(png, Buffer.from(picture.data, "base64"));
  cdp.close();
  // Nothing was drawn on a screen: the app says so itself if a window of it showed while headless.
  const log = ["app.log.1", "app.log"].map((f) => { try { return readFileSync(join(home, "logs", f), "utf8"); } catch { return ""; } }).join("\n");
  const shown = log.split("\n").find((l) => /window: shown while headless/.test(l));
  if (shown !== undefined) throw new Error(`a window showed while headless: ${shown.slice(0, 200)}`);
  say(`picture: ${resolve(png)} (${blocks} block(s) drawn)`);
}

/** Watches what the look is built from; a change rebuilds apps/desktop (what a source run builds) and tells the window to reload. A change during a build is built again after it. */
function watching(rebuild: () => boolean, reloadFile: string): () => void {
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let building = false;
  let again = false;
  let counter = 0;
  const run = (): void => {
    if (building) { again = true; return; }
    building = true;
    const t = Date.now();
    say("a source change: rebuilding");
    const ok = rebuild();
    building = false;
    if (ok) { writeFileSync(reloadFile, String(++counter)); say(`rebuilt and reloaded (${((Date.now() - t) / 1000).toFixed(1)} s)`); }
    else say(`the build failed (${join(dirname(reloadFile), "logs", "desktop-build.log")}); the window keeps what it shows, and the next change tries again`);
    if (again) { again = false; schedule(); }
  };
  const schedule = (): void => { clearTimeout(timer); timer = setTimeout(run, 700); };
  for (const rel of WATCHED) {
    const dir = join(REPO, rel);
    if (!existsSync(dir)) continue;
    try {
      watchers.push(watch(dir, { recursive: true }, (_e, name) => { if (typeof name === "string" && reloads(join(rel, name))) schedule(); }));
    } catch (err) { say(`not watching ${rel}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  say(`watching ${WATCHED.join(", ")}`);
  return () => { clearTimeout(timer); for (const w of watchers) w.close(); };
}

try {
  const opts = parseOptions(process.argv.slice(2));
  if (opts.help) { console.log(USAGE); process.exit(0); }
  if (opts.mode === "stop") process.exit(await stop());
  await main(opts);
} catch (err) {
  if (err instanceof UsageError) { process.stderr.write(`preview: ${err.message}\n${USAGE}\n`); process.exit(2); }
  say(`failed: ${err instanceof Error ? err.message : String(err)}`);
  await cleanup(1);
}
