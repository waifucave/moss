// What this plugin's host half uses of the plugin API (spec §5.4): the SDK's own types. `plugin.device` is this device's
// id, which the core gives a plugin granted `devices.read` (this plugin asks for it): whose mailbox it reads when the link
// layer's call names none.

import type { PluginApi } from "@waifucave/moss-plugin-sdk";

export type HostApi = Pick<PluginApi, "net" | "settings" | "plugin">;
