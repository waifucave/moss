// The waifucave push plugin's host half (moss/push). Its `notifiers` entry runs on the main computer, or the
// takeover computer while the main is offline (spec §5.2); the core starts it when it is first needed.
//
// Exports:
//   start(api) / stop()   the host half's lifecycle
//   notifier              the handler of this plugin's `notifiers` entry (moss.json)

import { PushNotifier, type Notification } from "../src/notifier";
import { RevocationSweep } from "../src/revoked";
import type { HostApi } from "./api";

export const DEFAULT_ORIGIN = "https://push.waifucave.com";

let current: PushNotifier | null = null;
let offDevices: (() => void) | null = null;

/** The service's origin: the default, or a development profile's local emulator (the `origin` setting, this device's
 *  own). Anything that isn't `https:`, or plain `http:` to this computer's loopback, is ignored. The core's keyed fetch
 *  adds the account token only for waifucave.com hosts (or a development profile's emulator) in this plugin's
 *  `network:` list, so the setting can't send the token anywhere else. */
export function originFrom(setting: unknown): string {
  if (typeof setting !== "string" || setting === "") return DEFAULT_ORIGIN;
  try {
    const url = new URL(setting);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
    if (url.username !== "" || url.password !== "") return DEFAULT_ORIGIN;
    if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return url.origin;
  } catch {
    // not a URL
  }
  return DEFAULT_ORIGIN;
}

/** One line in the plugin's log (a host half's console goes there). Never a notification's words. */
function log(level: "info" | "warn" | "error", message: string): void {
  console[level](`push: ${message}`);
}

export async function start(api: HostApi): Promise<void> {
  if (current) return;
  const origin = originFrom(await api.settings.get<string>("origin"));
  const fetch = (url: string, init?: RequestInit) => api.net.fetch(url, init, { auth: "waifucave" });
  const synced = api.storage.synced;
  const sweep = new RevocationSweep({
    // Without `devices.read` there is no list, and nothing is ever revoked from here.
    list: async () => (api.devices === undefined ? [] : api.devices.list()),
    revoked: async () => (api.devices === undefined ? [] : api.devices.revoked()),
    store: {
      get: () => synced.get(`devices:${api.plugin.computer}`),
      set: (value) => synced.set(`devices:${api.plugin.computer}`, value),
    },
    revoke: async (id) => {
      const response = await fetch(`${origin}/v1/devices/${encodeURIComponent(id)}`, { method: "DELETE", signal: AbortSignal.timeout(15_000) });
      await response.body?.cancel();
      // 204: taken. A 4xx other than 429 is a refusal that a retry won't change (a bad id): not kept.
      return response.ok || (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 429);
    },
    log,
  });
  current = new PushNotifier({
    origin,
    fetch,
    store: {
      get: async () => {
        const value = await synced.get("unseen");
        return typeof value === "number" ? value : null;
      },
      set: (count: number) => synced.set("unseen", count),
    },
    beforeSend: () => sweep.sweep(),
    log,
  });
  // A device that changes is a moment to look: a revocation is seen at the latest before the next push.
  offDevices = api.devices?.watch(() => {
    void sweep.sweep().catch(() => {});
  }) ?? null;
  void sweep.sweep().catch(() => {});
}

export async function stop(): Promise<void> {
  offDevices?.();
  offDevices = null;
  current?.stop();
  current = null;
}

function live(): PushNotifier {
  if (!current) throw new Error("waifucave push is not running on this computer");
  return current;
}

/** The `notifiers` handler: the core calls notify when something happens for the user, clear when they catch up. */
export const notifier = {
  notify: (notification?: Notification) => live().notify(notification),
  clear: () => live().clear(),
};
