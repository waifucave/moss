// What it takes to deploy each Worker under services/: the names of every variable and secret (never a value), where the
// owner's settings go in each Worker's configuration, which Workers must exist first, and how a deployed one is checked.
// `services/deploy.env.example` is this file's names with a comment on each; services-deploy.test.ts keeps the two, the
// Workers' `wrangler.jsonc` and their `src/env.ts` from drifting apart.
//
// Nothing here runs a command or reads an environment: scripts/services/lib.ts renders, deploy.ts runs.

/** One name the owner supplies, in the environment (or the env file). */
export interface EnvName {
  name: string;
  kind: "var" | "secret";
  /** A deploy cannot be made without it. */
  required: boolean;
  /** For --generate: how a fresh value is made. Absent: the owner brings it (a key from Apple, a project's URL). */
  generate?: GeneratorId;
}

export type GeneratorId = "signing-jwks" | "tag-keys" | "random" | "vapid";

export const ENV_NAMES: readonly EnvName[] = [
  // Where everything lives
  { name: "MOSS_SERVICES_DOMAIN", kind: "var", required: true },
  { name: "MOSS_ACCOUNTS_HOST", kind: "var", required: false },
  { name: "MOSS_HOOKS_HOST", kind: "var", required: false },
  { name: "MOSS_HANDSHAKE_HOST", kind: "var", required: false },
  { name: "MOSS_PUSH_HOST", kind: "var", required: false },
  { name: "MOSS_WEB_HOST", kind: "var", required: false },
  // The sign-in project (accounts)
  { name: "MOSS_SUPABASE_URL", kind: "var", required: true },
  { name: "MOSS_SUPABASE_ANON_KEY", kind: "var", required: true },
  { name: "MOSS_SIGNING_JWKS", kind: "secret", required: true, generate: "signing-jwks" },
  // Webhook forwarder
  { name: "MOSS_TAG_KEYS", kind: "secret", required: true, generate: "tag-keys" },
  { name: "MOSS_ACCOUNT_ID_KEY", kind: "secret", required: true, generate: "random" },
  { name: "MOSS_FORWARDER_TICKET_SECRET", kind: "secret", required: true, generate: "random" },
  // Handshake
  { name: "MOSS_HANDSHAKE_TICKET_SECRET", kind: "secret", required: true, generate: "random" },
  // Push
  { name: "MOSS_APNS_KEY_ID", kind: "var", required: true },
  { name: "MOSS_APNS_TEAM_ID", kind: "var", required: true },
  { name: "MOSS_APNS_TOPIC_MOSS", kind: "var", required: true },
  { name: "MOSS_APNS_TOPIC_CODE", kind: "var", required: true },
  { name: "MOSS_APNS_PRIVATE_KEY", kind: "secret", required: true },
  { name: "MOSS_VAPID_SUBJECT", kind: "var", required: false },
  { name: "MOSS_VAPID_PUBLIC_KEY", kind: "var", required: true, generate: "vapid" },
  { name: "MOSS_VAPID_PRIVATE_KEY", kind: "secret", required: true, generate: "vapid" },
  // The relay (the owner's own Cloudflare account; not part of the default deploy)
  { name: "MOSS_RELAY_ORIGIN", kind: "var", required: false },
  { name: "MOSS_RELAY_KEY", kind: "secret", required: false, generate: "random" },
];

/** What wrangler reads for a real deploy, and the script needs only then. Never in the template file. */
export const CLOUDFLARE_CREDENTIALS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"] as const;

export type ServiceId = "accounts" | "handshake" | "push" | "forwarder" | "web" | "relay";

export interface Settings {
  domain: string;
  hosts: { accounts: string; hooks: string; handshake: string; push: string; web: string };
  /** `https://<domain>/auth`, or `https://<accounts host>` when MOSS_ACCOUNTS_HOST is set. */
  issuer: string;
  accountsPrefix: string;
  jwksUrl: string;
  env: Readonly<Record<string, string | undefined>>;
}

export interface Route {
  pattern: string;
  zone_name?: string;
  custom_domain?: boolean;
}

export interface SecretSpec {
  /** The Worker's own name for it (services/<id>/src/env.ts). */
  remote: string;
  /** The environment name the owner sets. */
  env: string;
  required: boolean;
}

export interface ServiceSpec {
  id: ServiceId;
  dir: string;
  /** `env.production.name` in its wrangler.jsonc. */
  worker: string;
  summary: string;
  /** `default`: part of the owner's deploy. `own-account`: each user runs it in their own Cloudflare account, so the owner's deploy leaves it out unless named with --only. */
  group: "default" | "own-account";
  /** Services that must be deployed before this one, and why. */
  after: readonly ServiceId[];
  why: string;
  secrets: readonly SecretSpec[];
  /** The values that come from the owner's settings, over the production profile's. */
  vars(s: Settings): Record<string, string>;
  routes(s: Settings): Route[];
  /** The page is built first (web only). */
  build?: { command: readonly string[]; outDir: string };
  /** How a deployed one is checked from outside, no account needed. */
  smoke: SmokeSpec;
}

export type SmokeSpec =
  | { kind: "jwks"; path: string }
  | { kind: "config-json"; path: string }
  | { kind: "vapid"; path: string }
  | { kind: "worker-refusal"; path: string };

const secret = (remote: string, env: string, required = true): SecretSpec => ({ remote, env, required });
const https = (host: string) => `https://${host}`;

export const SERVICES: readonly ServiceSpec[] = [
  {
    id: "accounts",
    dir: "services/accounts",
    worker: "clover-accounts",
    summary: "account sign-in sessions in, short account tokens out; each account's device list; publishes the keys the other Workers check tokens against",
    group: "default",
    after: [],
    why: "the others hold a service binding to it (Cloudflare refuses a binding to a Worker that does not exist) and read its keys at their first request",
    secrets: [secret("SIGNING_JWKS", "MOSS_SIGNING_JWKS")],
    vars: (s) => ({
      ISSUER: s.issuer,
      PATH_PREFIX: s.accountsPrefix,
      AUTH_URL: s.env.MOSS_SUPABASE_URL ?? "",
      AUTH_ANON_KEY: s.env.MOSS_SUPABASE_ANON_KEY ?? "",
      AUDIENCES: [s.hosts.hooks, s.hosts.push, s.hosts.handshake].join(","),
    }),
    routes: (s) =>
      s.accountsPrefix === ""
        ? [{ pattern: s.hosts.accounts, custom_domain: true }]
        : [{ pattern: `${s.hosts.accounts}${s.accountsPrefix}/*`, zone_name: s.domain }],
    smoke: { kind: "jwks", path: "/.well-known/jwks.json" },
  },
  {
    id: "handshake",
    dir: "services/handshake",
    worker: "clover-handshake",
    summary: "introduces two devices to each other (pairing, the short code, dial-now, WebRTC signalling, all sealed between them) and holds the main computer's lease",
    group: "default",
    after: ["accounts"],
    why: "binds to the accounts Worker for its keys",
    secrets: [secret("TICKET_SECRET", "MOSS_HANDSHAKE_TICKET_SECRET")],
    vars: (s) => ({
      ACCOUNT_ISSUER: s.issuer,
      ACCOUNT_JWKS_URL: s.jwksUrl,
      HANDSHAKE_AUDIENCE: s.hosts.handshake,
      HANDSHAKE_ORIGIN: https(s.hosts.handshake),
      WEB_ORIGINS: https(s.hosts.web),
    }),
    routes: (s) => [{ pattern: s.hosts.handshake, custom_domain: true }],
    smoke: { kind: "worker-refusal", path: "/v1/none" },
  },
  {
    id: "push",
    dir: "services/push",
    worker: "clover-push",
    summary: "the content-free push: an empty \"you have N updates\" to the account's phones (APNs) and browsers (Web Push); never sees what happened",
    group: "default",
    after: ["accounts"],
    why: "binds to the accounts Worker for its keys",
    secrets: [secret("APNS_PRIVATE_KEY", "MOSS_APNS_PRIVATE_KEY"), secret("VAPID_PRIVATE_KEY", "MOSS_VAPID_PRIVATE_KEY")],
    vars: (s) => ({
      ACCOUNT_ISSUER: s.issuer,
      ACCOUNT_JWKS_URL: s.jwksUrl,
      PUSH_AUDIENCE: s.hosts.push,
      APNS_KEY_ID: s.env.MOSS_APNS_KEY_ID ?? "",
      APNS_TEAM_ID: s.env.MOSS_APNS_TEAM_ID ?? "",
      APNS_TOPIC_MOSS: s.env.MOSS_APNS_TOPIC_MOSS ?? "",
      APNS_TOPIC_CODE: s.env.MOSS_APNS_TOPIC_CODE ?? "",
      VAPID_SUBJECT: s.env.MOSS_VAPID_SUBJECT || `mailto:push@${s.domain}`,
      VAPID_PUBLIC_KEY: s.env.MOSS_VAPID_PUBLIC_KEY ?? "",
    }),
    routes: (s) => [{ pattern: s.hosts.push, custom_domain: true }],
    smoke: { kind: "vapid", path: "/v1/vapid" },
  },
  {
    id: "forwarder",
    dir: "services/forwarder",
    worker: "clover-forwarder",
    summary: "takes routines' webhooks, seals them to the account's computers on arrival and holds them (7 days) until the routine's computer fetches them",
    group: "default",
    after: ["accounts"],
    why: "binds to the accounts Worker for its keys",
    secrets: [
      secret("TAG_KEYS", "MOSS_TAG_KEYS"),
      secret("ACCOUNT_ID_KEY", "MOSS_ACCOUNT_ID_KEY"),
      secret("TICKET_SECRET", "MOSS_FORWARDER_TICKET_SECRET"),
    ],
    vars: (s) => ({
      ACCOUNT_ISSUER: s.issuer,
      ACCOUNT_JWKS_URL: s.jwksUrl,
      HOOKS_AUDIENCE: s.hosts.hooks,
      HOOKS_ORIGIN: https(s.hosts.hooks),
    }),
    routes: (s) => [{ pattern: s.hosts.hooks, custom_domain: true }],
    smoke: { kind: "worker-refusal", path: "/v1/none" },
  },
  {
    id: "web",
    dir: "services/web",
    worker: "clover-web",
    summary: "the web companion's page (a browser pairs with a computer through the handshake, then talks to it over WebRTC)",
    group: "default",
    after: ["handshake"],
    why: "its /config.json points at the handshake, and the handshake's WEB_ORIGINS names this host; deploying it last means the page never goes live pointing at nothing",
    secrets: [],
    vars: (s) => ({ HANDSHAKE_ORIGIN: https(s.hosts.handshake) }),
    routes: (s) => [{ pattern: s.hosts.web, custom_domain: true }],
    build: { command: ["bun", "scripts/build.ts"], outDir: "dist" },
    smoke: { kind: "config-json", path: "/config.json" },
  },
  {
    id: "relay",
    dir: "services/relay",
    worker: "clover-relay",
    summary: "the user's own relay: carries a link's end-to-end encrypted frames between two of their devices and keeps sealed sync mail for an away one",
    group: "own-account",
    after: [],
    why: "stands alone",
    secrets: [secret("RELAY_KEY", "MOSS_RELAY_KEY")],
    vars: (s) => ({ RELAY_ORIGIN: s.env.MOSS_RELAY_ORIGIN ?? "" }),
    routes: () => [],
    smoke: { kind: "worker-refusal", path: "/v1/none" },
  },
];

export function serviceById(id: string): ServiceSpec | undefined {
  return SERVICES.find((s) => s.id === id);
}

/** The addresses the engine and the bundled plugins have built in today (a release build ignores the environment, so a
 *  deploy under another domain needs a rebuild). services-deploy.test.ts reads each source file and fails when one differs. */
export const BUILT_IN_ADDRESSES = {
  accounts: { url: "https://waifucave.com/auth", file: "packages/core/src/identity/account-config.ts" },
  hooks: { url: "https://hooks.waifucave.com", file: "packages/core/src/devices/account-devices.ts" },
  push: { url: "https://push.waifucave.com", file: "packages/core/src/devices/account-devices.ts" },
  handshake: { url: "https://handshake.waifucave.com", file: "packages/core/src/devices/account-devices.ts" },
  web: { url: "https://clover.waifucave.com", file: "plugins/moss/plugins/companion-web/host/index.ts" },
} as const;

/** The plugins that stay "not yet" in the product until a service exists (docs/devices-map.md has the same table). */
export const PARKED_PLUGINS: readonly { plugin: string; reason: string; needs: readonly ServiceId[]; stillNeeds: string }[] = [
  { plugin: "push", reason: "push-origin", needs: ["accounts", "push"], stillNeeds: "the push keys from Apple (and a phone app to receive them); then its `availability` line comes out of plugins/moss/plugins/push/moss.json" },
  { plugin: "companion-web", reason: "pairing-registry", needs: ["accounts", "handshake", "web"], stillNeeds: "its `availability` line comes out of moss.json once pairing through the handshake has been checked live" },
  { plugin: "companion-ios", reason: "pairing-registry", needs: ["accounts", "handshake"], stillNeeds: "the iPhone app (not in the first build, spec §10) and the same live pairing check" },
  { plugin: "forwarder", reason: "webhook-keys", needs: ["accounts", "forwarder"], stillNeeds: "the key store for webhook signing keys (not a deploy step); trigger-webhook is parked on the same reason" },
  { plugin: "relay-cloudflare", reason: "device-id", needs: ["relay"], stillNeeds: "a host API that gives a plugin this computer's device id (not a deploy step)" },
];
