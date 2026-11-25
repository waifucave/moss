# Contributing to MOSS

Thanks for wanting to help. This document is the practical stuff: how to get a working build, how to
run the tests, and the handful of rules that will save you a wasted afternoon.

**Before anything nontrivial, [open an issue](https://github.com/waifucave/moss/issues) or start a
[discussion](https://github.com/waifucave/moss/discussions).** MOSS has a lot of load-bearing
structure that isn't obvious from a diff, and it's much easier to point you at it before you write
the code than after.

Found a security problem? Don't open an issue — see [SECURITY.md](SECURITY.md).

## Table of contents

- [What you need](#what-you-need)
- [What's where](#whats-where)
- [First build](#first-build)
- [Running MOSS in development](#running-moss-in-development)
- [The dev/dist split — read this one](#the-devdist-split--read-this-one)
- [Tests](#tests)
- [Changing the protocol](#changing-the-protocol)
- [Rules that bite](#rules-that-bite)
- [Sending a pull request](#sending-a-pull-request)

## What you need

| | |
| --- | --- |
| **macOS on Apple silicon, Windows 11 x64 or Linux** | MOSS's three systems. Each one builds and runs the engine and both apps; the release targets are in [docs/moss-spec.md](docs/moss-spec.md) §4. |
| **[Bun](https://bun.sh)**, the version in `.bun-version` | The runtime. TypeScript runs directly; there is no build step for the engine in dev. CI runs that version; `scripts/pinned-bun` fetches it beside any other Bun you have. |
| **pnpm** | Runs the workspaces' tests (`pnpm test`). `bun install` is what installs them. |
| **A GitHub token with `read:packages`** | The `@waifucave` packages (the agent SDK's `@waifucave/moss-*` among them) are on GitHub Packages, which needs a token even to read. `bun install` takes it from `NODE_AUTH_TOKEN` (see [First build](#first-build)). |
| **Rust (`cargo`)** | Only for `native/link`, the link sidecar (`moss-link`). Without it the dev daemon still runs, local-only, with no links to other devices. |
| **Xcode with `xcodegen`**, or **Gradle 8.13 with JDK 21** | Only for the phone apps: `apps/ios` (iOS 26 or later) and `apps/android`. |

TypeScript-only contributions (the engine, the CLI, tools, providers, plugins, the apps' TypeScript)
need nothing from the last two rows.

## What's where

- `packages/core` is the engine, `moss-core`; `packages/cli` is its command line and the binary's entry.
- `packages/protocol` is the contract between the engine and every client; `packages/plugin-sdk` is the
  plugin SDK.
- `apps/desktop` is MOSS Code and `apps/moss` is MOSS: two Electron apps on the one engine.
- `plugins/moss` holds MOSS's own bundled plugins, the agent plugins among them.
- `apps/ios` and `apps/android` are the phone apps; `native/` holds the per-OS helpers, each with its
  own README.
- `services/` holds the web services and the website.
- The Swift code under `apple/` is from the previous app: MOSS's apps don't ship it.

## First build

```sh
git clone https://github.com/waifucave/moss.git
cd moss
NODE_AUTH_TOKEN=$(gh auth token) bun install   # gh's token needs read:packages: `gh auth refresh -s read:packages` once
```

The repo's `.npmrc` reads the `@waifucave` scope from GitHub Packages with `NODE_AUTH_TOKEN`; no token is ever
written to disk. CI uses the workflow's own token (`packages: read`), so nothing needs to be configured there.

That's the whole TypeScript setup.

## Running MOSS in development

```sh
bun run dev:daemon                 # build, then run the dev engine on ~/.moss-dev
bun run dev:daemon plugin list     # any other command, through the dev engine's binary
bun run dev:app                    # build MOSS Code, then run it as "MOSS Code Dev" on ~/.moss-dev
```

Each takes `--dry-run`, which prints what it would build, sign and start, and stops. `--no-build` reuses
the last build. On macOS both sign what they build with MOSS's team's certificate, which the engine's
checks and the dev Keychain items rely on; without one, run an engine from the checkout on a throwaway
home instead (below).

MOSS itself, `apps/moss`, builds with `bun run build` in its folder; `bun run dist` there packages it
alone, unpublished.

Commands worth having to hand while you develop: `plugin list`, `plugin validate <folder>`,
`plugin dev <folder>`, `autostart status` and `--version`.

## The dev/dist split — read this one

MOSS keeps two separate installs that must never be confused:

| | Distribution | Development |
| --- | --- | --- |
| MOSS Code's bundle id | `com.waifucave.moss.code` | `com.waifucave.moss.code.dev` |
| Home | `~/.moss` | `~/.moss-dev` |
| Keychain service | `com.waifucave.moss.core` | `com.waifucave.moss.core.dev` |
| Command | `moss` | `bun run dev:daemon <command>` |

**Never launch a distribution install during development**, and never Winter's: `Winter.app`, with
its `~/.winter` home and `com.winter.core` Keychain, is somebody's daily driver, updated by Sparkle. A
locally launched copy under the same bundle id is indistinguishable from it in the menu bar and
defeats the entire split. The same goes for local Release builds — build them, don't run them.

Two rules worth stating outright:

1. **Plain `moss` is the distribution CLI** (and plain `winter` is Winter's). With no engine
   answering, many of its commands *start the distribution engine* through its login item.
   Use `bun run dev:daemon` (the signed dev binary on `~/.moss-dev`), or an engine from the checkout
   on a throwaway home and a throwaway Keychain service:

   ```sh
   cd packages/cli
   MOSS_HOME="$(mktemp -d)" MOSS_PROFILE=dev MOSS_KEYCHAIN_SERVICE=com.waifucave.moss.core.scratch bun src/main.ts daemon run
   ```

   Never run an engine or the CLI from the checkout under plain `bun` on `~/.moss-dev`: after the
   dev daemon's one-time `--transition`, the dev Keychain items trust only the signed dev binary,
   and plain `bun` is prompted for every one.

2. **After any change under `packages/`, restart the engine**, not just a client. A client-only
   relaunch is a silent no-op for engine code.

## Tests

```sh
pnpm test                              # every workspace, serially
cd packages/core && bun test           # one package
bun test path/to/file.test.ts          # one file (path substring match)
bun test -t "test name"                # one test by name

bun run verify:workflow                # workflows e2e against the REAL compiled binary
```

The phone apps' tests run in their own tools: `xcodebuild test -scheme MossPhoneKit` in
`apps/ios/Packages/MossPhoneKit` (with an iOS Simulator as the destination), and Gradle in
`apps/android`. Their workflows (`.github/workflows/ios.yml`, `android.yml`) show the exact steps.

`verify:workflow` matters more than its name suggests: the workflows runtime spawns the daemon's own
binary as a sandboxed subprocess, and the dev path (`bun run src/…`) and the compiled path differ.
It must stay green.

**Every core test that can skip on Linux needs a reviewed reason.** CI's Linux shards fail any
`packages/core` file whose tests skip (or that runs none) unless it marks its macOS tests
(`darwinTest`/`darwinDescribe` from `test/helpers/darwin-only.ts`, or a `*.darwin.test.ts` file) or
is listed in `linuxSkips` in `packages/core/test/platform-ci.json` with the reason (an opt-in live
or env-gated test, another OS…). A new `skip`/`skipIf` without one of these breaks the merge queue
for every PR batched with it. `bun scripts/platform-tests.ts --root packages/core --cwd packages/core
--not-darwin --config packages/core/test/platform-ci.json` runs the same check locally.

New behaviour needs a test. The bar isn't coverage percentage — it's that the *specific claim* your
change makes is pinned by something that fails when the claim stops being true.

## Changing the protocol

`packages/protocol` is the contract between the engine and every client: the apps, the CLI, plugins,
other computers and the phone apps. Adding or changing an event or a method touches these, **in order**:

1. The area's file in `packages/protocol/src` — the zod schema. A method names the roles that may call
   it; that is what lets a connection of each role (`app`, `cli`, `remote` for a phone, `peer` for
   another computer, and the rest) call it, or not.
2. `pnpm protocol:generate` — regenerates `packages/protocol/generated/`: the JSON schema, a fixture
   per event, an area file each and every role's allow list (`generated/moss/allowlists.json`).
   Commit the result: CI fails when it is out of date.
3. For a `SessionEvent` type, `packages/core/src/projector/event-coverage.ts` — its maps over every
   event type fail core's `tsc` until you add the new one.
4. The phone apps read the generated files: `apps/ios/Packages/MossPhoneKit` and `apps/android` decode
   the fixtures in their tests, so a change a phone sees needs their tests run too.

### Adding a *field* is more dangerous than adding a variant

Every step above is keyed to something failing to compile. **Nothing fails to compile when a
producer simply doesn't set a new optional field.** So sweep the field's producers *by meaning*: who
else writes this event, in any language, and would the consumer's fallback silently accept the
old shape? This has shipped a bug before — a correct daemon and a second, stale producer emitting
the old shape past a consumer with no gate.

`session.history` and the remote stream are **allowlists, never denylists**. `reasoning_item` must
never pass either one; a security test pins that.

## Rules that bite

- **Tests must never touch `~/.moss`, or Winter's `~/.winter`.** Always point at a temp `MOSS_HOME`.
  Never kill or restart a user's live engine or app.
- **No setting may ever require a daemon restart.** `~/.moss/settings.json` is watched and
  hot-swapped atomically; feature code reads live getters. New settings follow that pattern — this
  is a product promise, not a preference.
- **Secrets live in the system's secret store.** On macOS, the Keychain (`Bun.secrets`, service
  `com.waifucave.moss.core`); on Windows and Linux, one encrypted file whose key is in Credential
  Manager or the Secret Service ([docs/secrets-file.md](docs/secrets-file.md)). Never in plain text
  on disk, never in a fixture, never in a log line.
- **Provider `encrypted_content` / `reasoning_item.itemJson` is opaque.** The session JSONL is its
  only sink. Never log it, never write it into a model-readable transcript.
- **Versions are generated.** `VERSION` (format `#.###.#` — major.feature.patch) is canonical; edit
  it only via `bun run version:bump` (patch) / `version:bump:feature` / `version:bump:major` /
  `version:sync`. Never hand-edit a version in a `package.json` or plist.
- **Minimum OS targets track the latest major OS.** No legacy compatibility shims.
- **Codex's `originator` is `"moss"`.** That's a deliberate terms-of-service decision. Don't "fix" it
  to a first-party value. The value sent is `codexOriginator` in `packages/core/src/runtime-sdk/brand.ts`
  (every session's brand, and the process-wide identity `runtime-sdk/process-identity.ts` installs).
- The Sparkle public key in `apple/Winter/project.yml` is Winter's production key, which its live update
  feed depends on. Its private half exists only in one login Keychain and is committed nowhere.

## Sending a pull request

- **Branch from `main`.** Keep the PR scoped to one thing.
- **Commit messages say what changed and why, in plain sentences**, as the repo's history does.
- **Explain *why* in the body.** MOSS's code carries unusually heavy comments explaining why
  something is the way it is, because the alternative is somebody helpfully undoing it in six
  months. Write your PR description the same way.
- **Run the tests for what you touched**, and say which ones you ran. If your change touches what a
  phone sees, that means the phone apps' tests too.
- **Don't bump the version** — releases run through `scripts/release.ts`.
- **UI changes: include a screenshot.** Colours and type come from the theme tokens
  (`packages/plugin-sdk/src/catalogs/tokens.ts`), never raw hex; `docs/moss-brand.md` covers the logo.

By contributing you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE).
