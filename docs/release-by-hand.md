# A real release: what the owner supplies and does by hand

Scripts make every file of a release and check it; nothing in the repo signs with a key it does not hold, publishes, tags, or submits anywhere
on its own. This page lists what only the owner can supply, and the order of the steps. The files of a release are the artifact table's
(`scripts/release/artifacts.ts`); how the two apps are built from one stage is in [claude/release.md](claude/release.md#moss-one-release-two-apps-lane-pk).

## What a release holds (one version, both apps)

| System | MOSS Code | MOSS | Both |
| :- | :- | :- | :- |
| macOS (Apple silicon) | `MOSS-Code-<v>.dmg`, `MOSS-Code-<v>-mac.zip`, `latest-mac.yml`, `beta-mac.yml` | `MOSS-<v>.dmg`, `MOSS-<v>-mac.zip`, `moss-latest-mac.yml`, `moss-beta-mac.yml` | the engine `moss-core-<v>-darwin-arm64`, plain Bun for plugins, the bundled plugins' tarball, each with its update files |
| Windows (x64) | `MOSS-Code-Setup-<v>.exe`, `latest.yml`, `beta.yml` | `MOSS-Setup-<v>.exe`, `moss-latest.yml`, `moss-beta.yml` | the same engine files for `windows-x64` |
| Linux (x64 and arm64) | `moss-code_<v>_<amd64\|arm64>.deb`, `moss-code-<v>.<x86_64\|aarch64>.rpm`, `MOSS-Code-<v>-<x86_64\|arm64>.AppImage`, `latest-linux.yml`, `latest-linux-arm64.yml` (and `beta-`) | `moss_<v>_<arch>.deb`, `moss-<v>.<arch>.rpm`, `MOSS-<v>-<arch>.AppImage`, `moss-latest-linux.yml`, `moss-latest-linux-arm64.yml` (and `moss-beta-`) | the same engine files for `linux-x64` and `linux-arm64` |

Each app carries the engine and the bundled tree. The background host is in every package: MOSS Code is the host (its own executable);
MOSS carries MOSS Code's app as `resources/host/moss-host[.exe]` on Windows and Linux, and `MOSS Host.app` on macOS. A latest release also
writes the beta update files, so beta users see it. Windows ships unsigned at first (SmartScreen names no publisher); macOS is Developer ID
signed and notarized; the Linux packages are unsigned and their repositories' metadata is signed.

## What the owner supplies (none of it is in the repo or CI, and today none of it is set up)

| Thing | Where it lives | State today |
| :- | :- | :- |
| Developer ID Application certificate of MOSS's team | the login Keychain; `MOSS_MAC_IDENTITY` names it ("Developer ID Application: name (TEAMID)") | owner's |
| Notarization profile | `xcrun notarytool store-credentials`; `APPLE_KEYCHAIN_PROFILE` names it | owner's |
| The update feed's Ed25519 key | the login Keychain, item `com.waifucave.moss.core.release` / `update-feed-ed25519`; the public half in `packages/update-feed/src/key.ts` | NOT made: `UPDATE_FEED_PUBLIC_KEY` is `null`. Run `bun scripts/release/feed-key.ts --generate` once and commit `key.ts` BEFORE the build the first release is made from (the apps carry the public half; `--create-draft` refuses without the key) |
| The Linux repositories' OpenPGP key | the login Keychain, item `com.waifucave.moss.core.release` / `linux-repo-openpgp`; the public half in `packaging/linux/moss-archive-keyring.asc` | NOT made: no keyring file. See "The Linux repositories' key" below. The release workflow's Linux build (`build-packages.ts --require-keyring`) and the real `publish.ts` plan both refuse, with the reason, until the file is committed |
| Where the Linux repositories are hosted | `REPO_BASE_URL` and `REPO_BUCKET` in `scripts/release/linux-repo.ts` (R2 bucket, `wrangler` signed in on the Mac) | placeholders pending the owner's choice |
| The hosted OAuth client document | the Worker in `infra/winter-oauth-client/`, served at the URL the SDK names as the client id; `bun scripts/check-cimd-live.ts` compares the live document with the committed one | deployed under its old name (live infrastructure keeps its name); the owner confirms it is live before a release |
| The production sign-in project's values | the public `authUrl` and `anonKey` in `PRODUCTION_ACCOUNT_SETTINGS` (`packages/core/src/identity/account-config.ts`): a release build ignores the environment | unset: a build without them runs signed out and says a sign-in is not set up |
| The Homebrew tap | a repository `waifucave/homebrew-moss` | the owner copies the two casks in |
| winget | a pull request to `microsoft/winget-pkgs` per app (`waifucave.MOSS`, `waifucave.MOSSCode`); the first one is reviewed by hand, later ones can use `wingetcreate` | the owner submits |
| Windows code signing (later) | `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, `MOSS_WIN_PUBLISHER` | not for the first release |

## The steps, in order

1. On a clean checkout of `main`: `scripts/pinned-bun run version:bump:to 1.111.1` (VERSION is `0.124.0` today; the three bump modes cannot
   reach it, `--to` takes an exact, newer `#.###.#`). It rewrites exactly: `VERSION`, `packages/core/src/version.ts`, the `package.json` of
   `packages/{cli,core,protocol,plugin-sdk}` and of `apps/desktop` and `apps/moss`, `apple/Winter/project.yml` and
   `apple/Winter/Support/WinterHeadless-Info.plist`. `bun.lock` is not touched and a frozen install does not mind. Commit, merge to `main`.
2. GitHub Actions, workflow `release`, run by hand on `main` with the channel. It builds MOSS and MOSS Code on macOS (unsigned, for checking),
   Windows and Linux (both architectures), checks every file against the artifact table, and keeps them as the run's artifacts. Linux
   repository metadata is made too (unsigned).
3. On the owner's Mac: `scripts/release/build.ts --channel <c> --sign` (both apps, signed, notarized, stapled; a `--sign --no-notarize` or a
   test build is marked in its `BUILD-COMMIT` and the publish step refuses it).
4. Download the run's artifacts and name every folder (this Mac's `apps/desktop/out/dist` and the downloads):
   `bun scripts/release/publish.ts --dry-run --from <dir>,<dir>,… --render-to <out>` walks the whole release on the real files without
   calling GitHub, git, codesign or the Keychain: it lists both apps' files per system, where each would go and whose step it is, and writes the
   Homebrew casks (`<out>/casks/`) and the winget manifests (`<out>/winget/`) from the files' own checksums.
5. `bun scripts/release/publish.ts --from <dirs>` is the real plan (builds of one commit on `main`, dmgs signed and stapled, the name scan, the
   sealed core's proof); add `--create-draft` to sign each update file with the feed key and create the draft release `v<version>`. Read it,
   publish it on GitHub: that is the moment it reaches anyone.
6. Linux repositories: `scripts/release/linux-repo.ts sign`, then `upload` (see its header); re-sign with `refresh` inside 30 days.
7. Casks into the tap: `bun scripts/publish-tap.ts --from <out>` (step 4's `--render-to` folder) is a DRY RUN by default: it prints each cask and the
   path it would commit to in `waifucave/homebrew-moss` (`Casks/moss-code.rb`, `Casks/moss.rb`), checks each says VERSION's version, and calls
   nothing. Only `--publish`, run by the owner on their Mac with `gh` signed in, commits them. The script is still on the held list
   (`scripts/held-scripts.ts`, and CLAUDE.md says never to run it before C7): the owner lifts that hold himself, by removing its `tap:publish`
   entry and call, when he is ready for the first tap commit. The winget manifests go into a pull request to `microsoft/winget-pkgs` by hand.
8. A beta is promoted with `publish.ts --promote <version>`.

## The Linux repositories' key

`packaging/linux/moss-archive-keyring.asc` is the repositories' PUBLIC key; it cannot exist until the owner makes the key pair, so it is not in
the repository today. Nothing may ship Linux packages without it (people verify the apt and dnf repositories against it, and `sign` and `upload`
refuse without it). To make it, once, on the owner's Mac (login Keychain unlocked, never in CI):

1. `bun scripts/release/linux-repo.ts key --generate`: makes an OpenPGP Ed25519 key, keeps the private half in the login Keychain item above, and
   writes the public half to `packaging/linux/moss-archive-keyring.asc` (it refuses if that file already exists: replacing it is a key rotation).
2. Commit that one file and merge it to `main` BEFORE the release's build. `bun scripts/release/linux-repo.ts key --check` confirms the Keychain's
   key is the committed one.
3. The file is served at `<REPO_BASE_URL>/moss-archive-keyring.asc` (`packaging/linux/README.md` has the install lines); upload it with the
   repositories.

Where the build says so: `build-packages.ts` prints a NOTE that the key is missing, and with `--require-keyring` (the release workflow passes it)
it stops before building; `publish.ts` (the real plan) refuses a release holding a deb or an rpm; its dry run prints the same reason as a note.

## What the dry run proves, and what only a real release can

Proven without publishing (`scripts/release/dry-run.test.ts`, on a fixture folder of fake artifacts for every system, and by step 4 on the
real files): both apps' files are all there for every system and channel, each update file names only its own app's files and their sizes and
hashes, one commit across the systems, MOSS's feed names never collide with MOSS Code's, the casks and manifests render with the real checksums,
and nothing outside the folder is called. Only a real release proves: the signatures and notarization, the sealed core on the Mac, the name scan
over the signed apps, `gh` creating the draft, the tag, that an installed app finds, verifies and installs its update from the published files,
that the tap and winget accept the files, and that a Windows installer runs on a person's PC past SmartScreen.
