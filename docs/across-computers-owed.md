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
  one that outlives the service going away, are unproven.
- **The short pairing code.** The typed code (40 bits naming a rendezvous slot, 80 bits of secret,
  `links/pairing.ts`) waits in a slot the service holds. The proofs pair with the QR, which carries the host's key and
  addresses itself, so the code's round trip through a deployed rendezvous is unproven.
- **The relays.** With `relay: "disabled"` and no lookup, the sidecars reach each other only on loopback. A connection
  through the n0 relays (or MOSS's own), and the fallback to a relay when no direct path opens, is unproven here.
- **The memory mailbox** (step 5's part 3, B-M2): a write to a bot's memory while the computer that holds it is offline
  needs a place to wait that is up when neither computer is; its design waits on the controller.

## Needs real hardware

- **Two machines on a real network.** Every proof runs both engines on one machine. A call to another computer across a
  real LAN, with its latency and its drops (a link that goes and comes back mid-call, a computer that sleeps), is
  unproven; "computer offline" is proven only for an engine stopped on the same machine.
- **Two NATs.** Two computers each behind its own NAT, reaching each other by hole punching or a relay: unproven.
- **A phone signing a holder's card.** A holder's card (a write at the holder's default level, a transfer between two
  computers) is answered in the proofs by a test phone key or the harness's own sealed-frame answer. A real phone that
  shows the card, signs the answer with its own key, and the holder checks it, is unproven.
- **Windows as one of the two.** The `computers` unit runs on macOS and Linux; Windows is out of its set for now (a
  peer's command there runs under the Windows fence, proven by its own jobs, not by a call from another computer).
