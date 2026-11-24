# Deploying the services (lane DP, 2026-11-24)

Nothing is deployed. Cloudflare was asked read-only on 2026-11-24 and none of the Workers named below exists on the owner's account, under the old names or any `moss-*` name, so the Workers are named `moss-accounts`, `moss-handshake`, `moss-push`, `moss-forwarder`, `moss-web`, `moss-relay` (and `moss-hello`, which is never deployed). The signature, key and header tags in the wire code (the account and handshake statements, the authorization header, the box label) keep their old spellings: no service verifies them, but data already on the owner's disk was made under them and the residue test pins them.

The small services phones and other devices need live under `services/`. They are built and tested and have never been deployed. This page
says what each is, what it takes to deploy it, and how the owner does it with one command. Nothing here deploys anything: the script's
only mode that runs without the owner's own flag is a dry run, and the dry run touches no account. The contract is `docs/moss-spec.md` §8
(accounts, links, relays, the web companion) and §10 (the content-free push).

## The one command

```sh
install -m 600 services/deploy.env.example ~/moss-services.env   # mode 600, outside the repo; fill it in (it will hold keys)
scripts/pinned-bun scripts/services/deploy.ts --generate all --out ~/moss-generated.env   # fresh values for the secrets we make up: a NEW mode-600 file, only the names are printed
#   merge those lines into ~/moss-services.env, keep a copy of it somewhere safe, then delete ~/moss-generated.env
scripts/pinned-bun scripts/services/deploy.ts --env-file ~/moss-services.env                  # the dry run: checks, builds, packages, prints the plan
scripts/pinned-bun scripts/services/deploy.ts --env-file ~/moss-services.env --deploy         # the real thing: shows the plan, asks you to type "deploy <last 4 of the account id>"
scripts/pinned-bun scripts/services/post-deploy.ts --env-file ~/moss-services.env --smoke     # the settings to apply, and a live check
```

The Cloudflare token and account id go in the same env file (the two `CLOUDFLARE_` lines at its top), never on a command line: a value typed
inline lands in the shell's history. The script refuses an env file that group or others can read (`chmod 600` it), one owned by someone else, and one in a folder
that group or others can write to; keep it in your home folder (mode 700) and check `ls -le ~/moss-services.env` shows no ACL lines (a mode-bit
check cannot see them). A dry run never passes the Cloudflare lines to wrangler.

- **Secrets are put once.** A real deploy first reads each Worker's secret NAMES from Cloudflare (read-only), then deploys the code and only the
  secrets that Worker lacks in one wrangler call (`--secrets-file`, read from standard input), so a Worker is never live without them and a re-run
  never re-puts a secret already there, whatever the env file holds now. `--rotate MOSS_TAG_KEYS,...` replaces the named ones.
  `MOSS_ACCOUNT_ID_KEY` names each account's object: a new value orphans every account's held webhooks for good, so replacing it needs
  `--rotate MOSS_ACCOUNT_ID_KEY --rotate-account-id-key` and prints a warning.
- **Each deploy is checked.** After a Worker's deploy the script reads its secret names again and stops if one it was to put is not there.
- **A failure stops everything at once** and says what was already deployed; run the same command again after fixing it.
- `--only accounts,push` deploys part; `--skip-secrets` redeploys code only; `--strict` makes the dry run fail while a required name is unset.
- **Wrangler's debug log** is pointed at a mode-700 folder this script removes at the end, so nothing of a real run stays under your home. Whether that log
  would have held a secret's value is not known: after the first live run, search wrangler's own log folder (`~/Library/Preferences/.wrangler/logs`,
  or `~/.wrangler/logs` / `$XDG_CONFIG_HOME/.wrangler/logs`) for the first characters of one secret, and delete anything that matches.

## What is deployed, in this order, and why

| # | Service | Worker | Where | Why here |
|---|---|---|---|---|
| 1 | `services/accounts` | `moss-<service>` | `<domain>/auth/*` (or a host of its own) | the others bind to it (Cloudflare refuses a service binding to a Worker that does not exist) and fetch its public keys on their first request |
| 2 | `services/handshake` | `moss-<service>` | `handshake.<domain>` | after accounts |
| 3 | `services/push` | `moss-<service>` | `push.<domain>` | after accounts |
| 4 | `services/forwarder` | `moss-<service>` | `hooks.<domain>` | after accounts |
| 5 | `services/web` | `moss-<service>` | `app.moss.<domain>` (a placeholder host; the owner picks the final one; it is set in `services/web/wrangler.jsonc` and in the companion-web plugin's `DEFAULT_WEB`, and a test fails if they differ) | after the handshake: its `/config.json` points at it (the handshake's `WEB_ORIGINS` names this host, which does not need to exist yet) |
| - | `services/relay` | `moss-<service>` | the user's own `workers.dev` address | NOT in the owner's deploy: each user runs it in their own Cloudflare account (spec §8.3); `--only relay` with `MOSS_RELAY_ORIGIN` and `MOSS_RELAY_KEY` |
| - | `services/hello` | `moss-<service>` | never | the layout's example and the emulator's smoke test |

`services/shared` is not a Worker: the Workers bundle it.

## Inventory (from each service's `wrangler.jsonc` and `src/env.ts`)

All are Cloudflare Workers (`compatibility_date` 2026-10-01), SQLite-backed Durable Objects, `observability` off, and rate limits through the
`ratelimits` binding (per Cloudflare location). The committed `wrangler.jsonc` has a local profile at the top level (tests, emulators) and an
`env.production` profile; the deploy script renders `env.production` flat, with the owner's names over it, into its output folder and gives wrangler that file.
It never edits the committed ones.

| Service | One line | Durable Objects | Variables (by name) | Secrets | Bindings besides |
|---|---|---|---|---|---|
| accounts | account sign-in sessions in, short account tokens out; each account's device list; publishes the keys the others check tokens against | `AccountDO` (`ACCOUNTS`), `KeysDO` (`KEYS`, local keys only) | `ISSUER`, `PATH_PREFIX`, `AUTH_URL`, `AUTH_ANON_KEY`, `AUDIENCES`, `TOKEN_TTL?`; local profile only: `EPHEMERAL_KEYS`, `DEV_MINT` (never in production) | `SIGNING_JWKS` | rate limits `ADDRESS_RATE`, `API_RATE` |
| handshake | introduces devices to each other (pair, short code, dial-now, WebRTC signalling, all sealed between them), holds the main computer's lease | `HandshakeDO`, `RendezvousDO` | `ACCOUNT_ISSUER`, `ACCOUNT_JWKS_URL`, `HANDSHAKE_AUDIENCE`, `HANDSHAKE_ORIGIN`, `WEB_ORIGINS` | `TICKET_SECRET` | service binding `ACCOUNT_SERVICE` to the accounts Worker; `REGISTER_RATE`, `API_RATE`, `ADDRESS_RATE` |
| push | the content-free "you have N updates" push to phones (APNs) and browsers (Web Push) | `PushDO` | `ACCOUNT_ISSUER`, `ACCOUNT_JWKS_URL`, `PUSH_AUDIENCE`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC_MOSS`, `APNS_TOPIC_CODE`, `APNS_PRODUCTION_ORIGIN`, `APNS_SANDBOX_ORIGIN`, `VAPID_SUBJECT`, `VAPID_PUBLIC_KEY`, `WEBPUSH_HOSTS`, `MAX_TARGETS` | `APNS_PRIVATE_KEY`, `VAPID_PRIVATE_KEY` | service binding `ACCOUNT_SERVICE`; `NOTIFY_RATE`, `API_RATE` |
| forwarder | takes routines' webhooks, seals them to the account's computers, holds them 7 days | `ForwarderDO` | `ACCOUNT_ISSUER`, `ACCOUNT_JWKS_URL`, `HOOKS_AUDIENCE`, `HOOKS_ORIGIN`, `HOLD_DAYS` and the `MAX_*` limits | `TAG_KEYS`, `ACCOUNT_ID_KEY`, `TICKET_SECRET` | service binding `ACCOUNT_SERVICE`; `HOOK_RATE`, `API_RATE`, `TAG_RATE`, `CHECK_RATE` |
| web | the web companion's page and its `/config.json` | none | `HANDSHAKE_ORIGIN`, `ALLOWED_HANDSHAKES` | none | static assets (`dist/`, built by `bun scripts/build.ts` first) |
| relay | the user's own relay (rooms for encrypted frames, mailboxes for sealed sync mail) | `RoomDO`, `MailboxDO` | `RELAY_ORIGIN`, `TICKET_HOURS` | `RELAY_KEY` | `CONNECT_RATE`, `API_RATE` |

The names the owner supplies are exactly the `MOSS_*` names in `services/deploy.env.example`; `scripts/services/manifest.ts` maps each to the Worker variable or secret
it becomes. `scripts/services/services-deploy.test.ts` fails when the template, the manifest, a `wrangler.jsonc` or an `Env` interface stop agreeing (a new required variable added to a
Worker without a line in the manifest fails it).

## What points at them today

| In the product | Points at | Through |
|---|---|---|
| the engine's account client | accounts (`https://waifucave.com/auth`), handshake | `PRODUCTION_ACCOUNT_SERVICE` in `packages/core/src/identity/account-config.ts` and `WAIFUCAVE_DEVICE_SERVICES` in `packages/core/src/devices/account-devices.ts`, built in. A release build ignores `MOSS_ACCOUNT_*` and `MOSS_HANDSHAKE_URL` (dev and test builds take them). The sign-in project's `authUrl` and `anonKey` come from `<home>/account.json`. |
| `plugins/moss/plugins/push` | push | `DEFAULT_ORIGIN` in its `host/index.ts`, capability `network:push.waifucave.com`; parked `not-yet`, reason `push-origin` |
| `plugins/moss/plugins/forwarder` (and `trigger-webhook`) | forwarder | `DEFAULT_ORIGIN`, `network:hooks.waifucave.com`; parked, reason `webhook-keys` |
| `plugins/moss/plugins/companion-web` | handshake, web | `DEFAULT_HANDSHAKE`, `DEFAULT_WEB`; parked, reason `pairing-registry` |
| `plugins/moss/plugins/companion-ios` | handshake | through the engine; parked, reason `pairing-registry` |
| `plugins/moss/plugins/relay-cloudflare` | the user's relay | its `origin` setting and `relay-key` secret; parked, reason `device-id` |
| the routine engine | forwarder's webhook base | `packages/core/src/routines/engine.ts` |

Everything above stays switched off in the product until the service exists (`docs/devices-map.md` has the same table with what else lifts each one).
Deploying alone does not flip a plugin: `availability` is a line in each `moss.json`, taken out in a release once the live check passes.

## What the dry run proves, and what only a real deploy can

The dry run proves: every name the Workers read is covered by the template and the manifest; the owner's names render into complete configurations
(routes, variables, bindings, migrations); each Worker bundles and wrangler accepts its configuration (`wrangler deploy --dry-run`, no login, no network);
the web page builds; the order is consistent. It runs in CI (non-gating, `.github/workflows/services-dry-run.yml`).

Only a real deploy can show: that the API token has the right scopes; that the zone is on the account, that Cloudflare issues a certificate for the third-level host `app.moss.<domain>` (to confirm on the first live run; a host one level up, such as `app.<domain>`, is the fallback), and the custom domains and the `/auth/*` route attach; that the service binding
resolves; that the Supabase project accepts the anon key; that Apple accepts the APNs key, team and topics; the first real pairing and push. `post-deploy.ts --smoke` checks what can be checked
without an account (accounts' public keys, which must carry no private part; the web page's config pointing at the deployed handshake; push serving its VAPID key; the others answering an unknown path with their own JSON refusal rather than Cloudflare's error page).

## What the owner must supply

1. A Cloudflare account, and a domain whose DNS is on it (a zone). An API token and the account id. The scopes the token needs are TO CONFIRM ON THE FIRST LIVE RUN: expected are Account > Workers Scripts: Edit, Zone > Workers Routes: Edit (the `/auth/*` route), Zone > DNS: Edit and Zone > Zone: Read (custom domains), and Account > Account Settings: Read for the secret lists; create the token with exactly those and add whichever the first run names as missing. Workers' SQLite Durable Objects, rate limits and custom domains exist on the Free plan to the best of my reading; check Cloudflare's current plan limits before the first deploy. Domain: whatever the registrar charges.
2. A Supabase project (the sign-in: the accounts Worker asks it who a session belongs to): its URL and its public anon key. Its free tier is enough to start. (Sign-in providers and email templates are set up inside it.)
3. For phone push: an Apple Developer Program membership (paid, per year) and an APNs auth key (.p8) with its key id and team id, and the two iPhone apps' bundle ids (MOSS's and MOSS Code's). Web Push needs nothing from anyone: `--generate all` makes the pair.
4. Later, for Android: a Firebase project. `services/push/src/fcm.ts` is a stub today (`fcmConfig` returns null, a registration is refused `not_configured`), so FCM needs code as well as a project.
5. The secrets the script makes for him: `--generate` for the signing keys, tag keys, account-id key and the two ticket secrets. He keeps them; the account-id key must never be lost.

After it he can: sign in once and see one account on two computers; pair a computer by a short code over the internet (the handshake), and a browser through the web companion; have routines' webhooks held while a computer is away
(once `webhook-keys` is done); and, with the iPhone app and Apple's key, get a content-free push. Pairing a phone over the internet also needs the iPhone app (not in the first build, spec §10); that part and the plugins' `not-yet` lines are the product's work, listed against each plugin above.

## What would not work as written

- **Another domain needs a rebuild.** The addresses and the token audiences (`hooks.waifucave.com`, `push.waifucave.com`, `handshake.waifucave.com`) are built into the engine and the plugins, and a release build ignores the environment on purpose. The templated hosts default to the same names under the owner's domain; `post-deploy.ts` prints the files to change if the domain differs from the built-in one. Nothing was changed in the engine for this lane.
- **No health endpoint exists** in any Worker. The smoke check uses what exists (public keys, `/config.json`, `/v1/vapid`, a JSON 4xx refusal). A `GET /healthz` in each Worker would be cleaner; it changes six Workers and their tests, so it was left out.
- **The `<domain>/auth/*` route** needs the apex name to have a proxied (orange-cloud) DNS record in the zone, or requests never reach the Worker. `MOSS_ACCOUNTS_HOST` gives accounts a host of its own as a custom domain instead (which Cloudflare creates the record for), but then the engine's built-in issuer differs.
- The committed `env.production` profiles name `waifucave.com` as a default and leave `AUTH_URL`, `APNS_*` and `VAPID_PUBLIC_KEY` empty; the deploy script overrides all of them, and a test fails if a rendered configuration still names `waifucave`.
