# `vendor/srt-win`: MOSS's Windows launcher (lane C, C-M2 part 2)

The Bash fence on Windows runs bots' commands as a dedicated per-user sandbox principal
(`moss-sb-` + 8 hex chars of the owner's SID) through the `srt-win` launcher, vendored from
`anthropics/sandbox-runtime` (Apache-2.0) at the pinned tag/commit in
`packages/core/src/fence/win-sandbox.ts` (`SRT_WIN_TAG`, `SRT_WIN_COMMIT`).

- `vendor/srt-win-src/` is the pinned source tree. It is a **build input, never
  committed**: `scripts/build-srt-win.ps1` clones it at the pinned commit,
  applies `vendor/srt-win/patches/*.patch`, and verifies `HEAD` before building.
  (Same pattern as `.clover-sdk/`.)
- `vendor/srt-win/patches/` is MOSS's patch set on the vendored launcher.
  `0001-per-principal-setup-records.patch` keys the install record and credential
  per principal (`HKLM\SOFTWARE\sandbox-runtime\Users\<name>`, `Cred\<name>`)
  and adds a `--user` selector to `exec`, `user status` and `uninstall`, so one
  install no longer orphans another's launch path. The global record keeps its
  exact semantics (last install wins); everything new is opt-in behind `--user`.
  `0002-session-0-named-objects.patch` lets a broker in session 0 (a password
  scheduled task) launch: there the named-object grant isn't made (no
  `\Sessions\0\...` directory exists, and the global one must not be changed).
  `0003-network-open-principal.patch` adds `install --network-open`: the account's
  user-keyed filter blocks only the cloud metadata addresses (169.254.0.0/16,
  168.63.129.16, 100.100.100.200, 192.0.0.192, fd00:ec2::254, and the IPv4 ones
  IPv4-mapped), for the account that runs a command the person approved to leave
  the sandbox.
  `0004-delete-child-deny-on-the-parent-alone.patch` writes the FILE_DELETE_CHILD deny
  srt-win puts on a denied target's parent without inheritance, so stamping it no longer
  walks the whole tree below the parent (a target at a profile's top cost ~25 s a command);
  a write-denied target carries its own inheritable FILE_DELETE_CHILD deny instead, which
  the parent's inherited one gave it before (the write mask lacks that right).
- `vendor/srt-win/srt-win.exe` is the static-CRT build lane M's CI makes and
  signs (with the patches applied); the Authenticode digest check in
  `packages/core/src/fence/windows-launcher.ts` (`SRT_WIN_PINS`) fails closed
  on a mismatch, exit 3 on every launch.

Upstream-ready description (for the owner to send upstream; no upstream post
is made from here): keep one machine-global setup record working exactly as
today, and add opt-in per-principal records plus a `--user` selector on
`exec`, `user status` and `uninstall`, so hosts that run one sandbox
principal per session can install several principals side by side and address
each launch explicitly, without changing the default `srt-sandbox` flow.

License: the launcher's own `LICENSE` (Apache-2.0) applies to everything under
`vendor/srt-win-src/` and to `srt-win.exe`; see the upstream repo.
