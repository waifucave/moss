# Devices and computers: the map (lane DV, 2026-11-22)

What exists for spec §8 and §9.1 (C4 Devices, C5 Computers), what proves it today, and what stands between it and two real
computers. "Live check" means only a person with two machines can show it.

## Pairing without an account (§8.1)
- Exists: `PairingService` (begin, join, confirm, cancel, four-word check), the engine's sealed card for the add and the removal
  (`devices/rpc.ts`), the QR payload with direct addresses, the short code through the handshake service. Settings > Devices in both
  desktop apps shows the paired devices (kind, online now or last seen), "Pair a device" (the code, its QR, the time it works until),
  joining by a code, and Remove. The four words are drawn only in the add card's sealed frame on each computer, and in the user's
  own terminal; the engine raises the add card itself when a pairing begun or joined by an app reaches its words step, so no page
  ever holds the words or confirms anything.
- Proven: `packages/core/test/daemon-two-engines-pairing.test.ts` (two `startDaemon`s on two temp homes over one in-memory network:
  begin, join from two apps, the words in the cards and in a terminal's event only, nothing added until both cards are pressed, both
  lists, the removal's card); `packages/core/test/daemon-device-page-boundary.test.ts` (a page holding every capability, handed a key
  press on every call, calling every method its door and the layer's name, with the real and forged words: no device added, no words
  in anything it is handed; the press on the cards pairs; Remove asks on its own card); `devices/tests/rpc.test.ts` (the auto card,
  once; wrong words; a late allow on a cancelled pairing; a removed device's signed answer refused); `test/ipc/core-events.test.ts`
  (words to role cli only); both Settings pages (`plugins/moss/plugins/settings/test/*`, `apps/moss/test/ma2-pages.test.tsx`).
- Between it and two real computers: the link sidecar binary (`native/link`, a cargo build; CI's link job builds it) running on
  both; a live check that a QR scanned on machine B reaches machine A over a real network. The short code needs the handshake
  service deployed (`services/handshake`: a Cloudflare account, its route, no keys beyond the account's own).

## Relays (§8.3)
- Exists now: the choice (`device.relay.get` / `device.relay.set`, `settings.links.relay`, the sidecar restarts on the new relay),
  the setup guide's relay page in both apps and the same choice in MOSS's Settings and the Settings plugin's Devices section. n0's
  public relays are the default; a person's own `https://` server; none. A relay plugin that is installed (`contributes.relays`, shown
  by its `Relay` label) is listed as "not offered": the links take no relay from a plugin, and `RelayView` has no plugin mode.
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
2. Pair two real computers by QR from Settings (either app): the card appears on each by itself, the same four words show on both cards, both lists show both. Remove one: its card asks first.
3. Deploy `services/handshake` (Cloudflare account, route) for the short code. Working: a short code from machine A joins on B with no QR.
4. Supply the sign-in project's URL and key (`<home>/account.json`), then deploy `services/accounts`. Working: sign-in on two machines shows one account.
5. Deploy `services/relay`, `services/push`, `services/forwarder`, `services/web` as each plugin above is wanted.
6. Live check: with the relay page set to n0's relays, a pair across two networks connects; set to none, it connects only directly.

## For the reviewer: who holds `devices.manage`, and what `pairing_changed` carries
- Held by one bundled plugin: `plugins/moss/plugins/settings/moss.json` (the Settings part). No other bundled plugin asks for it.
- A third-party plugin may ask for it (`packages/plugin-sdk/src/catalogs/capabilities.ts`, `warns: true`). Its OK card says it pairs and
  removes your devices when you press its controls, and sees the step of a pairing and the other device's name; never the four words.
- What a holder can do: call `device.pair.begin/join/cancel`, `device.revoke` and `device.relay.get/set` through the door (a press
  each, except `get`), and hear `pairing_changed` (the step and the other device's name). It cannot confirm: `device.pair.confirm` is not
  the door's call at all (`NEVER` in `tree-calls.ts`). It cannot add or remove a device: the engine raises the sealed card for each,
  the ADD card is raised by the engine itself when the pairing reaches its words step, and it draws the engine's four words and the
  computer it joins. The words go only to role `cli` (the user's terminal, `TERMINAL_ONLY_FIELDS` in `core-events.ts`), are cut from an
  app caller's join result, and are cut again at main's door.
- The code, its QR and its expiry reach the page that began the pairing: showing a code is what the page is for.
- Scope, as it is: a holder hears `pairing_changed` (the step, the name) for ANY pairing on this computer while it lasts, not only one
  begun in its own frame. The engine cannot tell which part began one: the door calls it as the user over the app's connection. Scoping it
  would need the app's main process to relay the steps to the part that pressed (a different design).
- A waiting host pairing is never ended by a timer in the engine (it shows no `expired` step); the pages keep their own clock to the
  code's expiry and say it lapsed.
- Where in the diff: `packages/protocol/src/devices.ts` (`pairing_changed` roles and `capability`), `apps/desktop/src/main/ui/tree-calls.ts`
  (`DEVICES_MANAGE`), `packages/plugin-sdk/src/catalogs/capabilities.ts`, `packages/core/src/devices/rpc.ts` (`askToAdd`, `drive`), `packages/core/src/ipc/core-events.ts` (`TERMINAL_ONLY_FIELDS`).
- Proofs: see "Proven" under Pairing above. A live proof is owed for: a real network pair, the n0 relays, the short code through a
  deployed handshake service, and scanning the Settings QR with a real phone.
