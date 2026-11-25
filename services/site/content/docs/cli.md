---
title: The moss command
description: The commands of `moss`, MOSS's command line, that you can run today: start a coding session, manage plugins, delete things, and look after the engine.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

`moss` is the engine's own command line. With MOSS Code installed through Homebrew, or either app from a `.deb` or `.rpm`, it is a command in your terminal. Otherwise it is the engine inside the app: on macOS, `/Applications/MOSS.app/Contents/Resources/daemon/moss-core`.

The plugin and delete commands ask the running engine, as you, and never start MOSS themselves: when it isn't running, they say *MOSS isn't running on this computer: start it, then try again*.

## Coding sessions

| Command | What it does |
| :- | :- |
| `moss code [folder] --computer <name> --backend <agent>` | Starts a coding session with that agent in that folder. `--computer` is this computer's name in MOSS (or set `MOSS_COMPUTER`); `--model`, `--effort` and `-p "<prompt>"` set the rest. [MOSS Code and coding agents](/docs/moss-code/#starting-a-session) has an example. |

## Plugins

| Command | What it does |
| :- | :- |
| `moss plugin list` | Your plugins, each with its version and state |
| `moss plugin info <id>` | One plugin: where it came from, what it may do, its tools and settings |
| `moss plugin install <folder, id or npm:name>` | Installs one; it waits for your OK on its card in the app |
| `moss plugin wrap <kind> <file, folder or address>` | Wraps an MCP server, a skill, an agent file or a Claude Code plugin ([more](/docs/wrapping/)) |
| `moss plugin enable <id>`, `moss plugin disable <id>` | Turns one on or off |
| `moss plugin restart <id>` | Restarts one |
| `moss plugin remove <id>` | Removes one, after asking y/N; `--delete-data` deletes its data too |
| `moss plugin update [<id>]` | Checks for updates and applies them, to all or the one named |
| `moss plugin pin <id>`, `moss plugin unpin <id>` | Holds one at its version, or lets it update |
| `moss plugin index list`, `moss plugin index add <url>`, `moss plugin index remove <url>` | The plugin indexes you search |
| `moss plugin logs <id>` | A plugin's log, newest last; `-n` sets how many lines |
| `moss plugin dev <folder>` | Adds a development folder, which reloads on every change; `dev list`, `dev renew` and `dev remove` too |
| `moss plugin new <template> <folder>` | Writes a plugin from a template: `tool`, `theme`, `ui`, `model`, `trigger` or `point` |
| `moss plugin validate <folder>` | Checks a plugin folder without running it, and says what its card will say |

`new` and `validate` work without the engine running. [Write your first plugin](/docs/first-plugin/) goes through them.

## Deleting

Each says what goes and what stays, and deletes nothing until you type the word it asks for.

| Command | What it does |
| :- | :- |
| `moss session delete <session>` | Deletes a coding session, or a bot's conversation, on this computer, after you type DELETE |
| `moss bot delete <bot>` | Deletes a bot for good, on this computer, after you type DELETE. Archiving it in the app keeps it instead. |
| `moss account delete` | Deletes your account at WaifuCave, after you type DELETE ([what goes](/docs/privacy/#paired-devices)) |
| `moss erase` | Erases everything MOSS keeps on this computer, after you type ERASE. Quit both apps first. ([Removing MOSS](/docs/uninstall/#2-erase-what-moss-keeps-on-this-computer)) |

## The engine

| Command | What it does |
| :- | :- |
| `moss autostart status` | Whether the engine starts at login |
| `moss autostart disable` | Stops it starting at login; it keeps running until you quit MOSS |
| `moss autostart enable` | Starts it at login again |
| `moss autostart remove` | Stops the engine and removes its login start, as in [Removing MOSS](/docs/uninstall/) |
| `moss engine reset` | For an app that can never connect: takes the engine's own copy out of `~/.moss`, so the next app start installs its own. Quit MOSS first. It touches no conversation, setting, key or plugin. |
| `moss --version` | The engine's version |
