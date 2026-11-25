---
title: Memory
description: Each bot keeps notes for itself in a memory folder of its own, as ordinary files. This page says where they are, how a bot uses them, how to read them, and how MOSS Code keeps its own notes.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

## A bot's memory

Each bot keeps notes for itself in a memory folder of its own. At its top is an index, `MEMORY.md`, which the bot keeps up to date and which links to its other memory files. A bot remembers what you tell it to, and what it decides is worth keeping: your preferences, the people and projects it works with, how a job went last time.

There is no special memory tool. The bot reads and writes its memory files with the same file tools it uses for anything else, and its instructions tell it where they are.

## Where it is

A bot's memory is in `~/.moss/bots/` on the computer that runs the bot, in the bot's own folder, under `memory/`. Beside it, `agents/` holds what the coding agents the bot started did. A bot also has a scratch folder for working files, `~/.moss/scratch/` and its name, kept on each computer and not part of its memory.

## Reading it

Open the bot's settings and find **Memory**: every file the bot keeps, with its size and when it last changed. Press one to read it. This view is read only. To change what a bot remembers, tell it: *"Forget the old address,"* or *"Remember that I'm away the first week of March."*

## MOSS Code's memory

MOSS Code's dispatch session, where you hand out work to coding agents, has a memory of its own. At most every two hours, once enough has happened, MOSS reads the recent conversation there and turns it into a few memory files: lasting things such as your preferences, your projects and the decisions made, never a copy of what was said. It is told never to keep secrets, keys or passwords, and when you ask it to forget something, it deletes it and doesn't write it again.

These files are in `~/.moss/memory/`. MOSS keeps a record of which of them changed and when, in `~/.moss/memory/audit.jsonl`, never what one says. Writing them uses your model provider. [What leaves your computer](/docs/privacy/#your-model-provider) says how much it reads at a time.

## Archived bots

Archiving a bot keeps its memory with it, and bringing the bot back brings its memory back too. [Archiving a bot](/docs/archiving/) has the rest.
