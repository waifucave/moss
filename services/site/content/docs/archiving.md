---
title: Archiving a bot
description: Archiving puts a bot away without deleting anything, and bringing it back brings its conversation, memory and routines whole. This page also says what deleting will do.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

## Putting a bot away

Open the bot's settings and press **Archive** and its name, under **Archive**. The bot leaves your list of bots. Nothing is deleted: its conversation, its memory, its instructions and its routines move together into `~/.moss/archive/bots/`, in a folder of the bot's own. Its routines don't run while it is archived.

## Bringing it back

MOSS's Settings (press **You** at the bottom of the list of bots) list your archived bots under **Archived bots**. Press **Bring back** beside one: its conversation, memory and routines come back with it, whole.

## Deleting

Deleting is for good. Open the bot's settings, and under **Delete**:

- **Delete the conversation with** and the bot's name deletes its messages, the files sent to it, its side threads and the agents it started. The bot, its memory and its files stay, and the conversation starts again, empty.
- **Delete** and the bot's name deletes the bot: its instructions and settings, its conversation, its memory, its scratch files, its routines and the rules you saved for it. Files it wrote in your folders stay, and so do your other bots.

An archived bot is deleted from **Archived bots** in Settings, with **Delete** beside it. Each time, a card says what goes and what stays, and nothing is deleted until you say yes on it.

Deleting removes it from **this computer only**. Your other computers keep their copies until you delete it there too, and this computer never takes them back.

From a terminal, `moss session delete <session>` and `moss bot delete <bot>` do the same, after you type DELETE.

Your bots and conversations are files in `~/.moss`, so you can back them up like any other files.
