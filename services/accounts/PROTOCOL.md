# waifucave's account service, wire format v1

The account service keeps each waifucave account's device list and mints the account tokens that waifucave's other services check: the hooks forwarder, push and the handshake (spec §8.1, "the account is the root of trust"). Signing in itself is waifucave's Supabase project, with email, Discord and Google. This service takes a Supabase session and answers for the devices of that account.

The wire is lane H's proposal (the core's `identity/account.ts`, which `AccountClient` speaks), built here with the additions marked below. This file is the contract between the service (lane I, `services/accounts/`) and the core (lane H). Change it only together.

## Where it lives

- Production: `https://waifucave.com/auth` (`PATH_PREFIX` `/auth`), the issuer the other services' production profiles name. The paths below follow the prefix. A host of its own works too, with `PATH_PREFIX` empty and `ISSUER` set to match.
- The local profile (`wrangler.jsonc`'s top level) is what the tests and emulators run. It adds two things production never has:
  - keys made in memory (`EPHEMERAL_KEYS`);
  - `POST /dev/token`, a mint without a sign-in (`DEV_MINT`), for emulator tests that need a token and no account. It opens only beside the in-memory keys and never when `SIGNING_JWKS` is set, signs only with the in-memory keys, and mints at most 5 minutes.

## Calls

| Request | Body | Answer |
| :- | :- | :- |
| `GET /.well-known/jwks.json` | | `{"keys":[…]}`, the public halves of the signing keys, cached for 5 minutes |
| `POST /v1/devices` | `{"device": {"id","publicKey","boxKey","name","kind","os"?}, "t", "sig"}` | 201 `{"device"}`, or 200 `{"device"}` when the device was already listed (its fields updated) |
| `GET /v1/devices` | | `{"devices":[…]}`: every device of the account, the revoked ones with `revokedAt` |
| `DELETE /v1/devices/<id>` | | 204, again 204; 404 for a device the account never had |
| `POST /v1/tokens` | `{"aud","dev","t","sig"}` | `{"token","expiresAt"}` |
| `POST /v1/devices/leave` | `{"dev","t","sig"}` | 204: the device's row is gone (again: 204) |
| `POST /v1/account/delete` | `{"dev","t","sig"}` | 200 `{"deletion":{"deletedAt","pending":[…]}}` |

Every `/v1` call takes the Supabase access token as `Authorization: Bearer`. The service asks the project who it belongs to (`GET <project>/auth/v1/user`, with the project's public key as `apikey`), so a signed-out session is refused as soon as Supabase refuses it. An anonymous Supabase sign-in is not an account.

A device's record:

```json
{"id": "<32 base32 characters>", "publicKey": "<Ed25519 link key, standard base64>", "boxKey": "<X25519 key, base64url>",
 "name": "Studio", "kind": "desktop", "os": "macos", "addedAt": 1793000000123, "revokedAt": 1793000500000}
```

- `id` is lane B's `deviceIdFor(publicKey)`: lowercase base32 of the first 20 bytes of SHA-256 over the key. Any other id is 400 `bad_device_id`.
- `publicKey` may be sent as standard base64 (as the core's `DeviceKey` gives it) or base64url; it is kept and listed as standard base64.
- `boxKey` is 32 bytes. It is the key the handshake's account-scope boxes are sealed to (`services/handshake/PROTOCOL.md`, "Boxes").
- `name` is 1–64 code points with no control characters. `kind` is the protocol's `DeviceKind` (`desktop`, `server`, `cloud`, `phone`, `browser`) and `os` its `Os` (`macos`, `windows`, `linux`).

## Statements

A registration and a mint are signed by the device's link key, Ed25519. `sig` is base64url, and `t` is the device's clock in milliseconds.

A registration signs lane H's `clover-account-v2 register` statement: the deterministic CBOR (the core's `links/codec`: shortest heads, definite lengths) of the array

```
["clover-account-v2 register", <account: the Supabase user id>, id, publicKey, boxKey, name, kind, os or null, t]
```

with each device field exactly as the request carries it (`publicKey` in whichever base64 it was sent) and `t` a CBOR unsigned integer. It covers the whole record, so a session holder can't re-send a device's signature with another box key, name or kind.

A leave and the account's deletion sign their own statements, deterministic CBOR like a registration's, each with its own purpose tag so no other statement's signature passes as one:

```
["moss-account-v1 leave",  <account>, <device id>, t]
["moss-account-v1 delete", <account>, <device id>, t]
```

A mint signs UTF-8 lines joined by `\n`:

```
clover-account-v1 mint
<account: the Supabase user id>
<aud>
<device id>
<t>
```

- `t` must be within 10 minutes of the service's clock (400 `bad_time` otherwise).
- **Replay protection** (an addition to H's proposal): a registration's `t` must be newer than the last one that device registered with, and a mint's `t` newer than the last one it minted with for that audience. Otherwise the answer is 409 `replay`. A refused call spends nothing.
- Both statements name the account, so a device's statement registers it or mints for it in that account alone.

## Tokens

The token is a JWS (compact JWT), signed EdDSA or ES256 under a key of the JWKS:

```json
{"alg": "EdDSA", "kid": "…", "typ": "JWT"}
{"iss": "https://waifucave.com/auth", "aud": "push.waifucave.com", "sub": "<account>", "dev": "<device id>",
 "iat": 1793000000, "exp": 1793000300, "jti": "…"}
```

- It lives 5 minutes (`TOKEN_TTL` may shorten it), and `expiresAt` is `exp` in milliseconds. The core refuses any token that would live longer (`ACCOUNT_TOKEN_MAX_MS`).
- `aud` is one service, from `AUDIENCES`: `hooks.waifucave.com`, `push.waifucave.com` or `handshake.waifucave.com`. Anything else is 400 `bad_audience`.
- Only a listed device that isn't revoked gets one (403 `not_member`), and only with its own key's signature (403 `bad_signature`).
- The services check it offline (`services/shared/account-token.ts`), against this JWKS fetched and cached (`services/shared/jwks.ts`), and refuse a token that lives longer than 5 minutes plus a minute's skew. In production they fetch it through a service binding to this Worker (`ACCOUNT_SERVICE`), since a Worker can't fetch another Worker's route on its own zone; the URL is the fallback.

**Keys.** In production they are `SIGNING_JWKS`, a secret: private JWKs with `kid`s. The first signs and every one is published. A rotation adds the new key first and drops the old one once its tokens have ended. A set with a key that doesn't import is refused whole (503 `not_configured`), and so is a production service without the secret. It never makes keys of its own.

## Revocation

- `DELETE /v1/devices/<id>` revokes a device of the account, taken from any of the account's sessions. The device stays listed with `revokedAt` for 30 days, so every other device learns of it at its next sync. After that its row is cut to its id and the time: its name, keys, kind and system are deleted, and it is no longer listed. A device of the account whose local registry still has a device the list no longer names (`via: "account"`) drops it (the core's `syncAccountDevices`).
- Why the id stays: a revoked device may still hold a working Supabase session (the project's refresh tokens don't end on their own), and the id is what refuses its key if it tries to register again. At most 1,024 ids are kept per account, the oldest forgotten first; all of them go with the account.
- A revoked device can't register again (403 `revoked`), and gets no tokens.
- The tokens it already holds end within 5 minutes. The other services hear of the revoke from the revoking device itself (lane H's fan-out: their `DELETE /v1/devices/<id>` calls), not from here.

## Leaving

`POST /v1/devices/leave` is what a device sends when it signs out, before it ends its Supabase session: signed by the device's own link key, with a `t` newer than its last registration's. Its row and its mint records go, so it can register again at its next sign-in (a revoke would refuse it for good). A revoked device can't leave (403 `revoked`): its revoke stays. Leaving again, or a device the account doesn't list, is 204.

## Deleting the account

`POST /v1/account/delete` deletes the account. It takes the account's Supabase session and the signature of a device the account lists and hasn't revoked, over the delete statement, with `t` within 10 minutes: as strong as a mint, the most protected call. What happens, in order:

1. At once: every row of the account here goes (devices, revoked ids, mint records), and a mark refuses every later call of the account with 410 `account_deleted` (list, register, mint, revoke, leave). No device can get a token from then on.
2. The account service tells each other service to forget the account, with an **erase token** it mints for itself: `sub` the account, `dev` `account-erase`, `erase: true`, 5 minutes. A service takes an erase token on its account wipe alone, and refuses it everywhere else; a device's own token is refused there.
   - the hooks forwarder: `DELETE /v1/account` (its computers' keys and names, routines, held webhooks; sockets closed);
   - push: `DELETE /v1/account` (every phone and browser target, the revocations);
   - the handshake: `DELETE /v1/accounts/self` (the account scope's sealed records, waiting messages, the lease).
   Each keeps only a mark that refuses the account's tokens until the last one minted before the deletion has ended, then forgets the account.
3. Last, once the three have confirmed: the person's sign-in, with the project's service-role key (`AUTH_SERVICE_ROLE_KEY`, a secret): GoTrue's admin delete, `DELETE <AUTH_URL>/auth/v1/admin/users/<account>`. 404 counts as done.
4. When every step is confirmed the account's object forgets everything, the mark included.

A step that fails is retried by the object's alarm (after 1 minute, 10 minutes, an hour, then every 6 hours) until it is confirmed: the deletion finishes without the device that asked. Asking again while it runs answers how far it got (the rows being gone, any session of the account may ask) and tries the pending steps at once. The answer's `pending` names the steps not confirmed yet: `hooks`, `push`, `handshake`, `sign-in`. Until `sign-in` is done the person's Supabase account exists but every call of it here is refused; with no service-role key set it stays pending.

Where the wipes go: the service bindings `HOOKS_SERVICE`, `PUSH_SERVICE` and `HANDSHAKE_SERVICE` when set (production), else `HOOKS_URL`, `PUSH_URL` and `HANDSHAKE_URL`. A service with neither stays pending.

## Limits

- **Per client address** (IPv6 by /64), before Supabase is asked: 120 calls a minute.
- **Per account:** 60 calls a minute.
- Each limit counts per Cloudflare location. Limited calls are 429 `rate_limited` with `retry-after: 60`.
- **Devices** (an addition to H's proposal): an account may list 64 devices that aren't revoked (409 `full` for one more). It keeps at most 256 rows; past that, the device revoked longest ago is forgotten first.
- Bodies are at most 16 KiB.

## Errors

The body is `{"error": "<code>"}`:

| Status | Codes |
| :- | :- |
| 400 | `bad_request`, `bad_device_id`, `bad_time`, `bad_audience` |
| 401 | `unauthorized`: no session, or one Supabase refuses; the client refreshes its session and tries once more |
| 403 | `bad_signature`, `revoked`, `not_member` |
| 410 | `account_deleted`: the account was deleted (or is being deleted); the device signs out |
| 404 | `not_found` |
| 409 | `replay`, `full`, `conflict` (an id already listed with another key) |
| 429 | `rate_limited` |
| 503 | `auth_unavailable` (Supabase can't answer; `retry-after: 30`), `not_configured` |

A bad signature is 403 rather than H's fake's 401, so `AccountClient` doesn't refresh a good session over it.

## Cross-origin

None yet: the web companion's page may reach only the handshake (its CSP). CORS for the page's origin comes with the page's account mode.

## Testing against it

`@waifucave/moss-service-accounts/harness`: `startAccountService({authUrl, anonKey, tokenTtlSeconds?})` runs the service on wrangler's local runtime against a sign-in stack such as lane M's stub. It answers `{url, issuer, jwks, stop}`, the same as the core's `startFakeAccountService`, with a signing key made in memory for the run.
