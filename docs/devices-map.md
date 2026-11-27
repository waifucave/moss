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
  The engine never calls a `relays` entry's handler yet.
- Between it and working: live check that a pair behind two NATs connects through n0's relays; `services/relay` (Cloudflare, not
  deployed) is what the not-yet Cloudflare relay plugin would use.

## Account sign-in (§8.2) and the sign-in project
- `account-config.ts` reads `authUrl` and `anonKey` from `<home>/account.json` (or env in dev builds). The values are the owner's
  to supply; none is committed. `services/accounts` is the service behind it (not deployed).

## The device plugins (lane DV, 2026-11-24): what runs, what is parked and why
The forwarder and the webhook trigger run in this build; the six below are listed off as not available (the reason slug in
each `moss.json` `availability`). Every bundled host half now reads only the plugin API's own members
(`plugin-host/tests/bundled-host-members.test.ts`), except the web companion's.

| Plugin | State | What still stands between it and working |
|---|---|---|
| forwarder, trigger-webhook | on | `services/forwarder` deployed at hooks.waifucave.com (its tag keys, account-id key, ticket secret) and `services/accounts` (a signed-in account). Until then a webhook routine is made and the bot is told plainly why it has no URL. Proven end to end against the Worker on wrangler's local runtime: `routines/tests/forwarder-e2e.test.ts` |
| push | parked (`push-origin`) | no phone or browser app registers a push target yet (`PUT /v1/targets/self`: `native/phone-core`, `apps/ios`, the web page); then `services/push` deployed with APNs and VAPID keys, and `services/accounts`. The host half and the revocation sweep are proven against the Worker in workerd: `services/push/test/plugin-host.test.ts` |
| relay-cloudflare | parked (`device-id`, now stale: the id is `api.plugin.device` with `devices.read`) | the link sidecar takes only iroh relays (`RelayMode::Custom`) and `services/relay` speaks its own room protocol: either the Worker speaks iroh's relay protocol or `native/link` carries a link over a room. Not a deploy |
| companion-web | parked (`pairing-registry`) | its host half needs a device registry `add`, a link adoption door and a pair store the plugin API doesn't have, and its pairing card would hold the four words in plugin text; the engine's own pairing for a browser is the shape it needs. The core calls no `companions` handler yet |
| companion-ios | parked (`pairing-registry`) | the phone apps pair by scanning the engine's own QR and speak the `remote` role on the core's link (`native/phone-core`); the core calls no `companions` handler and the apps register no `moss://` scheme, so this plugin has nothing to do as it stands |
| provider-gcp, provider-hetzner | parked (`cloud-computers`) | the cloud computers lane's |

## For the deploy lane: revocation reaching push and the forwarder
- **Today.** A device revoked on a computer that runs MOSS is cut off at once on that computer's links. Push learns of it only
  through the moss/push plugin's sweep on the main computer (a phone or browser that leaves the device list and that the
  registry holds as revoked: `DELETE /v1/devices/<id>`). The forwarder learns of nothing: it trusts the account token.
  A device revoked by a path that skips every computer (the account page, or a computer that is off) reaches neither service.
- **What a revoked device can still do meanwhile:** use the account tokens it already holds, each at most 5 minutes old
  (`ACCOUNT_TOKEN_MAX_MS`), against push.waifucave.com and hooks.waifucave.com (register a push target, register or list
  webhook routines, take held webhooks sealed to its own forwarder key). After its last token expires, nothing: the account
  service mints no more for a revoked device.
- **The binding to write** (the deploy lane owns `services/*/wrangler.jsonc`): give `services/accounts` service bindings to
  `services/push` and `services/forwarder`, and have its device revocation call each one's revoke (push: `DELETE
  /v1/devices/<id>`; the forwarder: drop the device's key and its routines' delivery to it) at the moment it revokes.

## Known gaps in the plugin API's device doors
- The parked mark (`availability: not-yet`, with its `note`) stays MOSS's own for the first release: a plugin outside the bundled `moss` tree is refused for it (the coordinator's ruling, 2026-11-24).
- `api.plugin.device` (this device's id, for `devices.read` holders) is read when a host half starts: a grant of
  `devices.read` withdrawn later takes effect at the host's next start.
- A development profile's local emulators can't take the account token yet: the daemon passes no `waifucaveTarget`
  (`runtime-sdk/model-plugins/start.ts` takes one), and an emulator's loopback origin would also need to be on the
  plugin's `network:` list.

## Owner's ordered list (what to deploy, supply or check by hand)
1. Build the link sidecar (`cargo build --release` in `native/link`) on two Macs. Working: `moss-link` starts, two engines list each other after pairing by QR.
2. Pair two real computers by QR from Settings (either app): the card appears on each by itself, the same four words show on both cards, both lists show both. Remove one: its card asks first.
3. Deploy `services/handshake` (Cloudflare account, route) for the short code. Working: a short code from machine A joins on B with no QR.
4. Supply the sign-in project's URL and key (`<home>/account.json`), then deploy `services/accounts`. Working: sign-in on two machines shows one account.
5. Deploy `services/relay`, `services/push`, `services/forwarder`, `services/web` as each plugin above is wanted.
6. Live check: with the relay page set to n0's relays, a pair across two networks connects; set to none, it connects only directly.

## For the reviewer: who holds `devices.manage`, and what `pairing_changed` carries
- Held by one bundled plugin: `plugins/moss/plugins/settings/moss.json` (the Settings part), which also holds `devices.relay`. No other bundled plugin asks for either.
- A third-party plugin may ask for it (`packages/plugin-sdk/src/catalogs/capabilities.ts`, `warns: true`). Its OK card says it pairs and
  removes your devices when you press its controls, and sees the step of a pairing and the other device's name; never the four words.
- What a holder can do: call `device.pair.begin/join/cancel` and `device.revoke` through the door (a press each), and hear `pairing_changed` (the step and the other device's name). It cannot confirm: `device.pair.confirm` is not
  the door's call at all (`NEVER` in `tree-calls.ts`). It cannot add or remove a device: the engine raises the sealed card for each,
  the ADD card is raised by the engine itself when the pairing reaches its words step, and it draws the engine's four words and the
  computer it joins. The words go only to role `cli` (the user's terminal, `TERMINAL_ONLY_FIELDS` in `core-events.ts`), are cut from an
  app caller's join result, and are cut again at main's door.
- The relay is its own capability, `devices.relay` (`device.relay.get` a read, `device.relay.set` a press, both refused at main's door without
  it; `tree-calls.ts`). A relay of someone's choosing sees which devices are online and from where, which pairs talk and how much, can
  report a wrong public address and can drop traffic (never what they say), so its OK card says so, and `devices.manage` does not open it.
  The engine cannot tell a plugin's frame from the person's own press (main's connection calls as the user): the door is the gate.
- The four words go only to a `cli` connection whose caller is the user (`isUsersTerminal` in `core-events.ts`): a CLI that a bot's or an
  agent's session runs is role `cli` too, but calls as that session, and hears the step without them.
- One rule for a device's name, `devices/names.ts` (`cleanName`, `nameProblem` says why, `safeDeviceName` cleans), at every door: the
  registry's `open` (a stored name from before the rule is cleaned and saved), `add`, `rename` and a peer's shared update, `device.rename`
  (refused with the reason in plain words), the pairing's `#readSide` (the one place a peer's record is validated: name, kind, os and
  PH's `app`) and the name the operating system gives (`defaultDeviceName` cleans, never refuses). A name is 1 to 63 UTF-16 units, has
  something visible, no control character or line break, no format character (`Cf`: bidi controls, zero-width, soft hyphen, tag block,
  U+FFF9–FFFB, U+180E), no blank-drawing filler (Hangul, Khmer, braille blank), no mark with no base (first or after a blank) and at most
  4 marks after one. ZWJ and ZWNJ are allowed only between two visible characters (a variation selector or skin tone before is looked past),
  never first, last, doubled or beside another format character. Quotation marks are allowed: the add card draws the name as the whole value
  of a row of its own ("The name it gives itself"), never inside a sentence, so nothing in it can close or continue the engine's words.
  Subdivision flags (🏴 and the tag block) are refused with the tag block; flags of two regional indicators pass. The sealed frame draws
  ZWJ and ZWNJ as the text `U+200D` and `U+200C` (`sealedEscape`, another lane's renderer): a name with one reads honestly, not as the emoji.
- A pairing turned away over the other device's record (`PairRefusal`: name, kind, os, app, record) is said in plain words on both sides
  and never in the other device's text: the host's pairing keeps waiting and carries a note (`PairingState.note`, a `pairing_changed` on the
  `waiting` step with `reason`), the joiner gets a fixed code (`["refused", {reason, code}]`) and says it in its own words; the pages draw
  the note beside the code. A card that cannot be built fails the pairing at once.
- A wrong guess at the words, from any app connection, ends the pairing and withdraws its card (one guess per pairing, so no oracle).
- The code, its QR and its expiry reach the page that began the pairing: showing a code is what the page is for.
- Scope, as it is: a holder hears `pairing_changed` (the step, the name) for ANY pairing on this computer while it lasts, not only one
  begun in its own frame. The engine cannot tell which part began one: the door calls it as the user over the app's connection. Scoping it
  would need the app's main process to relay the steps to the part that pressed (a different design).
- A host pairing ends by a timer in the engine (`#armExpiry`, the injected `Clock`, one timer per pairing) at the `expiresAt` its code shows:
  failed as `expired` (the `expired` step the pages draw), its connection closed and its add card withdrawn, at whatever step it had reached
  (a pairing at its words with a card up included) except once both sides confirmed and the device is being written down. The timer is
  cleared when the pairing ends, is cancelled or the service closes.
- Where in the diff: `packages/protocol/src/devices.ts` (`pairing_changed` roles and `capability`), `apps/desktop/src/main/ui/tree-calls.ts`
  (`DEVICES_MANAGE`), `packages/plugin-sdk/src/catalogs/capabilities.ts`, `packages/core/src/devices/rpc.ts` (`askToAdd`, `drive`), `packages/core/src/ipc/core-events.ts` (`TERMINAL_ONLY_FIELDS`).
- Proofs: see "Proven" under Pairing above. A live proof is owed for: a real network pair, the n0 relays, the short code through a
  deployed handshake service, and scanning the Settings QR with a real phone.

## Calls on another computer: where the checks run

With agent SDK 0.0.87 a call on another computer is answered inside PreToolUse, so the holder acts before the calling
computer's final decision. The calling computer makes its checks first: the pause and the lease (again after any card);
the plugins' tool.before (deny, rewrite, and an ask that raises the calling computer's own card for every tool); the tree
router's refusals; the run-later floor for a file tool's write; and a level never wider than the session's own, the bot's
on its computer, or the holder's. No later deny can come: the bot session's hooks are all MOSS's (no settings' hooks), the
hand-off is the last of them, the session never runs in plan mode, the computer's saved rules and Tools-tab settings don't
cover built-in tools, and the approval check passes only a call the hand-off answered. (Lane XC; the code:
`packages/core/src/runtime-sdk/turn-loop/driver.ts`, `#treeHandOff`.)

**The level, a deliberate rule stricter than spec §9.1's wording.** A call on another computer is judged at the
strictest of three levels: the session's own (a side thread's or a routine's), the bot's level on the computer it runs
on, and the level of the computer that holds the files. Why: a bot gets the same treatment away as at home, never a
looser one. So "automatic" on the holder alone lets nothing more through from a computer that is stricter. And the
holder's reviewer needs a model on the holder. A computer with no provider (a server, say) never has a reviewer, so at
"ask for risky actions" it always asks.

**The card, and who signs it.** When the holder's rules ask, its refusal carries its own card. The calling computer
raises that card through its broker for the asking session (`brokerAsker`, `computers/ask-user.ts`). The person's yes
comes back signed by the program they pressed it in:
- MOSS, with its own program key;
- MOSS Code, with the device's single answer key;
- the host's island or fallback card, with the host's own key;
- a phone, with its answer key.

The call then goes again with that answer, and the holder checks it itself (`verifySignedAnswer`). A program-signed
answer verifies only with that program's key on that device.

The holder learns the other computer's program keys from that computer's own link (`link.device.programKeys`,
`links/relay.ts` `shareProgramKeys`). Each key comes with its own registration, which must name that device and that
program. They are stored in the device record. The first key of a program is kept, and a revoke drops them at once.

Three refusals have their own words:
- the person's no;
- a yes with no signature (an app without an answer key);
- a computer where no device of the person's signs answers, refused at once instead of a card that could never be
  answered.

A new key for a program the holder already holds is handled one of two ways:
- With a hand-over chain from the held key (each step signed by the key it replaces), the holder takes it with no card
  and retires every key the chain passed through.
- Without one (the app reinstalled there, its data wiped), it waits on ONE card on the holder, about the presenting
  computer, which never sees or answers it. The card shows the new key's four words, which that computer's Settings
  show too. A yes takes the key; the person's no declines it for good.

On the computer itself, a program whose key was lost (lane XC, xc-6b) asks on its own card. That card is answered by
another of the person's devices' own keys (a phone, MOSS Code's key there, another computer's app), or on macOS also by
the signed app's own press; never by the new key itself. `moss device key reset <program>` sends the person to that
card. On Linux and Windows with nothing else to answer it, the terminal takes the key itself, and the card becomes an
OK-only notice (docs/across-computers-owed.md).

On Linux and Windows the app role is checked by the app's image, not a signature (platform/app-image.ts; the owner's
ruling "Allow, and say so"), so a program key there proves "MOSS's executable, or a program running as you that started
or replaced it", not the signed app (docs/across-computers-owed.md).
