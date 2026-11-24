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
- **Cards** (`protocol/src/approvals.ts`):
  - It fetches a card and rebuilds its hash: SHA-256 over canonical JSON, with keys sorted in UTF-16 order and numbers and escapes written as JS writes them.
  - It refuses a card whose hash differs from its content.
  - It signs `cardAnswerSigningInput` with the answer key.
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
