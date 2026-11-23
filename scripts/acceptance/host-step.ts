// The background host's row (lane HS; spec revision 19 §3.1, §3.4, §12.1, items 98, 111, 116, 121): run.ts's `host` unit
// (`--units host`, serial: its own home, its own daemon, which starts the host itself from this checkout through
// `MOSS_HOST_COMMAND`, the engine's source seam). The probes and the row's name live here; run.ts drives the processes.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cdp } from "./cdp";

export const HOST_STEP = "the background host (lane HS): the engine starts it with no app window, one island in it and none in MOSS Code's window; with the window's process quit the island draws a pending card and takes its press, a background part keeps making its muted tone, and a bot's Browser tool opens a page; a restarted engine adopts the running host and starts no second; three crashes in two minutes start it in safe mode with no third-party part mounted, the engine's plugins still running";

/** The pid holding the host lock (the file's word, read under the host's own lock; only a live holder writes it). */
export function hostLockPid(home: string): number | undefined {
  try {
    const pid = Number(readFileSync(join(home, "run", "host.lock"), "utf8").trim().split(/\s+/)[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The island's own window in a program's DevTools targets. */
export function islandTarget(cdp: Cdp): { url: string } | undefined {
  return [...cdp.frames.values()].find((f) => f.type === "page" && f.url.startsWith("moss-core://app/?surface=island"));
}

/** A background fixture part's attributes (manifest-fields-step.ts's `Ticker`), read in whichever program mounts it. */
export async function backgroundPart(cdp: Cdp, id: string): Promise<Record<string, string> | undefined> {
  for (const d of (await cdp.documents()).filter((x) => x.url.startsWith(`moss-plugin://${id}/`))) {
    const v = await cdp.evaluate(d.session, `(() => { const e = document.querySelector('[data-acc-background]'); return e ? JSON.stringify(Object.fromEntries([...e.attributes].map((a) => [a.name, a.value]))) : ''; })()`).catch(() => "");
    if (typeof v === "string" && v !== "") return JSON.parse(v) as Record<string, string>;
  }
  return undefined;
}

/** The on-screen windows: owner pid, opacity and size; never titles. macOS reads the window server (`onscreen-windows.swift`);
 *  Linux reads the X server the run draws on (xvfb, with no window manager): each top-level window that is mapped (viewable),
 *  its pid from `_NET_WM_PID`, its opacity from `_NET_WM_WINDOW_OPACITY` (none means opaque). Needs `xwininfo` and `xprop` (x11-utils). */
export function onscreenWindows(swiftScript: string): { pid: number; alpha: number; w: number; h: number }[] | undefined {
  if (process.platform === "linux") return onscreenWindowsX11();
  if (process.platform !== "darwin") return undefined;
  const r = spawnSync("swift", [swiftScript], { encoding: "utf8", timeout: 120_000 });
  if (r.status !== 0) return undefined;
  return (r.stdout ?? "").split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { pid: number; alpha: number; w: number; h: number });
}

function onscreenWindowsX11(): { pid: number; alpha: number; w: number; h: number }[] | undefined {
  const tree = spawnSync("xwininfo", ["-root", "-children"], { encoding: "utf8", timeout: 20_000 });
  if (tree.status !== 0) return undefined;
  const out: { pid: number; alpha: number; w: number; h: number }[] = [];
  for (const id of [...(tree.stdout ?? "").matchAll(/^\s+(0x[0-9a-f]+)\s/gm)].map((m) => m[1]!)) {
    const info = spawnSync("xwininfo", ["-id", id], { encoding: "utf8", timeout: 10_000 }).stdout ?? "";
    if (!/Map State: IsViewable/.test(info)) continue;
    const w = Number(/Width: (\d+)/.exec(info)?.[1] ?? 0);
    const h = Number(/Height: (\d+)/.exec(info)?.[1] ?? 0);
    const props = spawnSync("xprop", ["-id", id, "_NET_WM_PID", "_NET_WM_WINDOW_OPACITY"], { encoding: "utf8", timeout: 10_000 }).stdout ?? "";
    const pid = Number(/_NET_WM_PID\(CARDINAL\) = (\d+)/.exec(props)?.[1] ?? 0);
    const op = /_NET_WM_WINDOW_OPACITY\(CARDINAL\) = (\d+)/.exec(props)?.[1];
    out.push({ pid, alpha: op === undefined ? 1 : Number(op) / 0xffffffff, w, h });
  }
  return out;
}

/** The browser rows again with the background host running (the controller's ruling): the same row, its pages in the host. */
export const BROWSER_HOST_STEP = "the Browser rows again with the background host running (lane HS): the pages in the host, the cards pressed where the router put them, MOSS Code's panel drawing the host's tabs";

export const HOST_GAVE_UP_STEP = "a host that never starts (lane HS, the reviewer's B2, never nowhere): the engine gives up after its bounded starts, and with no window focused a plugin's OK card is shown on MOSS Code's window's own fallback card, where a real press answers it";

export const SURFACE_COPY_HOST_STEP = "the island and pill copies' row again with the background host running (lane HS, the controller's R12 ruling): the copy island in the host is the OK card's drawer and stays while a third-party part holding no card stands down, and takes the press";

/** How many times a daemon log says the host was ready. */
export function readyCount(log: string): number {
  return (log.match(/\[host\] ready: /g) ?? []).length;
}

/** Linux's stand-in for the service manager that starts the real host (`systemctl --user start moss-host`): the engine is a child
 *  subreaper there (claimDaemonChildren), so anything it spawns, however double-forked, stays its descendant and is refused as "from
 *  inside a sandbox, or a bot's process" when it says hello as the app. The harness is outside the engine's tree, so it plays the
 *  manager: it listens on a socket, and the command the engine runs (`hostCommandViaLauncher`) hands it argv and environment, from
 *  which it starts the host detached, with its output in `<home>/logs/host.out.log` as Launch Services' `--stdout` has on macOS. */
export function startHostLauncher(): { sock: string; stop: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "clv-hl-"));
  const sock = join(dir, "l.sock");
  const server = createServer((c) => {
    const chunks: Buffer[] = [];
    c.on("data", (d: Buffer) => chunks.push(d));
    c.on("end", () => {
      // argv, each ended by NUL, then one more NUL, then `env -0`'s output (neither an argument nor a variable is empty).
      const parts = Buffer.concat(chunks).toString("utf8").split("\0");
      const gap = parts.indexOf("");
      const argv = parts.slice(0, gap);
      const env: Record<string, string> = {};
      for (const kv of parts.slice(gap + 1)) { const i = kv.indexOf("="); if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1); }
      if (argv.length === 0) return;
      const logDir = join(env.MOSS_HOME ?? dir, "logs");
      mkdirSync(logDir, { recursive: true });
      const out = openSync(join(logDir, "host.out.log"), "a");
      const child = spawn(argv[0]!, argv.slice(1), { detached: true, stdio: ["ignore", out, out], env });
      child.unref();
      // The host holds no OS lock on Linux (host-program.ts takeHostLock: macOS only), so the row's "the pid holding the lock" is what a
      // service manager knows as the unit's main pid: the manager's record of the process it started, in the lock file's place.
      if (child.pid !== undefined) { mkdirSync(join(env.MOSS_HOME ?? dir, "run"), { recursive: true }); writeFileSync(join(env.MOSS_HOME ?? dir, "run", "host.lock"), `${child.pid}\n`); }
    });
  });
  server.listen(sock);
  return { sock, stop: () => { try { server.close(); } catch { /* closed */ } } };
}

/** The `MOSS_HOST_COMMAND` JSON for Linux: a shell that sends its argv and environment to `startHostLauncher`'s socket. */
export function hostCommandViaLauncher(sock: string, argv: string[]): string {
  const script = '{ for a in "$@"; do printf \'%s\\0\' "$a"; done; printf \'\\0\'; env -0; } | socat - "UNIX-CONNECT:$0"';
  return JSON.stringify(["/bin/sh", "-c", script, sock, ...argv]);
}
