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

Deleting a conversation or a bot removes it from this computer only, not from your other computers. <!-- pending: deletion -->

Your bots and conversations are files in `~/.moss`, so you can back them up like any other files.
