---
title: The home folder
description: Everything MOSS keeps is in one folder, ~/.moss. This page says what is in it, where your keys are instead, and what to keep in a backup.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

MOSS's engine keeps everything in one folder in your home: `~/.moss` (on Windows, `.moss` in your user folder). Both apps share it.

## What's in it

| Folder or file | What it holds |
| :- | :- |
| `bots/` | Each bot's record, its instructions, its memory (`memory/`) and what the coding agents it started did (`agents/`) |
| `transcripts/` | Each bot's conversation and its side threads, such as routine runs |
| `sessions/` | MOSS Code's sessions |
| `routines/` | Each bot's routine files, in a folder per bot |
| `memory/` | MOSS Code's dispatch memory, and a record of which of its files changed |
| `scratch/` | Bots' working files on this computer, a folder per bot |
| `archive/` | Archived bots, whole |
| `plugins/` | Installed plugins, a folder each |
| `settings.json` | Your settings |
| `logs/` | MOSS's logs: the engine's `daemon.log`, and a log per plugin |

There are a few more folders MOSS uses for itself, such as `run/` and `runtimes/`. A project can also hold settings of its own, in `.moss/settings.json` inside the project's folder.

## Where your keys are

Your keys and sign-ins are not in this folder on macOS: they are in the Keychain, readable only by MOSS's engine. On Windows and Linux they are in an encrypted file in this folder, `secrets.enc`, whose key your system's secret store keeps. [What leaves your computer](/docs/privacy/#what-stays-on-your-computer) says more.

## Backing it up

Your bots, their conversations, memory and routines, your sessions and your settings are ordinary files here, so a copy of `~/.moss` keeps them. A copy doesn't carry your keys: on a new computer you add your providers again.
