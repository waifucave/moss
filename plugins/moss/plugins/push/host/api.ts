// The slice of the MOSS plugin API (spec §5.4) this plugin's host half uses. It is written out here, not imported, so the
// push service's own typecheck (services/push, which runs this host half in its tests) needn't take the SDK's sources;
// host/api-check.ts holds it to the SDK's `HostPluginApi`, and packages/core/src/plugin-host/tests/bundled-host-members
// .test.ts scans the host half for any member outside the catalog.
//
// * `net.fetch` with `auth: "waifucave"`: the core adds this computer's waifucave account token for push.waifucave.com
//   (the plugin's `network:` host); plugin code never sees it. With no account signed in it rejects with `no_account`
//   before anything goes out.
// * `storage.synced`: the unseen count, and the phones and browsers this computer saw (src/revoked.ts).
// * `devices.list` / `devices.watch` / `devices.revoked` (`devices.read`): which phones and browsers are still paired,
//   and which the registry holds as revoked.
// * `settings.get("origin")`: a development profile's local push emulator.

export interface HostApi {
  readonly plugin: { readonly computer: string };
  readonly settings: { get<T = unknown>(key: string): Promise<T | undefined> };
  readonly storage: { readonly synced: { get<T = unknown>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> } };
  readonly devices?: {
    list(): Promise<{ id: string; runsCore: boolean; isThis: boolean }[]>;
    watch(listener: (device: unknown) => void): () => void;
    revoked(): Promise<{ id: string; revokedAt: number }[]>;
  };
  readonly net: { fetch(url: string, init?: RequestInit, opts?: { auth?: string | false }): Promise<Response> };
}
