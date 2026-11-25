---
title: Working across computers
description: One folder tree across your paired computers, where each file tool and command runs, moving folders between computers, the main computer, and running MOSS on a computer with no app.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

Once your computers are [paired](/docs/pairing/), a bot works on all of them as one folder tree. Nothing is copied to every computer and nothing is mounted: each file stays on the computer that holds it, and MOSS asks that computer for it when a bot needs it.

## One folder tree

A bot sees `home/<Computer>/` for each of your computers that runs MOSS: `home/Studio/` is your home folder on the computer called Studio, and `home/Laptop/` the one on Laptop.

- **Reading and changing files** works on any path in the tree. Each call runs on the computer that holds the files, and a search runs there too and sends back only what it found.
- **A command runs on the computer that holds its folder.** `cd home/Studio/web-app && git status` runs git on Studio, at Studio's own speed. A command sees only its own computer's files, so to use a file from another computer, the bot copies it over first, or runs the command where the file is.
- **Moving or copying a folder between computers**, with a plain `mv` or `cp -r`, sends the files straight from one computer to the other. The copy is made in full before anything is removed, so a move cut off half-way leaves the original where it was.
- **A computer that is off** answers *computer offline* at once, so nothing waits on it.

A computer's name is unique whatever its case, and uses only letters, digits and hyphens.

## Whose rules apply

Every action is judged by the [approval level](/docs/approvals/) of the computer it touches, and the computer that holds the files applies its own fence to every request, whoever asks. A move between two computers is judged by both, and one card covers it.

## The main computer

One computer runs your bots' conversations: the **main computer**. MOSS picks it for you: an always-on computer, a server first, then a desktop. You can choose another in Settings, under **Paired devices**, with **Make main**; that asks you on a card first.

The other devices show everything live, and lend the bots their files and commands. When the main computer is off or can't be reached, another of your computers that runs MOSS takes over. When the main comes back, it takes each bot back between turns, never in the middle of one. A phone never runs your bots.

## A computer with no app

MOSS's engine can run on its own, on a computer where you don't use either app, such as a server. Each release has the engine for each system, `moss-core-<version>-<system>`. Download it to that computer, then run it once:

```sh
./moss-core-1.111.1-linux-x64 server install
```

It copies itself to `~/.moss/bin/daemon/moss-core`, with the plugins it ships, starts at login (on Linux, with lingering on, so it runs with no one logged in), and from then on updates itself. To take it away again:

```sh
~/.moss/bin/daemon/moss-core server uninstall
```

That stops it, removes its login start and the files the install put in place, and leaves the rest of `~/.moss`. To pair a computer that has only the engine, run `moss device pair` in its terminal: it prints a code and a line to paste on the other device (`moss device pair --join …`, or join from the app), then shows four words. Check them on the other device and type them to confirm; a wrong word cancels the pairing. `moss device list` shows your devices and `moss device revoke <name>` removes one. While one of your apps or phones is connected to that computer, a pairing or a removal made in its terminal also asks you on a card there; with none connected, MOSS shows you on a card the next time one connects. MOSS's bots can't pair a device; a command you approve to run outside the sandbox runs as you, and so could.
