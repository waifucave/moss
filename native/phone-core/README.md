# phone-core

The phone apps' shared core (spec §8, §5.5, §10; lane PC): one Rust library that MOSS and MOSS Code on the iPhone (Swift) and on Android (Kotlin) use to pair with a person's computer, hold the link, call the engine and sign card answers. Each app has native screens over it; each pairs on its own (`PhoneApp`).

## What it does

- **Keys.** It creates the device's link key and its answer key, and keeps them only through `SecretStorage`, which the host app implements over the iOS Keychain or the Android Keystore. The core writes no file of its own, and no key or secret ever appears in `Debug` output or an error. The answer key is an Ed25519 seed held in memory, so `held` is `keychain` or `keystore` and never `secure-enclave`.
- **Pairing, as the joiner** (`links/pairing.ts`):
  - QR → `begin_pairing` → `words()`.
  - Then either `confirm()`, which returns the `PairedComputer`, or `reject()`.
  - The pair credential (its signing key and pair secret) and the group key go to the host's storage.
- **The link** (`links/transport.ts`): one connection on `clover/link/1`.
  - It carries the peer hello, lanes, pings and the idle limit.
  - The client protocol runs on its own stream, `clover/rpc/1` (`links/remote-clients.ts`), as role `remote`.
  - The phone re-dials with the engine's backoff, and at once on `network_changed`. It stops only when the computer revokes it.
  - On each connect it runs `protocol.hello`, then `events.subscribe`, then `card.list`.
- **Messages:** `send_message(session, text, client_message_id, images, files)` signs the person's message with the answer key over `userMessageSigningInput`, as the desktop app does. The hash covers the attachments.
  - `stage_image(session, media_type, data)` (`session.stageImage`) and `stage_file(session, name, data)` (`session.stageFile`, in 512 KiB chunks, each request well under the link's 1 MiB frame) give the paths to name in `images` and `files`. A file that fails part way is cancelled at the computer.
- **Cards** (`protocol/src/approvals.ts`): every card reaches the app as a `CardView` object, from `CardRequested`, `PendingCards` or `fetch_card(id)`. Only the core makes one (no constructor crosses the FFI): it has checked the card and rebuilt its hash from its content (SHA-256 over canonical JSON, keys in UTF-16 order, numbers and escapes as JS writes them). A card is refused (`TamperedCard`) when the hash differs, or when `fetch_card` gets back another card than the one asked for.
  - `answer_card(card, option, children)` takes that same object back and signs only it: issued by this connection, still pending, its hash recomputed from its own content. Nothing is fetched between the tap and the signature, and the option and checkboxes must match the card and the protocol's patterns.
  - `card.pending()` and `card.outcome()` follow `card_resolved` (also the `CardResolved` event) and the phone's own accepted answer; an answer to a card no longer pending is refused by the core.
- **What a computer sends is bounded**:
  - a lane frame is at most 1 MiB, and its CBOR at most 4096 items and 32 levels deep, with repeated keys found in linear time;
  - a client message is at most 4 MiB. One over that, up to the link's 16 MiB, is read to its end and dropped: an answer fails only its own call (`Refused`), anything else is reported as `MessageDropped`, and the link stays. Past 16 MiB the link closes;
  - queued events are capped in count and in bytes.

  Anything malformed closes that one link, with a reason in the core's own words, never the computer's text, and the core re-dials. Every call under way then ends at once.
- **The computer's own words** reach the app only cleaned (control, bidi, format and separator characters removed, blanks folded, length capped) and in fields named for it: `CoreError::Rpc.computers_words`, `AnswerOutcome.computers_reason`, `TamperedCard.computers_id`, `StagedFile.computers_name`. A lone surrogate in the engine's JSON reads as U+FFFD, as JS's `toWellFormed` makes it.
- **The computer's record** is checked as the engine checks a peer's:
  - its name by the engine's name rule (`src/names.rs`, a port of `devices/names.ts`);
  - its kind must be a computer (`desktop`, `server` or `cloud`), its os from `DeviceOs`, and it may carry no phone app.

  Refusals use the engine's closed codes, in the core's words. The phone's own name is made safe as the engine makes its own.
- **Storage:** `load` answers `None` only for "no such item". A store that can't be read now answers `NotAvailable`. The core never makes keys over keys it couldn't read, nor while computers are paired. Group-key item names are a hash of the computer's group id. `forget_computer` deletes every item of that computer. A re-pairing saves the new items and record first and only then deletes the old pairing's items; a save that fails leaves the old pairing whole and removes what it saved. Seeds the core holds are zeroized when dropped, and handed to the store by move.
- **A cancelled confirm:** `Pairing.confirm` runs to its end even when the app stops awaiting it, so the phone ends as the computer does: both confirms crossed, both keep the pairing; the computer cancelled, closed or timed out, neither does. To stop before that, call `reject`.
- **Cancellation:** a call the app abandons aborts its work at the next await, but a frame being written finishes in a task of its own (a half-written frame would cost the next message), and the call's pending entry goes with it. `next_event` takes an event off the queue only when it returns it.
- **Bindings:** UniFFI 0.32. Swift and Kotlin come from one definition, the `#[uniffi::export]` items. Every async call runs on the core's own tokio runtime, so it completes whatever executor awaits it.

## Byte for byte

The engine's TypeScript is the reference. `tests/vectors.rs` runs `tests/harness/vectors.ts`, which calls the engine's own functions on fixed inputs, and requires the same bytes from the core for each of:

- the CBOR encoding;
- the device id, a deterministic signature and the strict-point verdicts;
- the nonce commitment, the three transcripts, both proofs, the four words, the pair secret and the pair id;
- the pair, admit and answer-key statements;
- canonical records;
- canonical JSON, the card hash and the answer's signing input.

## Build and test

```sh
cargo test --manifest-path native/phone-core/Cargo.toml          # unit tests
# against a real engine (temp home, the real sidecar on loopback, no relay) and the vectors:
cargo build --release --locked --manifest-path native/link/Cargo.toml
MOSS_PC_ENGINE_TESTS=1 cargo test --manifest-path native/phone-core/Cargo.toml -- --test-threads 1
# bindings
cargo run --features bindgen --bin uniffi-bindgen -- generate --library target/release/libmoss_phone_core.<so|dylib> --language <kotlin|swift> --out-dir <dir>
```

CI: `.github/workflows/phone-core.yml`. It is not part of the gate and runs only when these paths change.

- `rust`: the tests above.
- `android`: builds the core for x86_64 with cargo-ndk, generates the Kotlin bindings, starts an engine on the runner, and runs `android/`'s instrumented test in an emulator. The test checks that async calls complete, then pairs, calls, hears a card and answers it. The emulator reaches the runner at `10.0.2.2`.
- `ios`: builds the XCFramework and the Swift package, and runs a Swift test that pairs with a local engine.

## What it may touch

- UDP sockets for iroh.
- HTTPS to the relays, when a relay is chosen.
- The host's `SecretStorage`.

It reads and writes no files.
