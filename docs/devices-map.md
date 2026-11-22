# Devices and computers: the map (lane DV, 2026-11-22)

What exists for spec §8 and §9.1 (C4 Devices, C5 Computers), what proves it today, and what stands between it and two real
computers. "Live check" means only a person with two machines can show it.

## Pairing without an account (§8.1)
- Exists: `PairingService` (begin, join, confirm, cancel, four-word check), the engine's sealed card for the add and the removal
  (`devices/rpc.ts`), the QR payload with direct addresses, the short code through the handshake service.
- Proven: `packages/core/test/daemon-two-engines-pairing.test.ts` (two `startDaemon`s on two temp homes over one in-memory network:
  begin, join, same four words, confirm on both, the add held until the sealed card is approved, both lists, the removal's card);
  `devices/tests/rpc.test.ts`; both Settings pages (`plugins/moss/plugins/settings/test/entry.test.tsx`, `apps/moss/test/ma2-pages.test.tsx`).
- Between it and two real computers: the link sidecar binary (`native/link`, a cargo build; CI's link job builds it) running on
  both; a live check that a QR scanned on machine B reaches machine A over a real network. The short code needs the handshake
  service deployed (`services/handshake`: a Cloudflare account, its route, no keys beyond the account's own).

## Relays (§8.3)
- Exists now: the choice (`device.relay.get` / `device.relay.set`, `settings.links.relay`, the sidecar restarts on the new relay),
  the setup guide's relay page in both apps. n0's public relays are the default; a person's own `https://` server; none.
- Between it and working: live check that a pair behind two NATs connects through n0's relays; `services/relay` (Cloudflare, not
  deployed) is what the not-yet Cloudflare relay plugin would use.

## Account sign-in (§8.2) and the sign-in project
- `account-config.ts` reads `authUrl` and `anonKey` from `<home>/account.json` (or env in dev builds). The values are the owner's
  to supply; none is committed. `services/accounts` is the service behind it (not deployed).

## The eight not-available plugins (the reason in each `moss.json` `availability`, and what lifts it)
| Plugin | Reason | What lifts it |
|---|---|---|
| forwarder, trigger-webhook | `webhook-keys` | the key store for webhook signing keys and `services/forwarder` deployed (account, domain, route) |
| push | `push-origin` | `services/push` deployed and its public origin put in the build; push keys from the provider |
| companion-ios, companion-web | `pairing-registry` | the phone and web apps pairing through `services/handshake` plus `services/web` deployed |
| relay-cloudflare | `device-id` | a host API giving a plugin this computer's device id, and `services/relay` deployed |
| provider-gcp, provider-hetzner | `cloud-computers` | the cloud computer host API and each provider's account and API key (the owner's) |

## Owner's ordered list (what to deploy, supply or check by hand)
1. Build the link sidecar (`cargo build --release` in `native/link`) on two Macs. Working: `moss-link` starts, two engines list each other after pairing by QR.
2. Pair two real computers by QR from Settings (either app): the card appears on each, the same four words show, both lists show both. Remove one: its card asks first.
3. Deploy `services/handshake` (Cloudflare account, route) for the short code. Working: a short code from machine A joins on B with no QR.
4. Supply the sign-in project's URL and key (`<home>/account.json`), then deploy `services/accounts`. Working: sign-in on two machines shows one account.
5. Deploy `services/relay`, `services/push`, `services/forwarder`, `services/web` as each plugin above is wanted.
6. Live check: with the relay page set to n0's relays, a pair across two networks connects; set to none, it connects only directly.

## For the reviewer: who holds `devices.manage`, and what `pairing_changed` carries
- Held by one bundled plugin: `plugins/moss/plugins/settings/moss.json` (the Settings part). No other bundled plugin asks for it.
- A third-party plugin may ask for it (catalog entry in `packages/plugin-sdk/src/catalogs/capabilities.ts`, `warns: true`). Its OK card
  then says it "pairs and removes your devices when you press its controls (each still asks on MOSS's own card)". Holding it lets a
  part (a) call `device.pair.begin/join/confirm/cancel` and `device.revoke` through the door, only on the user's own press, and
  (b) hear `pairing_changed` (code, the four words, steps). It never adds or removes a device by itself: the engine raises the sealed
  card for the add and the removal, and only the user's answer in the card's frame applies it. A plugin holding it can read the four
  words of a pairing the user began in its frame; that is the exposure the OK card names.
- Where in the diff: `packages/protocol/src/devices.ts` (`pairing_changed` roles and `capability`), `apps/desktop/src/main/ui/tree-calls.ts`
  (`DEVICES_MANAGE`), `packages/plugin-sdk/src/catalogs/capabilities.ts`.
- The two-engine proof is `packages/core/test/daemon-two-engines-pairing.test.ts`; `packages/core/test/*.ts` runs in the core jobs
  (macOS shards and `core-linux`), the file has no platform marker.
