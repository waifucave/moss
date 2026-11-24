// Starting a plugin-host process (spec §5.2): the daemon runs `process-main.ts` on the plugin Bun (#234's
// `pluginBunLaunch` gives the command and the guarded environment), with the link on fd 3, a pipe only the daemon and
// that process hold. The process's stdout and stderr are never read as messages; their lines go to `onOutput` (the
// plugin host's own log).
import { noteSpawned } from "../auth/moss-caller";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { writeHostBundles } from "./bundles";
import { mossSharedRoots, ensurePluginRunFiles, guardedPluginEnv, pluginBun, pluginHostBunFlags, pluginRunFileChecks, type PluginRunFiles } from "../registry/plugin-run";
import { checkRunFiles, runCheckArgs, type RunFileCheck } from "./run-file";
import { randomBytes } from "node:crypto";
import { WINDOWS_PIPE_PREFIX } from "../platform/transport";
import { WindowsPipePeers } from "../platform/caller-probe";
import { currentUserSid, lockPipeDacl } from "../platform/win-pipe";
import { fdLink, LINK_LINE_MAX, linesOf, socketLink, streamPeer, type RpcPeer } from "./link";

export { writeHostBundles } from "./bundles";

/** The host process's entry, for the launch command. */
export const HOST_PROCESS_ENTRY = fileURLToPath(new URL("./process-main.ts", import.meta.url));


/** How a plugin-host process starts, guarded (#234's run files, B-M2's host mode): the plugin Bun with MOSS's flags and
 *  the host's own guard (`files.hostGuard`), which only these arguments name, so its own thread runs MOSS's bundle
 *  unpinned while every worker it starts gets the plugin guard, pinned to its own plugin's folder (`mossPluginRoot`),
 *  and the worker bundle beside the guard. No environment variable makes a process a host (#322's review, B1). */
export async function hostProcessLaunch(o: { runDir: string; computer: string; base: Readonly<Record<string, string | undefined>>; shared?: readonly string[]; mossHome: string; onOutput?: (line: string) => void }): Promise<HostProcessLaunch> {
  const files = ensurePluginRunFiles(o.runDir, { mossHome: o.mossHome });
  const bundles = await writeHostBundles(dirname(files.guard));
  const env = guardedPluginEnv(o.base, { pluginRoot: dirname(files.guard), files, shared: o.shared ?? mossSharedRoots() });
  delete env.MOSS_PLUGIN_ROOT;
  // The flags are in the arguments: BUN_OPTIONS would preload the plugin guard into the host's own thread too (the
  // host's guard sets it for each worker).
  delete env.BUN_OPTIONS;
  env.MOSS_PLUGIN_WORKER = bundles.worker;
  env.MOSS_COMPUTER = o.computer;
  // What each start runs from, by the SHA-256 of the text MOSS wrote (#312's review, S1): the host process's own
  // files, checked by `spawnHostProcess` immediately before it starts it, and each worker's, which the host checks
  // before every Worker (in its arguments, never its environment).
  const workerChecks: RunFileCheck[] = [{ path: bundles.worker, sha256: bundles.sha256.worker }, ...pluginRunFileChecks(files)];
  const checks: RunFileCheck[] = [{ path: bundles.host, sha256: bundles.sha256.host }, ...pluginRunFileChecks(files, { host: true })];
  const bun = pluginBun(files.mossHome);
  const shared = o.shared ?? mossSharedRoots();
  return {
    cmd: [bun, ...pluginHostBunFlags(files), bundles.host, ...runCheckArgs(workerChecks)],
    env,
    checks,
    reads: [dirname(files.guard), ...shared, bun],
    files,
    ...(o.onOutput ? { onOutput: o.onOutput } : {}),
  };
}

export interface HostProcessLaunch {
  /** The command: the plugin Bun and its flags, then the host bundle, then the worker's checks (`--moss-check=`). */
  cmd: readonly string[];
  env: Record<string, string>;
  /** The files this start runs from (the host bundle, the host guard, the guard, the bunfig) and their SHA-256s:
   *  `spawnHostProcess` refuses to start when any differs. */
  checks?: readonly RunFileCheck[];
  /** What every host process reads besides its plugin's tree, under the fence: the run files, the shared packages and
   *  its Bun (`cmd[0]`, the one program it runs). */
  reads?: readonly string[];
  /** MOSS's run files it was made from (the spawn trampoline's Bun and file, under the fence). */
  files?: Pick<PluginRunFiles, "guard" | "bin" | "bunfig">;
  /** Where it starts (the run folder, under the fence); the daemon's own folder otherwise. */
  cwd?: string;
  onOutput?: (line: string) => void;
}

/** How long a host process's group has between SIGTERM and SIGKILL when it's ended. */
export const HOST_KILL_GRACE_MS = 2_000;

/** Starts a host process in a process group of its own (POSIX), so ending it ends what its plugins started too (#322's
 *  review, S4): the daemon's stop and close (`kill`), the link closing, and the process exiting on its own (a crash)
 *  each signal the whole group, SIGTERM then SIGKILL after `HOST_KILL_GRACE_MS`. A process that goes on its own way
 *  (a new session, `setsid`) has left the group, and isn't reached. On Windows the process alone is ended. */
export function spawnHostProcess(o: HostProcessLaunch & { graceMs?: number }): { peer: RpcPeer; pid: number | undefined; kill(): void } {
  const group = process.platform !== "win32";
  // Last thing before the start: the files it runs from hold what MOSS wrote (a plugin can write the run folder).
  checkRunFiles(o.checks ?? [], "the plugin host");
  // Through Bun.spawn: a node:child_process spawn with a descriptor past 2 is refused in Bun code (lane C's S7 finding,
  // `test/platform/child-process-stdio.test.ts`). `detached` makes the child its group's leader.
  // Windows: no descriptor 3 (a Bun child's extra stdio there is a handle `fs` can't use), so the link is a named pipe the
  // daemon listens on before the child starts. As the daemon's own pipe (ipc/server.ts), and for the same reason (a fresh libuv pipe's
  // default DACL lets Everyone read it, and any account can list `\\.\pipe\`, so its name hides nothing): its DACL is locked to the user and
  // SYSTEM right after the listen (the start fails when it can't be), and a connection is taken only from the pid of the child this
  // function started, found through the pipe's own server end (`WindowsPipePeers`), never the first to arrive. A refused client is
  // closed and the pipe goes on waiting for the host. The name is 128 random bits in the child's environment (the host deletes it
  // once read); the pipe takes ONE connection and goes with the child. The host checks, as the app checks the daemon, that the pipe's
  // server is its parent (link.ts `connectSocketLink`).
  let pipe: { stop(closeActive?: boolean): void } | undefined;
  let winLink: ReturnType<typeof socketLink> | undefined;
  let hostPid: number | undefined;
  let env = o.env === undefined ? undefined : { ...o.env };
  if (env !== undefined) delete env.MOSS_HOST_LINK; // never an inherited one: only the pipe this call makes
  if (!group) {
    winLink = socketLink(LINK_LINE_MAX);
    const lk = winLink;
    const name = `${WINDOWS_PIPE_PREFIX}moss-host-${randomBytes(16).toString("hex")}`;
    const peers = new WindowsPipePeers(name);
    let main: object | undefined;
    const server = Bun.listen({ unix: name, socket: {
      open(s) {
        // Closed unless it is the host this call started, connected after the DACL held, and the first of it.
        const who = peers.opened(s);
        if (main !== undefined || hostPid === undefined || who === null || who !== hostPid || peers.isEarly(s)) return void s.end();
        main = s;
        lk.attach(s);
      },
      data(s, d) { if (s === main) lk.data(d); }, drain(s) { if (s === main) lk.drain(); },
      close(s) { peers.closed(s); if (s === main) lk.end(); }, error(s) { if (s === main) lk.end(); },
    } });
    pipe = server;
    const sid = currentUserSid();
    if (sid === null || lockPipeDacl(name, sid) === 0) {
      server.stop(true);
      throw new Error("the plugin host's link could not be made owner-only");
    }
    peers.lockedDown();
    env = { ...(env ?? {}), MOSS_HOST_LINK: name } as typeof env;
  }
  const child = Bun.spawn([...o.cmd], { env, stdio: group ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"], windowsHide: true, ...(o.cwd !== undefined ? { cwd: o.cwd } : {}), ...(group ? { detached: true } : {}) });
  hostPid = child.pid;
  noteSpawned(child.pid, child.exited); // C-M1: a plugin host process is never the user to the caller check
  // The daemon's end: a line past LINK_LINE_MAX from the process ends the link (its plugins crash), never buffered on.
  const link = winLink ?? fdLink(child.stdio[3] as unknown as number, LINK_LINE_MAX);
  const peer = streamPeer(link.lines, (line) => link.write(`${line}\n`));
  for (const s of [child.stdout, child.stderr]) {
    void (async () => {
      for await (const line of linesOf(s as unknown as AsyncIterable<Uint8Array>)) o.onOutput?.(line.slice(0, 4000));
    })().catch(() => {}); // a pipe that fails to read ends its output, as its EOF does
  }
  const pid = child.pid;
  const signal = (sig: "SIGTERM" | "SIGKILL"): boolean => {
    if (!group) {
      if (child.exitCode === null && child.signalCode === null) child.kill(sig);
      return true;
    }
    try {
      process.kill(-pid, sig);
      return true;
    } catch {
      return false; // the group is empty
    }
  };
  let ending = false;
  const end = () => {
    if (ending) return;
    ending = true;
    if (!signal("SIGTERM")) return;
    const timer = setTimeout(() => {
      // Only a group still there: none left means nothing to kill (and no later group reusing the id is touched).
      if (!group || (() => { try { process.kill(-pid, 0); return true; } catch { return false; } })()) signal("SIGKILL");
    }, o.graceMs ?? HOST_KILL_GRACE_MS);
    (timer as { unref?: () => void }).unref?.();
  };
  void child.exited.then(() => {
    pipe?.stop(true);
    winLink?.end();
    peer.close();
    end();
  });
  peer.onClose(end);
  return { peer, pid, kill: end };
}
