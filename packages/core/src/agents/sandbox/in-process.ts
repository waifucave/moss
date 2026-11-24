// The in-process agents' sandbox (MOSS's coding agent and lane A's `moss` subagents). They run on the embedded
// runtime with its sandbox required: Seatbelt's on macOS, bubblewrap's on Linux (the runtime names bwrap when it is
// missing, so a Linux machine with it works). Elsewhere (Windows) the runtime refuses every sandboxed tool call
// ("refusing to silently run unsandboxed"); the backends say so at detection instead, so a delegation there, on this
// computer or for another one, is refused up front with the reason, not left to fail call by call.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { AgentDetection } from "../../contracts/agent-backend";

const SEATBELT = "/usr/bin/sandbox-exec";

const BWRAP = "/usr/bin/bwrap";
let bwrapWorks: boolean | undefined;

/** Linux: bubblewrap is installed and can make its namespaces here (the probe fenced-process.ts runs for a fenced command). The embedded
 *  runtime's own sandbox on Linux is bubblewrap's: with it missing or blocked (Ubuntu's AppArmor can turn user namespaces off) the runtime
 *  refuses each sandboxed tool call and never runs one unsandboxed, so this only tells the person up front, as it does on macOS. */
function bwrapReady(): boolean {
  if (bwrapWorks !== undefined) return bwrapWorks;
  if (!existsSync(BWRAP)) return (bwrapWorks = false);
  const r = spawnSync(BWRAP, ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-net", "--unshare-pid", "/bin/true"], { encoding: "utf8", timeout: 10_000 });
  return (bwrapWorks = r.status === 0);
}

/** Whether the embedded runtime's sandbox can run here. */
export function inProcessSandboxReady(): boolean {
  if (process.platform === "linux") return bwrapReady();
  return process.platform === "darwin" && existsSync(SEATBELT);
}

/** An in-process backend's detection where its sandbox can't run: not available, with the reason. */
export function notAvailableHere(id: string, version?: string): AgentDetection {
  const where = process.platform === "linux" ? "on Linux" : process.platform === "win32" ? "on Windows" : process.platform === "darwin" ? "on this Mac (its sandbox-exec is missing)" : `on ${process.platform}`;
  return {
    installed: false, identityOk: true, versionOk: true, sandboxed: false, ...(version === undefined ? {} : { version }),
    reason: `${id} runs in the embedded runtime's sandbox, which is macOS-only for now: it isn't available ${where} yet`,
  };
}
