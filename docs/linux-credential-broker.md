# The Linux credential broker: the Secret Service inside the fence

Lane LB, 2026-11-24. Spec §4 (the Linux Bash cell), §9.1, §14 items 8 and 76, the revision-18 defaults; the
[S2/S8 report](research/2026-11-05-s2-s8-fence-and-secrets.md) (S8.2) and its prototype
(`spikes/s8-secrets/secret-broker.py`). Code: `packages/core/src/fence/linux-secret-broker.ts`,
`dbus-wire.ts`, `linux-bus-relay.ts`; the fence's Linux leg in `fenced-process.ts` and `linux-bwrap.ts`.

## What the spec asks

- Bash's fence hides MOSS's secrets file and run folder, while `gh`, git and Docker keep the user's OS store.
- `systemd-run --user` stays closed, with a D-Bus filter (Landlock can't filter D-Bus).
- The Secret Service reaches Bash only through a broker that judges each item by what a request and its answer
  carry, never by bus name, interface or object path. S8 showed why: an allow list by path let a protected item
  through in a method's arguments.
- The host's execution endpoints stay hidden: the host bus, systemd's sockets, portals and Docker.
- The broker never hands over raw keys or stores. MOSS's own secrets, approval tokens and device keys are never
  served to a model's command.

## What the code did before this lane

`linux-bwrap.ts` mounted an empty tmpfs over `/run/user/<uid>` and blanked the system bus socket. Separately, the
fence's seccomp filter (`seccomp.ts`) makes `socket(AF_UNIX)` fail inside the sandbox, so no Unix socket on the disk
can be reached at all. That is safe, but `git`, `gh` or `docker-credential-secretservice` that keep a login in the
user's keyring could not get it in a fenced command.

## The fact that decides the design

A fenced command can't make a Unix socket. So a filtering proxy socket bound in place of `/run/user/<uid>/bus`
(xdg-dbus-proxy, or the S8 prototype's shape) would be unreachable from inside, whatever sat behind it. Opening
`socket(AF_UNIX)` again is not an option: `/` is bound read-only, and every socket on the disk would come back into
reach: Docker's, X11's, systemd's and the user's agent sockets. So this design keeps the seccomp filter and the
hidden `/run/user/<uid>` exactly as they were. (S8 ran its prototype without this filter, so its transport does not
carry over. Its method rules do.)

## The design

1. **The transport.** The sandbox has its own network namespace (`--unshare-net`), with only loopback, and
   `AF_INET` sockets are allowed. When a run may use the keyring, the sandbox's first process is a small relay
   (`linux-bus-relay.ts`, run by the engine's own binary). It listens on `127.0.0.1:<port>` inside the sandbox's
   namespace, then starts the command with `DBUS_SESSION_BUS_ADDRESS=tcp:host=127.0.0.1,port=<port>`. It carries each
   connection's bytes over two pipes it inherits to the engine. Nothing outside the sandbox can reach that port, and
   nothing inside can reach anything else. The relay is untrusted: the command can kill or impersonate it. The engine
   parses everything that arrives.
2. **The engine is the sandbox's whole bus.** Nothing a command sends is ever forwarded to the real bus. The engine
   answers a small `org.freedesktop.DBus` itself (Hello, AddMatch ignored, NameHasOwner/GetNameOwner for the
   secrets name only). It also serves a read-only `org.freedesktop.secrets` itself. Every other destination answers
   `ServiceUnknown`, and every other method answers `AccessDenied`, so the filter is default-deny.
   `org.freedesktop.systemd1` (`systemd-run --user`, `systemctl --user`, `busctl --user`), the portals,
   `org.freedesktop.Flatpak` and everything else on the session bus can't be reached. Owning a name is refused.
3. **The real keyring is touched only by the engine**, over its own connection to the real session bus, with a fixed
   set of calls: SearchItems, the item's Attributes, Label and Locked, OpenSession("plain") and GetSecrets. It never
   calls Unlock, CreateItem, Delete, SetSecret or a Prompt. Unlock can raise a keyring password dialog, and the
   owner's rules forbid such prompts.
4. **Items are judged by the real item's attributes, read by the engine at the moment of each request**, never by
   a path or a name the command sends. An item is served only when (a) it isn't MOSS's own and (b) a grant matches
   it. The command sees object paths the broker made for that connection alone (`/org/freedesktop/secrets/collection/login/<n>`),
   and a path exists only for an item that passed both checks. Every path in a GetSecrets body is checked again.
   Searches are filtered after the real search. A locked item is left out of the answer.
5. **No new package.** The broker is TypeScript in the engine, with its own small D-Bus codec (`dbus-wire.ts`).
   xdg-dbus-proxy was rejected: it filters by name, path and interface only (S8's negative result), it can't filter a
   search's answer, and its socket would be unreachable under the seccomp filter. The deb and the rpm keep
   `bubblewrap` and `libsecret-1-0`, as before.

## What a command may reach

- **MOSS's own items: never.** An item is MOSS's when its label, or any of its attribute values, equals or starts
  with a MOSS store name: anything under `com.waifucave.` (every MOSS store, dev and dist, the `.key` and `.items`
  stores, and the old product's under the same prefix), and the engine's `MOSS_KEYCHAIN_SERVICE` override.
  This deny is checked first. No grant can open such an item, not even one that names it exactly.
- **Other items: only those a grant for the run matches.** A grant is a label for the card plus a set of attributes
  (for example `{ xdg:schema: org.git.Password, server: github.com, protocol: https }`, or
  `{ service: gh:github.com }`). An item matches when it has every one of those attributes with the same value. A
  grant needs at least one attribute besides `xdg:schema`, so no grant opens a whole schema. An empty grant list means
  no broker: the run is exactly as before (no relay, no address, the same bwrap arguments).
- **Operations:** search (filtered), an item's attributes and label (granted items only), and its secret (granted
  items only). The sandbox can't write, delete, lock, unlock, create or prompt.

## Raw keys versus tokens

A git credential helper exists to hand a password or token to git, so the broker gives the granted item's value
to the command that asked for it. That is the line the Windows note draws too: a released token is visible to that
command's processes. What never crosses is a key. MOSS's own secrets, approval tokens, device keys and the secrets
file's key are refused by the deny above, and the user's ssh private keys stay closed (below). "Never hands over raw
stores" holds because the command can't list or read anything a grant doesn't name. A search answers only matching,
granted items, and a collection's item list holds only paths already handed out.

## What the user is asked, and when

The broker asks the run's `credentials` policy (`FencedRun.credentials`): the grants, plus a `refused(item)` callback
for each item it turned away, with the label and attributes, never the value. The card is meant to be per item and
per session: "<bot> wants to use your saved login '<label>' (<schema>, <server or service>) for this session",
with Allow for this session and Deny. The refused call fails at once with
`org.freedesktop.DBus.Error.AccessDenied: moss: ...`, so the command does not hang past D-Bus's 25 s timeout. The bot
runs it again after the answer. **The card itself is not built in this lane.** It needs a new card kind in the
protocol, which belongs to the card and spine lanes. Until it lands, nothing grants an item, and fenced commands on
Linux behave as before. This is question 1 below.

## ssh-agent

**Left closed.** OpenSSH reaches an agent only through a Unix socket path (`SSH_AUTH_SOCK`), and a fenced command
can't make a Unix socket. Opening that door needs one of the options in question 2. Git over HTTPS, with its token
through the libsecret helper, is the working path meanwhile.

## Docker

The registry credential helper `docker-credential-secretservice` uses libsecret, so a granted registry login can be
read through the same broker. `docker login` (a write) is refused. The Docker engine's socket stays unreachable
(the seccomp filter), so `docker pull` from inside the fence still fails. A registry login is not the Docker daemon,
which can start host containers.

## The hostile client

- Every message is parsed in full, against bounds: 1 MiB a message, 64 levels of nesting, 32 attributes a search,
  256 items a GetSecrets, 16 connections and 4 MiB of buffered input a run. Anything malformed or past a bound
  closes that connection. The other connections and the engine carry on.
- File descriptors: TCP can't carry them, `NEGOTIATE_UNIX_FD` is answered `ERROR`, and a message that declares
  `UNIX_FDS` is dropped with its connection.
- A flood: each connection handles one message at a time, and its input past the bound closes it.
- A race at start: the relay listens before it starts the command, and the engine's end exists before bwrap starts.
- The end: the relay exits with the command, the sandbox's pid namespace takes everything else with it, and the
  engine closes its ends of the pipes and its own connection to the real bus when the run returns.
- An object path, sender or destination the command makes up: the broker's paths are its own, matched exactly. The
  real item paths never reach the command.

## What the proofs cover (CI: `core-linux`, `test/fence/linux-secret-broker.e2e.test.ts`)

Each test runs with a real gnome-keyring on a private session bus, plus a stub that owns `org.freedesktop.systemd1`
and `org.freedesktop.portal.Desktop` on that bus. Every refusal is checked against the broker's own error text, and
paired with the same call made outside the fence, which succeeds. So a refusal is the fence's, not a missing daemon.
The unit tests in `linux-secret-broker.test.ts` drive the broker over the pipes with a fake keyring, on any OS.

## Questions for the owner

1. **The card for a saved login.** Options: (a) a new card kind `credential`, per item and per session, with
   "Allow for this session" and no "always". This is one protocol change, the spine's, and the safest choice.
   (b) Reuse the tool card with a rule key, which brings an "always" with it, so a bot keeps the login for good after
   one yes. (c) Grants only in Settings, with no card. Recommendation: (a). The cost is a protocol edit and the
   window's rendering of the card.
2. **ssh signing in the fence.** Options: (a) keep it closed. git over HTTPS works through the helper, and ssh remotes
   fail in the fence as they do today. (b) Let the supervisor (seccomp user-notify) answer the command's `connect()`
   to one fixed path by connecting itself to a MOSS agent that signs only with allowed keys, and putting that socket
   in place of the command's (`SECCOMP_IOCTL_NOTIF_ADDFD`). This adds new code on the boundary. It is x64 and arm64
   only, and it needs its own review against the check-then-use race. (c) Open `socket(AF_UNIX)` and hide every other
   socket by mounts. That is fragile, and it would bring Docker's and the user's own sockets back. Recommendation: (a)
   now, (b) if you want ssh remotes from bots.
3. **Which bots' runs get the broker.** On Linux today, the bot's own Bash tool goes through the runtime, whose
   sandbox is macOS-only. This fence's Linux leg (`fencedSpawner`) runs the computer node's Bash and plugin hooks, so
   the broker serves those runs. When a bot's Bash moves onto `fencedSpawner` on Linux, it gets the broker with no
   further change. That move belongs to another lane.
