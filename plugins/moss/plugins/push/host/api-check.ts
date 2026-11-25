// Holds host/api.ts to the SDK: the plugin API a host half gets is a `HostApi`, so a member renamed or retyped in the SDK
// fails this plugin's typecheck. Nothing imports this file.

import type { HostPluginApi } from "@waifucave/moss-plugin-sdk";
import type { HostApi } from "./api";

export const fitsTheSdk = (api: HostPluginApi): HostApi => api;
