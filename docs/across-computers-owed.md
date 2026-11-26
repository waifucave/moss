# Across computers: what still needs a deployed service or real hardware

Lane XC, 2026-11-25. A bot works on all of the person's paired computers as one folder tree (`home/<Computer>/…`,
`home/memory/`, `bots/<bot>/…`). What is proven, and how, is in the lane's commits and in
`packages/core/test/runtime-sdk/turn-loop/tree-handoff.e2e.test.ts`, `packages/core/test/daemon-two-engines-sidecar.test.ts`
and the `computers` acceptance unit (`scripts/acceptance/computers-step.ts`). This file lists what those proofs cannot
reach, because it needs something that isn't in a test run.

## Needs a deployed service

- **The lease's handshake service.** Which computer may act for a bot (the lease, `links/handshake*.ts`) is settled
  through the handshake service between computers that aren't on one network. The proofs run with `handshake: null`
  (two engines on loopback, or an in-memory network), so a lease taken and handed over through the real service, and
  one that outlives the service going away, are unproven. And without it, after a main computer restarts, the lease
  stays with the other computer that took it meanwhile. It doesn't move back (main.handOver can't move it either), so
  the computers unit's restart row stops both engines and starts the main one first.

  The consequence for a person today: until that service is deployed, a pair's lease lives in no record (it is held
  in memory by the computer that took it while it was alone). So after the main computer restarts with its peer off,
  nobody takes the bots back on their own (lease/coordinator.ts, the no-scope step takes a lease only with no other
  computer paired), and the bots stop. The way out is `main.set` for that computer: Settings' Make main, or
  `moss device main set` in a terminal (the restart row uses it). From the app it raises that computer's card; from a
  terminal it does the same while an app or phone is connected, and with none it applies at once and is shown later as
  a terminal change. Owed: the handshake service's deploy, which needs the owner's word.
- **The short pairing code.** The typed code (40 bits naming a rendezvous slot, 80 bits of secret,
  `links/pairing.ts`) waits in a slot the service holds. The proofs pair with the QR, which carries the host's key and
  addresses itself, so the code's round trip through a deployed rendezvous is unproven.
- **The relays.** With `relay: "disabled"` and no lookup, the sidecars reach each other only on loopback, and only
  while one of them keeps running: where a peer is then lives only in a running sidecar (the QR's address, a dial
  that came in), so after both engines restart neither can find the other. The restart row restarts one engine only. A connection
  through the n0 relays (or MOSS's own), and the fallback to a relay when no direct path opens, is unproven here.
- **The memory mailbox through a deployed relay** (step 5's part 3, 5b). A memory change for a computer that is off is
  kept as sealed mail by the one relay plugin that is on (sync/relay-mailbox.ts): sealed to that computer's box key,
  signed with the sender's link key, 30 days at most. It is proven on the in-memory relay only. A real relay
  (relay-cloudflare in the person's own Cloudflare account) keeping and handing back that mail is unproven until one is
  deployed. With no relay on, which is the default, memory reaches a computer that was off over its link once it's
  back. With two on, none is used and the person is told.

## Needs real hardware

- **Two machines on a real network.** Every proof runs both engines on one machine. A call to another computer across a
  real LAN, with its latency and its drops (a link that goes and comes back mid-call, a computer that sleeps), is
  unproven; "computer offline" is proven only for an engine stopped on the same machine.
- **Two NATs.** Two computers each behind its own NAT, reaching each other by hole punching or a relay: unproven.
- **A phone signing a holder's card.** In the proofs, a holder's card (a write at the holder's default level, a transfer
  between two computers) is answered in one of two ways: by a test phone key, or by the harness signing as MOSS does
  (MOSS's own program key, registered as the app registers it). A real phone that shows the card and signs the answer
  with its own key, checked by the holder, is unproven.
- **Windows as one of the two.** The `computers` unit runs on macOS and Linux; Windows is out of its set for now (a
  peer's command there runs under the Windows fence, proven by its own jobs, not by a call from another computer).

## Owed in the code

- **A program key's rotation between computers.** The holder keeps the first answer key it takes for each of another
  computer's programs (MOSS, MOSS Code where it has no single key, the host). A different key is not taken. Answers
  signed with it are refused in words that say so, and pairing again doesn't help, because the device id is unchanged.
  When a key changes:
  - The key stays the same across app updates and reinstalls in a packaged app on macOS, Windows and Linux with the
    Secret Service. It is in Electron's safeStorage in the app's user data, which an update or a reinstall keeps.
  - It changes when that user data or its OS store item is deleted. The engine's own table on that computer then
    refuses the new key too, until the person answers a hand-over card there.
  - An unpackaged, headless or test run, and Linux with no Secret Service, keep the key in memory only: a new key on
    every start, which that computer's own table already refuses after the first.

  What's owed: a card on the HOLDER ("Studio's MOSS has a new key: accept it?"), answered there by the person, never
  by the computer presenting the key. Lane XC, after step 4 merges.
- **A program key on Linux and Windows.** The `app` role isn't verified there yet: no signature check, only the app
  token and the caller check, which shuts out a sandboxed process or one the daemon started. So a program key there
  proves "a process running as you that registered first", not the signed app. This is the open before-release item.
  On macOS the app role takes only a peer signed with the team's Developer ID for one named program, and the hello's
  surface must be that program.
- **A lost key on this computer, from the terminal, on Linux and Windows.** When an app's key here is lost, its new
  key waits on a card on this computer. The card is answered by another of the person's devices' own keys, or on
  macOS also by the signed app's own press (lane XC, xc-6b; `surfaces/rpc.ts` `device.programKey.reset`).
  `moss device key reset <program>` sends the person to that card wherever it can be answered. On Linux and Windows
  with nothing else to answer it (no phone, no MOSS Code key, no other computer), the terminal takes the new key
  itself, or opens a 10-minute window for one registration, and the card becomes an OK-only notice. There it rests
  on the CLI caller check alone: the person's own terminal, outside the sandbox and not under a process the daemon
  started. That is no weaker than the item above (the app role has no signature check there, so any first key
  already proves only "a process running as you"), and it tightens with that item.
- **A peer's command writing its folder on Linux and Windows** (step 3b). On a macOS holder, another computer's command
  writes the folder it runs in where a bot there would: on the holder reviewer's "safe" where the level's own shell
  roots cover it, or after the person's yes to the holder's card (a one-call RequestAccess grant). On Linux and
  Windows a peer's command writes only its own temp folder. On Linux, bubblewrap holds a run-later place by its path
  at the command's start, and the folder holding it can be renamed during the run: `mv proj proj-old && mkdir -p
  proj/.git/hooks` puts a planted repo at the held path while the real `.git` moves away (the review's blocker on
  24516c887). Holding the names by identity (device and inode at the start, renames through an opened parent, a
  repo's parents not renamable) is lane/xc-3c-linux-held-names, for the local bots' wider levels and peers alike.
  Windows waits on its fence's deny depth being checked for a peer's folder. Both wait on the same items as the
  local grants.
- **A bot committing on another computer.** Every `.git` is denied whole to a peer's command, as to a local bot's
  sandboxed one; a commit is the outside-the-sandbox card on the bot's own computer only. A peer's form of that card
  (on the holder, run as the person there) is not built. One backlog item for both.
