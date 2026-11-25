# Security Policy

MOSS runs AI agents with real access to real computers, on macOS, Windows and Linux — the
filesystem, the shell, a browser, your other paired computers, and a direct link to your phone. We take reports about that surface
seriously.

## Supported versions

Only the **latest release** is supported. MOSS updates itself from the project's releases,
so users are normally within one version of `main`. Fixes ship in a new release rather than as patches to older ones.

| Version | Supported |
| --- | --- |
| Latest [release](https://github.com/waifucave/moss/releases/latest) | ✅ |
| Anything older | ❌ |

## Reporting a vulnerability

**Please do not open a public issue, discussion, or pull request for a security problem.**

Report it privately through GitHub:

**[→ Report a vulnerability](https://github.com/waifucave/moss/security/advisories/new)**

(Repository → *Security* → *Advisories* → *Report a vulnerability*.)

Helpful things to include:

- MOSS version (`moss --version`), and your system and its version
- Which surface is affected — daemon, CLI, MOSS or MOSS Code, remote/phone transport, a plugin
- What an attacker gains, and what access they need to start with
- Reproduction steps, or a proof of concept

What to expect:

- **Acknowledgement within 5 days.**
- An assessment and a rough fix timeline once we've reproduced it.
- Credit in the advisory and release notes, unless you'd rather stay anonymous.
- Please give us a reasonable window to ship a fix before disclosing publicly. We'll tell you when
  the fix is out.

This is a small project without a bug bounty. We can offer a fast fix and public credit.

## Scope

These are in scope and genuinely interesting to us:

- **Sandbox escape.** The agent's shell runs under the system's sandbox with an explicit writable
  set, and without the network: on macOS a Seatbelt profile that denies all network, on Linux
  bubblewrap in a network namespace of its own with Unix sockets refused, and on Windows a separate
  restricted account whose connections a filter keyed to that account blocks, loopback included.
  No approval level, saved rule or grant opens the network to a sandboxed command; only a command
  the user approves on a card to run outside the sandbox has it. Anything that writes outside the
  writable set without consent, that reaches the network from inside the sandbox, or that writes
  MOSS's own settings, levels, credentials or plugins under `~/.moss`, which the fence denies at
  every level, is a real finding.
- **Approval bypass.** MOSS's permission model is enforced in the daemon, not suggested in a
  prompt. Any path that performs a gated action (an out-of-root write, a dangerous-domain
  navigation, an unsandboxed command) without the policy that governs it is in scope.
- **Session escape.** A tool reachable from a kind of session it isn't offered to — a side thread,
  a coding agent's session, a plugin's — is a vulnerability, not a quirk.
- **Daemon socket authentication.** The engine's endpoint, `~/.moss/run/core.sock` (a named pipe on
  Windows), authenticates every connection with a token and a role (`app`, `cli`, `remote`, `peer`,
  a plugin's, and others). Anything that authenticates without a valid token, or that reaches a
  method its role isn't given (from `remote`, `peer` or a plugin to `app` or `cli`), is in scope.
- **The remote (phone) surface.** The remote role has a deliberately small method allowlist and a
  filtered event stream. A remote client reaching a method or an event type outside those
  allowlists — particularly raw model reasoning — is in scope.
- **Secret handling.** Any path that writes an API key, OAuth token, or provider `encrypted_content`
  to disk, a log, a session transcript the model can read, or an error message.
- **Transport.** The links between your computers and phones (iroh/QUIC, paired with a code and
  four words compared on both screens). Anything that lets an unpaired party read, inject into, or
  hijack a session.
- **Update integrity.** The update files' Ed25519 signatures and their checks in the apps' updater
  and the engine's own update, or anything that would let an attacker deliver a build.
- **Plugin isolation.** A plugin escaping the capabilities the user consented to.

### Out of scope

- **The agent doing what the user told it to do.** If a user grants `bypass` policy and the agent
  deletes their files, that's the tool working. The question we care about is whether a *gate* can
  be defeated, not whether a user can choose to remove one.
- **Prompt injection that stays inside the agent's granted permissions.** Content that steers the
  model is expected and mitigated by the permission model, not by trying to sanitize the web. A
  prompt-injection chain that reaches something the user *didn't* grant — that's the in-scope
  version, and we want it.
- Model output quality, hallucination, or cost.
- Findings that require an attacker to already have local code execution as the user, or physical
  access to an unlocked computer.
- Issues in third-party dependencies with no MOSS-specific exploit path — report those upstream.
- Missing hardening that isn't exploitable, from automated scanners with no proof of impact.
- Social engineering, and denial of service against your own machine.

## What MOSS does on your behalf

Stated plainly, so you know what you're auditing:

- **Credentials never touch disk in plain text.** On macOS, API keys and OAuth tokens live in the
  Keychain (`Bun.secrets`, service `com.waifucave.moss.core`), as items only the engine's binary is
  served. On Windows and Linux they live in one encrypted file in `~/.moss`, whose key is kept in
  Credential Manager or the Secret Service (`docs/secrets-file.md`).
- **Data stays local.** There is no telemetry, and no account is needed. Model calls go to your
  provider; web searches go to the search provider MOSS's web plugin uses; web fetching is
  performed locally. Your devices find each other through the project's pairing service, which holds
  only sealed records, and connect directly, end-to-end encrypted. When a direct path can't be
  established, the connection relays through public iroh relays, or a relay you choose — it
  forwards ciphertext only, and terminates nothing.
- **Shell commands are sandboxed** under the system's sandbox, with a writable set drawn from the
  approval level and the session, and no network at any level. So are
  the model-authored workflow scripts, which run in a separate confined subprocess.
- **Reads are broad by design** — the file tools read what the user themselves can read. That is
  a deliberate decision. The denials are MOSS's own run folder and credentials, and the secret places
  in the user's home (`~/.ssh`, `~/.aws`, `~/.gnupg` and others), for file tools and shell commands
  alike.
- **Every release is signed** — with a Developer ID and notarized by Apple on macOS, with
  Authenticode on Windows — and every update file carries an Ed25519 signature that the apps' updater
  and the engine's own update check before they read it.
