// Linux: another computer's command that was given its folder (step 3b) runs under the agent runtime's own command
// sandbox (`@waifucave/clover-agent-runtime/sandbox`, from 0.0.91), the very one a local bot's Bash gets, never a
// second implementation (lane XC; the controller's ruling, option (a)). MOSS's own bubblewrap holds a fenced item by
// its path when the run starts and can't take the held names' patterns (`/**/<name>`), so it could not hold a
// repository's `.git` against the review's rename (`mv proj proj-old && mkdir -p proj/.git/hooks …`). The runtime's
// does: the patterns walked under every write root on one budget per command, failing closed past it; the protected
// folders made before the run; what the command made at a protected path moved aside at its end, its parent checked
// against the walk's identity, into `<MOSS home>/quarantine` as for a local bot.
//
// What the run gets is the peer fence's own policy (`peerFence`): its one per-call temp root and the folder as the
// only write roots, the folder's run-later and secret denies (`peerFolderDenies`, the local bot rule), the secret
// places read-denied, the MOSS home read- and write-denied whole (hidden: the peer reaches nothing of it). And the
// runtime's floor: no network (the settings name none), no Unix socket (its seccomp filter), its own pid, IPC and UTS
// namespaces, a new session, the user's session bus hidden. A run whose working folder is outside its write roots is
// refused (the runtime makes the working folder writable). What the command leaves running is stopped at its end.
import { realpathSync } from "node:fs";
import { fenceContextFor, type Fence, type FenceContext, type SandboxPolicy } from "../contracts/fence";
import { pathWithin } from "./fold";
import type { PeerWriteFolder } from "./peer-floor";
import type { FencedRun, FencedRunResult, FencedSpawner } from "./spawn";
import { CORE_BRAND } from "../runtime-sdk/brand";

type SandboxEntry = typeof import("@waifucave/clover-agent-runtime/sandbox");

/** The entry, loaded at the first Linux folder run (only Linux holders need it). */
const loadEntry = (): Promise<SandboxEntry> => import("@waifucave/clover-agent-runtime/sandbox");

/** The runtime sandbox's settings for a peer's policy: its write roots and denies, and no `network` (none). */
export function peerRuntimeSettings(policy: SandboxPolicy): { filesystem: { allowWrite: string[]; denyWrite: string[]; denyRead: string[] } } {
  return { filesystem: { allowWrite: [...policy.allowWrite], denyWrite: [...policy.denyWrite], denyRead: [...policy.denyRead] } };
}

export interface PeerFolderSpawnerOptions {
  /** The peer fence (`peerFence` over this computer's fence, with the folder): its policy is the run's. */
  readonly fence: Pick<Fence, "policy"> & { readonly mossHome: string; readonly home: string; contextFor?(caller: FencedRun["who"]["caller"]): FenceContext };
  readonly root: string;
  readonly folder: PeerWriteFolder;
  /** Test seam: the entry. */
  readonly entry?: () => Promise<SandboxEntry>;
}

/** The spawner for one peer call given its folder, on a Linux holder. */
export function peerFolderSpawnerLinux(o: PeerFolderSpawnerOptions): FencedSpawner {
  return {
    available: true,
    async run(r: FencedRun): Promise<FencedRunResult> {
      let e: SandboxEntry;
      try { e = await (o.entry ?? loadEntry)(); } catch {
        return { kind: "refused", reason: "this computer's sandbox for another computer's command in its folder isn't installed (agent runtime 0.0.91 or later)" };
      }
      if (!e.linuxSandboxReady()) return { kind: "refused", reason: e.sandboxUnavailableMessage() };
      const ctx = o.fence.contextFor?.(r.who.caller) ?? fenceContextFor(r.who.caller);
      const policy = o.fence.policy(ctx);
      let cwd: string;
      try { cwd = realpathSync.native(r.cwd); } catch { return { kind: "refused", reason: `${r.cwd} isn't there` }; }
      // The runtime makes the working folder writable: it must be one of the peer's own roots already.
      if (!policy.allowWrite.some((w) => pathWithin(cwd, w, "linux"))) {
        return { kind: "refused", reason: `a command from another computer runs only in ${o.folder.path} or its own temp folder, not ${r.cwd}` };
      }
      const settings = peerRuntimeSettings(policy);
      const inputs = e.buildHostSandboxRunInputs({
        cwd, env: { ...r.env }, settings, writableRoots: settings.filesystem.allowWrite, home: o.fence.home,
        winterHome: o.fence.mossHome, brand: CORE_BRAND,
      });
      let stdout = "", stderr = "";
      try {
        const res = await e.runCommand({
          ...inputs, command: r.command, timeoutMs: r.timeoutMs, ...(r.signal ? { signal: r.signal } : {}),
          onStdout: (c) => { stdout += c.toString(); r.onOutput?.(c.toString(), "stdout"); },
          onStderr: (c) => { stderr += c.toString(); r.onOutput?.(c.toString(), "stderr"); },
        });
        // A peer's call adopts nothing: what it left running ends with it.
        if (res.leftBehind !== undefined) { res.leftBehind.stop(); stderr += "moss: what the command left running was stopped (another computer's command runs only while it runs)\n"; }
        if ((res.quarantined?.length ?? 0) > 0) stderr += `moss: moved aside what the command made where repositories and settings are held: ${res.quarantined!.join(", ")}\n`;
        if (res.spawnError !== undefined) return { kind: "refused", reason: `the command couldn't start: ${res.spawnError}` };
        if (res.timedOut) return { kind: "timeout", stdout, stderr, shell: "sh" };
        return { kind: "exited", code: res.exitCode ?? 1, stdout, stderr, shell: "sh" };
      } catch (err) {
        return { kind: "refused", reason: err instanceof Error ? err.message.slice(0, 300) : "this computer's sandbox refused the command" };
      }
    },
  };
}
