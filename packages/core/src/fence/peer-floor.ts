// What another computer's call gets on this one (lane XC, the reader's floor for step 2: never more than a bot running
// here gets). One module for both doors a peer reaches this computer by, so they can't drift:
//
// * its FILE calls through the folder tree (`LocalHolder`): a write, delete or move that lands on a run-later place
//   (`runLaterByName`: every `.git`, the shells' start files, `.vscode`, `.claude`, `.mcp.json`, credential files, a
//   `.moss` outside the MOSS home, a fixed PATH folder…) or on one of the user's secret places (`SECRET_READ_PLACES`)
//   is refused, as a bot's file write there is refused before any card (bot-check); a read of a secret place is
//   refused, as a bot's Read is;
// * its BASH (`fencedExecutor`): the fenced process runs on a view of this computer's fence whose ONLY write root is
//   the call's own fresh temp folder (`peerFence`), and whose read denies add the user's secret places. A bot here at
//   ask for risky actions or below writes only its own folders and the temp folder; a peer has no folders here, so its
//   own temp folder is its whole write set. At accept edits and fully automatic a bot here may also write the user's
//   home (less the run-later places, drawn for the runtime's own sandbox in a glob dialect this fence doesn't speak):
//   a peer still gets only its temp folder there. Never more than the bot, at some levels less (said in the report).
//   Nothing the asking computer sends widens it: there is no grant or escape for a peer.
import type { Os } from "@waifucave/moss-protocol";
import { secretReadPlaces, type Fence, type FenceContext, type SandboxPolicy } from "../contracts/fence";
import { runLaterByName } from "./sandbox-settings";
import { secretPlaceOf } from "./secret-reads";

export interface PeerFloorOptions {
  /** The user's home folder here. */
  userHome: string;
  /** The MOSS home here. */
  mossHome: string;
  os: Os;
}

/** Why a peer may not write, remove or move `real` here (a real, absolute path), or undefined. */
export function peerWriteRefusal(real: string, o: PeerFloorOptions): string | undefined {
  if (runLaterByName(real, o)) return "another computer's call never writes a place that runs later (a .git, a shell's start file, an editor's or agent's settings, a credential file)";
  return peerReadRefusal(real, o);
}

/** Why a peer may not read `real` here, or undefined: the user's secret places. */
export function peerReadRefusal(real: string, o: PeerFloorOptions): string | undefined {
  const cls = secretPlaceOf(real, { userHome: o.userHome, os: o.os, cwd: o.userHome });
  return cls === undefined ? undefined : `another computer's call never reaches the user's secret places (${cls})`;
}

/** The fence a peer's command runs under: this computer's, its policy narrowed to `writeRoot` as the one write root,
 *  with the user's secret places read-denied. Every other part (the fenced set, the closed doors, the MOSS home's
 *  default-deny, the network rule) is the fence's own. */
export function peerFence<F extends Pick<Fence, "policy">>(fence: F, writeRoot: string, o: PeerFloorOptions): F {
  const secrets = secretReadPlaces(o.os, o.userHome).map((p) => p.path);
  const policy = (ctx?: FenceContext): SandboxPolicy => {
    const base = fence.policy(ctx);
    return { ...base, allowWrite: [writeRoot], denyRead: [...new Set([...base.denyRead, ...secrets])] };
  };
  return new Proxy(fence, {
    get(target, key) {
      if (key === "policy") return policy;
      // On the fence itself (its private fields and getters are its own, never the proxy's).
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
