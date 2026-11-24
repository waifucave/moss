// The slice of the MOSS plugin API (spec §5.4) this plugin's host half uses: the SDK's own `HostPluginApi`, so the type
// checker holds it to the catalog (packages/core/src/plugin-host/tests/bundled-host-members.test.ts scans the rest).
//
// * `net.fetch` with `auth: "waifucave"`: the core adds this computer's waifucave account token for hooks.waifucave.com
//   (the plugin's `network:` host); plugin code never sees it. With no account signed in it rejects with `no_account`
//   before anything goes out.
// * `keys.publicKey` / `keys.open`: this computer's forwarder key, held by the core (the `moss` process only); the
//   private half never reaches the plugin host.
// * `plugin.computer`: the name the service shows for this computer.
// * `settings.get("origin")`: a development profile's local forwarder emulator.

import type { HostPluginApi } from "@waifucave/moss-plugin-sdk";

export type HostApi = Pick<HostPluginApi, "net" | "keys" | "settings" | "plugin">;
