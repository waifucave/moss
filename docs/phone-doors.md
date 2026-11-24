# What a paired phone can do, and what a lost one can

Owner: lane PH. Written with PH3's follow-up (2026-11-24). The facts here come from the remote role's list
(`packages/protocol/generated/moss/allowlists.json`, pinned by `packages/protocol/test/remote-start.test.ts`: 55 calls) and from the
doors named below.

A phone is the role `remote`. Every call it makes arrives as the person's own (`{ kind: "user", client: "ios" | "android", device }`, the
client taken from the device registry, never from what the phone says). The doors added for phones (PH2, PH3) also ask the registry, at
each call, whether this device is still paired, not revoked and holding an answer key (`mayStartSessions`), so a revocation that races a
call ends it.

## What a phone could already do before PH2 and PH3 (its 47 older calls)

These are open to a paired phone today and were not changed by PH2 or PH3:

- Answer every card (`card.answer`), including the cards a start from that same phone raises (a start in a new folder, an unsandboxed agent,
  a tool's OK). A card a phone answers is answered with that phone's own answer key, so a stolen phone holds the key that answers it.
- Message every bot and every session on the computer (`session.send`, `session.answer`, `session.interrupt`, `session.stop`,
  `bots.pause`, `bot.markRead`), and read every bot's conversation, every session's history, diffs, outputs and context
  (`bot.conversation`, `session.history`, `session.diff`, `session.outputs`, `session.context`, …).
- Run any plugin's command (`command.run`).
- Watch the person's browser: `browser.stream` is on the phone's list, so a phone can have the computer send a browser tab to it live, as
  video, by the tab's id. The call does not ask whose tab it is (the protocol's definition, `packages/protocol/src/browser.ts`; what the
  desktop app does with the request is the app's side, which this page does not vouch for).
- Switch the model of a session or a bot (`session.setModel`), to any model the computer offers, with any effort. A phone cannot start a bot or
  session that was never there, but it can make every message after that run on the dearest model the person has signed in to, so it can
  run up the person's provider bill.
- Have a bot read a file and relay it. A phone can message any bot (`session.send`) and read the bot's conversation (`bot.conversation`); a
  bot's file reads have no path limits by design (the owner's ruling), so it can open every file in the person's home but MOSS's secrets
  and the files the engine guards. "Read ~/Documents/taxes.pdf and tell me what is in it" therefore moves a file's contents to the phone by messaging alone, with no
  card, no file transfer and nothing the file limits below bound.
- Lower a computer's level, which decides what a session may do without a card (`computer.setLevel`). A raise is refused to every caller but
  the user's own terminal (`computers/rpc.ts`), so a phone can only make a computer stricter.
- Change the main computer (`main.set`): a call from outside the terminal raises a card for it, which the same phone can answer.
- Rename devices (`device.rename`) and revoke them (`device.revoke`), its own and any other paired device's but this computer's own: a revoke
  from outside the terminal raises a card for it, applied when the card is approved (`devices/rpc.ts`), which the same phone can answer.

## What PH2 and PH3 added

- Start a coding session in any folder under this computer's home, with any installed backend (`agent.start`, and the three reads of the
  start sheet). The start raises the same cards the desktop's does, answered on the phone.
- Make a bot (`bot.create`): a name and a model only. A call that also carries instructions, an effort or a face is refused (not
  dropped), so the app learns. At most 5 bots per device in any 24 hours (`PHONE_BOT_CREATES_PER_DAY`): a person makes a few bots a day at
  most, and five leaves room for a bad afternoon of trying names while bounding what a lost phone can fill the list with. The count is kept
  in `transcripts/.phone-bot-creates.json`, so a restart does not forget it. The desktop's own create has no cap.
- Send a file (`session.stageFile`) or a picture (`session.stagePicture`) to a bot's conversation or a coding session on this computer, in
  chunks of 512 KiB (the phone link ends a stream at 1 MiB a frame). One file is at most 50 MiB and 10 go in a message; one picture at most
  5.8 MiB (the desktop's own cap). A device has at most 4 uploads open, 100 MiB or 40 files staged and unsent, and sends at most 500 MiB and
  200 files a day, counted on the bytes received and kept across a restart. A half-sent upload is removed after 15 minutes, a finished file
  no message named after 24 hours; both on a timer, not only at the next call. A phone may name in `session.send` only files and pictures
  that same device staged for that same session.
- Read what a conversation's composer offers (`session.composerOffers`): changes nothing.

Where a phone's file goes: for a bot, the bot's own scratch folder (`<home>/scratch/<bot>/attachments/`, where a file dropped on the
desktop is copied; it is the bot's, moves with the bot into the archive and comes back with it). For a coding session, a folder of its own
BESIDE the MOSS home, named after it: **`~/.moss-received/<session>/`** (for the dev app `~/.moss-dev-received/`; for any other home, `<that
home>-received`). It is not inside the MOSS home because a coding agent's sandbox denies the whole home, and the manager refuses any request
into it, so `outputs/<session>/received/` (the first version's place) could not be read by any agent; and it is not a carve-out of that
deny, because several separate sandboxes apply it and one hole per session would be fragile. It is derived from the MOSS home setting, never
from `homedir()`: a dev, preview or test daemon on a throwaway home writes only beside that home. Where that home is not in the person's
home folder the folder tree cannot name the file, so a coding session's file is refused with a plain message. The test preload sets
`MOSS_TEST_WRITE_ROOT` to the run's own temp root, and with it set the stager refuses any received folder outside it, so a test cannot
reach the real `~/.moss-received` by this path.

The person can open that folder: it is an ordinary folder in the home, one folder per session, then one per file (`phone-<id>/<name>`), each
file mode 0600, the folders 0700. It is hidden only by the leading dot (macOS and Linux). On Linux it is the same as on macOS: made 0700,
refused unless it is a plain folder owned by this user and the real path of what was made is the expected sibling. On Windows a leading dot
does not hide a folder, and the folder is not hidden: the person should find it. There the mode bits mean nothing and there is no owner id to
compare, so the folder takes the ACL its parent hands down when it is made (the profile's: the user, SYSTEM and administrators), set from
the first byte it exists and not tightened by the engine, and a link or junction in its place fails the same real-path check. That is the
state of the code, not something run on Windows from here.

The message names the file by its folder-tree path and the agent is told the real path (`promptOf`; every message's files now, the
desktop's included). A file is written mode 0600 in a folder the engine makes, never overwriting and never through a link; what launches by
being opened (an app, a script a system opens, an installer, a Windows program) and the bytes of an executable are refused.

How long a file stays, and what removes it (`packages/core/src/bots/staged-files.ts`, on a timer every 5 minutes while anything is held and
at every call):

- An upload nobody finished is removed after 15 minutes; a finished file no message named, after 24 hours.
- **A file a message named stays 14 days after that message** (`namedKeepMs`): the agent reads it in the turn that names it, a later turn
  may still say "the file I sent", and two weeks outlasts a long task and still gives the person's home back what a session no longer
  needs. And **a session keeps at most 500 MB of named files** (`sessionKeepBytes`); over it, the oldest go first. The day's cap alone
  (500 MiB) would let 14 days of it pile up. A named file in a bot's scratch is the bot's, and stays with it.
- A coding session the computer's host no longer holds (the host's `forget`, which today only a bot's archive reaches, for the sessions that
  bot owned) has its folder deleted by the next sweep, within 5 minutes. A session that has ended but is still held keeps its files under the
  two bounds above, because its conversation can still be read and names them. There is no other way to remove a coding session in this
  engine today; if one is added, the same sweep covers it. What an archive does to a bot's files: they go into the archive with the bot and
  come back with it (scratch); nothing of it is in `~/.moss-received`.
- Empty `phone-<id>` and session folders are removed, and the received folder itself once nothing is in it.
- Cleanup never deletes by a name an agent can aim elsewhere. An agent that may write the session's folder can swap `phone-<id>` for a link
  between a check and a delete; so the folder is first renamed into the engine's own spool (`transcripts/.staged-files/drop-<random>`; a
  rename moves the link itself, never what it leads to), and the delete is done there. If the rename cannot be done (the folder is gone, or
  the spool is on another volume) nothing is deleted. The same holds in the bot's scratch folder and on the placing's error path.

## What a phone still cannot do

Edit, remove, restore or move a bot; set a bot's user layer or plugin settings; install, remove or configure a plugin; change settings;
pair a device; read or write the folder tree. (It can read any bot's instructions, `bot.instructions.get`; that is one of the older 47.)
The remote role's list is the whole of it, and a test fails if a call is added to or taken from it.

## A lost phone

A phone that is lost or stolen and still paired is, to the engine, the owner at the keyboard. Everything above is open to whoever holds it
and can unlock it, until the phone is removed. The engine does not and cannot tell the owner from a thief by what is asked. In plain words,
a person holding a paired, unlocked phone can:

- read every bot's conversation, every session's history, diffs and files it names, and message any of them;
- have any bot read any file in the home it can open and relay what is in it into the conversation the phone reads (exfiltration by
  messaging alone, bound by nothing below);
- watch the person's browser, live, tab by tab (`browser.stream`);
- run up the person's provider cost: change the model of a session or a bot to the dearest one (`session.setModel`), start coding sessions
  (`agent.start`) and send to bots, with no limit on how many messages;
- start coding sessions in any folder of the home, make up to five bots a day, and send files and pictures within the limits below;
- remove the person's other devices (`device.revoke`) and move the main computer (`main.set`). Each raises a card, and a phone answers
  cards with its own answer key, so **the card stops nobody who holds the unlocked phone**: it is a mis-tap check, and a notice on the
  person's other devices. The owner decided on 2026-11-24 to keep it so (a paired phone is a full remote, its own cards included); nothing
  in the code changes for it.

What the person does about a lost phone: on any of their computers, open Settings, find the phone in the devices list and remove it
(Settings' devices list calls `device.revoke`; Settings closes while the card waits). Removing asks for a card, answered on that computer. Once it is answered,
that computer cuts the phone's links at once (the registry's change reaches the transport in the same process, `links/transport.ts`
`#revoked`, which shuts the link with `CLOSE_REVOKED`; a later connection from its key is closed as `revoked`; and the phone doors read the
registry at every call, so a call racing the removal is refused). Then the removal is told to the account service, the push and hooks
services and the devices' group, each step kept and retried until the service confirms it (`devices/account-devices.ts`). So the speed
is: this computer at once; another computer when the account's device list or the group reaches it, which is when it is next online. A computer that is off or cut off until then still lets the phone in. Removing does not undo anything: what the
phone started, made, sent or relayed stays, and a guided rotation of the synced keys it held starts; keys it already holds cannot be taken
back.

What bounds a lost phone before then, in order:

1. The phone's own lock and the app's lock, which are outside the engine.
2. The removal above, from any computer's Settings or from another paired phone.
3. The limits on the doors PH2 and PH3 added: five bots a day, 500 MiB and 200 files a day, four uploads open, nothing executable, no file
   outside a folder the engine picks, a name and a model for a bot and never its instructions. A picture, once whole, leaves the sweep's
   ledger (like a picture the desktop stages, it stays in the session's temp folder); only the daily cap bounds the pictures a phone sends
   and no message names. None of these limits bounds messaging, model choice, browser watching or what a bot relays.
4. The cards for a start in a folder this computer has never run a session in, a backend with no sandbox the engine counts on, and the
   tools a session asks to use. They are no barrier to a thief holding the phone, for the reason above, and a barrier only for what is not
   answered from that phone. (Lowering a computer's level makes it stricter, and a raise is refused to a phone, so the level is not a way in.)
