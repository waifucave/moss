// The relay choice's methods (spec §8.3, the setup guide's relay page): which relay this computer's links use. n0's public
// relays are the default; the person can turn relays off or point the links at a relay server of their own. The choice is the
// person's own press (`userOnly`), kept in the settings (`settings.links.relay`, read only through `relayChoiceFrom`) and put
// to the link sidecar at once (`DeviceLinks.setRelay`). General: nothing here knows which window asked.
import { DEVICES_METHODS, MOSS_ERR, type RelayView } from "@waifucave/moss-protocol";
import { handler, MethodError, type MethodHandler } from "../rpc/handler";
import { validRelayUrl } from "../settings";
import { ContractError } from "../contracts/common";

export interface DeviceRelayDeps {
  get(): RelayView;
  /** Keeps the choice and applies it to the links. */
  set(choice: RelayView): Promise<void> | void;
}

export function deviceRelayMethods(deps: DeviceRelayDeps): Record<string, MethodHandler> {
  return {
    [DEVICES_METHODS.deviceRelayGet.name]: handler(DEVICES_METHODS.deviceRelayGet, () => deps.get()),
    [DEVICES_METHODS.deviceRelaySet.name]: handler(DEVICES_METHODS.deviceRelaySet, async (p, ctx) => {
      // The person's own choice: never a plugin's part, a session or a peer (the server's `userOnly` already says so; checked again here).
      if (ctx.caller.kind !== "user") throw new MethodError(MOSS_ERR.NOT_THE_USER, "only the user can choose the relay");
      let choice: RelayView;
      if (p.mode === "custom") {
        // Only an `https:` address with no login in it: a relay the person means, never one that sends a secret somewhere.
        const url = p.url === undefined ? undefined : validRelayUrl(p.url);
        if (url === undefined) throw new ContractError("invalid", "a relay server's address is an https:// address with no login or query in it");
        choice = { mode: "custom", url };
      } else choice = { mode: p.mode };
      await deps.set(choice);
      return deps.get();
    }),
  };
}
