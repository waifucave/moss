# The Windows credential broker: what it must hand gh, git, Docker and ssh-agent

Lane WS, 2026-11-22. Spec §9.1 (item 76) and §4; S2.3–4 of the [S2/S8 report](2026-11-05-s2-s8-fence-and-secrets.md).
**Status: specified, not built.** The spec fixes the broker's principles but not its protocol, so this note states
the shape the four tools force, and the open questions that must be answered before it is built. Nothing here is
admitted for release.

## What the spec fixes

- On Windows a bot's Bash and PowerShell run as a pool principal (`moss-sb-<6hex>-<n>`), never as the user. They can't
  use the user's DPAPI, Credential Manager or ssh-agent.
- `gh`, git credential helpers, Docker registry logins and ssh-agent signing reach them **only** through a MOSS
  credential broker acting in the user's logon context, as on Linux.
- The broker never hands over raw keys or stores. It admits only the credential operation allowed for that
  **session, destination and identity**. MOSS's own secrets, approval tokens and device keys are never served to
  model commands.

## The one transport a fenced command can reach

What is measured (S2, and this lane's `win-fenced.e2e.test.ts` on windows-latest):

- A fenced command reaches no TCP address but the loopback proxy range 60080–60089 that srt-win's filters keep open.
- A named pipe whose access list doesn't name the principal (or its group) refuses the command. MOSS's own pipe
  (owner-only DACL) and, where present, Docker's `docker_engine` and `openssh-ssh-agent` pipes are refused.

So the broker is **one named pipe per session**, served by the daemon (the user's process), whose DACL names the
session's leased principal SID (`exec --user`) and nothing else besides the user and SYSTEM. It exists only while the
session runs. It carries length-prefixed JSON requests, as `moss-core`'s own pipe does. The pipe's name reaches the
command in its environment (`MOSS_CREDENTIAL_PIPE`), and the four adapters below are small programs MOSS ships beside
`moss-core.exe` (in the protected copy, so a command can't swap them).

## The four adapters

| Tool | How it reaches the broker | What the broker answers | What stays closed |
| --- | --- | --- | --- |
| git | `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n` set `credential.helper` to `moss-credential git` for the command (no file written) | `get` for `{protocol, host, path, username}`: the password or token for that exact URL when the user allowed it for the session; `store` and `erase` only after a card | Git Credential Manager over the user's Credential Manager |
| Docker | `DOCKER_CONFIG` names a per-session folder whose `config.json` has `credsStore: "moss"`, so Docker runs `docker-credential-moss` | `get` for one registry (`list` returns only the allowed registries); never `store` | the Docker engine pipe, which starts host containers |
| gh | `GH_TOKEN` set for that one command, for the allowed host and account | the token itself, released for that command only (gh reads it from its environment; on Linux it is a Secret Service lookup) | the user's Credential Manager and gh's `hosts.yml` |
| ssh | `SSH_AUTH_SOCK` set to the broker's agent pipe, and `GIT_SSH_COMMAND` pointing git at Windows OpenSSH (`C:\Windows\System32\OpenSSH\ssh.exe`), because Git for Windows' MSYS ssh reaches an agent over a loopback socket the fence closes | the ssh-agent protocol's identity listing and signing, for the allowed keys and destinations only; never key export | the user's own agent pipe, blanket forwarding |

A released token (gh) is visible to that command's processes, as on Linux; keys never leave the broker. Every answer
is logged as the operation, the destination and the identity, never the secret.

## Open questions (the smallest question that settles each)

1. **Who allows what.** Is a credential allowed per session on a card ("<bot> wants to use your GitHub login for
   github.com/owner/repo"), per bot with "Always allow", or only in Settings? The spec says "allowed for that
   session, destination and identity" but names no surface.
2. **Destination for ssh signing.** The ssh-agent protocol doesn't carry the destination host (only the session
   bind extension, `session-bind@openssh.com`, does, and only from OpenSSH 8.9 on). Is a key allowed per key (any
   host), or must signing require the session-bind and refuse clients that don't send it?
3. **Where the user's logins come from.** git: Git Credential Manager's store is the user's Credential Manager,
   readable by the daemon (a password logon). gh: `gh auth token` as the user. Docker: the user's
   `~/.docker/config.json` helper. ssh: the user's agent pipe. Does the broker read each tool's own store as the user
   (a fixed list of helpers it runs), or does MOSS keep its own copy of each login in its secrets file?
4. **The logon.** DPAPI and Credential Manager need the user's real logon (S8: an SSH or network logon fails them).
   The daemon started by its password-principal startup task has one; is the broker in the daemon, or a separate
   per-logon process the daemon talks to?
5. **macOS parity.** §9.1 says C1 adds a git credential helper on macOS that gets logins from the core. Is that the
   same `moss-credential git` protocol, so the two OSes share one adapter?

Until these are answered, a fenced command on Windows has no credentials: `git clone` of a private repository, `gh`,
`docker login`/`pull` from a private registry and `ssh` with the user's keys fail inside the sandbox, as they do in a
bot's Bash on macOS today.
