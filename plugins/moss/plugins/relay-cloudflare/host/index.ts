// The Cloudflare relay plugin's host half (moss/relay-cloudflare). It starts on each device that uses the relay
// (host.start "each") and fills its `relays` entry: the link layer asks it where the relay is, and keeps sealed sync
// mail there for a device that is away (spec §8.3). It never touches a link's traffic or holds the relay's key.

import { RelayClient } from "../src/client";
import type { HostApi } from "./api";

let client: RelayClient | null = null;
/** This device's id (`api.plugin.device`), when the core told it. */
let own: string | undefined;

export function start(api: HostApi): void {
  own = api.plugin.device;
  client = new RelayClient({
    origin: async () => (await api.settings.get<string>("origin")) ?? undefined,
    fetch: (url, init) => api.net.fetch(url, init, { auth: "relay-key" }),
    ...(api.plugin.device === undefined ? {} : { device: api.plugin.device }),
  });
}

export function stop(): void {
  client = null;
  own = undefined;
}

function live(): RelayClient {
  if (!client) throw new Error("the Cloudflare relay plugin is not running on this device");
  return client;
}

/** The `relays` entry's handler (lane B's RelayHandler, without `serve`: this relay runs in the user's account). */
export const relay = {
  endpoints: async () => ({ endpoints: await live().endpoints() }),
  putMail: async (args: { to: string; id: string; sealed: Uint8Array; expiresAt: number }) => {
    await live().putMail(args);
    return {};
  },
  takeMail: async (args?: { device?: string; max?: number }, ctx?: CallerContext) =>
    ({ mail: await live().takeMail({ ...(args?.max === undefined ? {} : { max: args.max }), ...mailboxOf(args?.device, ctx) }) }),
  ackMail: async (args: { device?: string; ids: string[] }, ctx?: CallerContext) => {
    await live().ackMail({ ids: args.ids, ...mailboxOf(args.device, ctx) });
    return {};
  },
};

/** Who called a handler, as the core says (never the caller's own word). */
interface CallerContext {
  caller?: { kind?: string };
}

/** Whose mailbox a take or an ack reads: the device the core names (the link layer passes the taking device's id), and for
 *  any other caller this device's own, whatever it names, so no one who can reach this handler takes or deletes another
 *  device's mail. */
function mailboxOf(named: string | undefined, ctx: CallerContext | undefined): { device?: string } {
  if (ctx?.caller?.kind === "core" && named !== undefined) return { device: named };
  return own === undefined ? {} : { device: own };
}
