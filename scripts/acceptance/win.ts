// What the acceptance run needs of the system that Windows spells differently: where the engine listens (a named pipe, where
// macOS and Linux have a socket file in the home) and ending a process with what it started (Windows has no process groups).
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { resolveEndpoint } from "../../packages/core/src/platform/transport";

/** What a client dials for the home's engine: its socket file, or on Windows its named pipe (the engine's own rule). */
export function coreEndpoint(home: string): string {
  return resolveEndpoint(join(home, "run")).path;
}

/** Ends a process and everything it started (Windows: `taskkill /T /F`, which is a hard end, as a Windows process has no SIGTERM to answer). */
export function killTree(pid: number): void {
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}
