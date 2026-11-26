// A relay plugin's mail handlers over an in-memory relay, for tests (lane XC 5b): as relay-cloudflare's are, a take or
// an ack reads the mailbox of the device the core names. Records each call.
import type { MemoryMailRelay } from "../mailbox";
import type { RelayMailSource, RelayOn } from "../relay-mailbox";

export function fakeRelayPlugin(relay: MemoryMailRelay) {
  const calls: { relay: RelayOn; method: string; args: Record<string, unknown> }[] = [];
  const invoke: RelayMailSource["invoke"] = async (r, method, args) => {
    calls.push({ relay: r, method, args });
    const device = String(args["device"] ?? "");
    if (method === "putMail") {
      const a = args as { to: string; id: string; sealed: Uint8Array; expiresAt: number };
      await relay.for(a.to).put(a);
      return {};
    }
    if (method === "takeMail") return { mail: await relay.for(device).take({ ...(typeof args["max"] === "number" ? { max: args["max"] } : {}) }) };
    await relay.for(device).ack(args["ids"] as string[]);
    return {};
  };
  return { calls, invoke };
}

export const CLOUDFLARE_RELAY: RelayOn = { pluginId: "moss/relay-cloudflare", handler: "relay" };
