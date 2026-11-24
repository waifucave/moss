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
- Lower a computer's level, which decides what a session may do without a card (`computer.setLevel`). A raise is refused to every caller but
  the user's own terminal (`computers/rpc.ts`), so a phone can only make a computer stricter.
- Change the main computer (`main.set`): a call from outside the terminal raises a card for it.
- Rename devices (`device.rename`) and revoke them (`device.revoke`), its own and any other paired device's but this computer's own: a revoke
  from outside the terminal raises a card for it, which is applied when the card is approved (`devices/rpc.ts`).

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

Where a phone's file goes: for a bot, the bot's own scratch folder, where a file dropped on the desktop is copied; for a coding session,
`.moss-received/<session>/` in the user's home. A coding agent's sandbox denies the whole MOSS home and the manager refuses any request into
it, so `outputs/<session>/received/` (the first version's place) could not be read by any agent. The message names the file by its
folder-tree path and the agent is told the real path (`promptOf`; every message's files now, the desktop's included). A file is written
mode 0600 in a folder the engine makes, never overwriting and never through a link; what launches by being opened (an app, a script a
system opens, an installer, a Windows program) and the bytes of an executable are refused.

## What a phone still cannot do

Edit, remove, restore or move a bot; set a bot's user layer or plugin settings; install, remove or configure a plugin; change settings;
pair a device; read or write the folder tree. (It can read any bot's instructions, `bot.instructions.get`; that is one of the older 47.)
The remote role's list is the whole of it, and a test fails if a call is added to or taken from it.

## A lost phone

A phone that is lost or stolen and still paired is, to the engine, the owner at the keyboard. Everything above is open to whoever holds it
and can unlock it, until the phone is revoked. The engine does not and cannot tell the owner from a thief by what is asked; what bounds a
lost phone is, in order:

1. The phone's own lock and the app's lock, which are outside the engine.
2. Revocation, from the desktop or any other paired phone (`device.revoke`): the phone's open connections are ended and its tokens revoked
   at once (`ipc/link-clients.ts`), and the doors PH2 and PH3 added also read the registry at each call, so a call that races the
   revocation is refused. Revoking does not undo what it did: the sessions it started, the bots it made and the files it sent stay and are
   the owner's to stop, archive or delete on the desktop (a phone cannot archive or remove a bot).
3. The limits above: five bots a day, 500 MiB and 200 files a day, four uploads open, nothing executable, no file outside a folder the engine
   picks, and a name and a model for a bot, never its instructions. A picture, once whole, leaves the sweep's ledger (like a picture the
   desktop stages, it stays in the session's temp folder); only the daily cap bounds the pictures a phone sends and no message names.
4. The cards. A start in a folder this computer has never run a session in, a backend with no sandbox the engine counts on, and the tools a
   session asks to use raise cards. A phone answers them with its own answer key, so whoever holds the phone can answer them too: a card is
   no barrier against a thief who has the phone, and is a barrier only for what is not answered from that phone.

Two things a thief on a still-paired phone can do that cost the owner more than the new doors do, and were already true: revoke the
owner's other devices and move the main computer. Both raise a card, and a phone answers cards with its own key, so the card does not stop
a thief who holds the phone. They are in the older 47 and are not changed here; whether such a card should be answerable only from the
desktop is the owner's decision. (Lowering a computer's level makes it stricter, and a raise is refused to a phone, so the level is not
a way in.)
