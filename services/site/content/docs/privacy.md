---
title: What leaves your computer
description: What MOSS keeps on your computer, and every connection it makes: to your model provider, to Exa for web searches, to GitHub for updates, between your devices, for webhook routines, and to wherever a plugin or a download you OK'd goes.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release. MOSS's privacy policy comes with the release; this page says what the code does.

MOSS runs on your computer. It has no analytics, no telemetry and no crash reports, and you don't need an account to use it. What does leave your computer is below, each with what it carries.

## What stays on your computer

Your bots, their conversations, memory and routines, your coding sessions, your settings and MOSS's logs are files in one folder, `~/.moss`. They stay until you delete them, apart from the empty coding sessions MOSS clears away (below). Archiving a bot moves it aside and deletes nothing. Deleting a conversation or a bot removes it from this computer only, not from your other computers ([Deleting](/docs/archiving/#deleting)). **Erase everything** in Settings deletes all of it, as in [Removing MOSS](/docs/uninstall/). The engine's log, `~/.moss/logs/daemon.log`, is rotated at 8 MB with one older copy kept.

Your keys and sign-ins are kept apart from that folder: in the Keychain on macOS, and on Windows and Linux in an encrypted file whose key your system's secret store keeps. On a Linux computer with no secret store, that key is a file only you can read, and MOSS says it is one.

## Your model provider

Everything a bot or MOSS's own coding agent works with goes to the model provider you chose for it, with your key or sign-in:

- what you write, and the files and pictures you attach;
- the bot's instructions, its memory and MOSS's own instructions to it;
- what its tools return: a file it read, a command's output, a web page.

A few background jobs use the same provider, without a message from you:

- **Titles** for your sessions.
- **The safety check**: at the default level, a command a bot runs, or a tool from a plugin that isn't MOSS's own, can go to the provider for a review before it runs.
- **MOSS Code's memory**: at most every two hours, MOSS reads what happened in your MOSS Code dispatch session, up to 200,000 characters at a time, and keeps notes from it.
- **Clearing empty sessions**: a coding session idle for a day or more is read, up to 4,000 characters of it, and deleted if the model judges there is nothing in it worth keeping. Each pass judges at most 10 sessions. A session with nothing in it at all is deleted after a while without asking the model.

Coding agents you install, such as Claude Code or Codex, talk to their own company under your account with them, by their own terms. MOSS starts them; it doesn't sit between them and their company.

## Your voice provider

With a voice set up (MOSS comes with a plugin for Fish Audio), the replies a bot speaks go to that provider as text, and what you say while you hold the talk button goes to it as sound, with your own key. Without a voice, nothing goes.

## Web searches go to Exa

When a bot searches the web, the words searched for (and how many results it wants) go to Exa, a search company, from your computer's IP address. This is on from the start and needs no account or key: MOSS uses Exa's public service, and you have no account or terms of your own with Exa.

There is no switch for search alone. To stop it, turn off the *Web search and fetch* plugin, in MOSS Code's Plugins page or from a terminal:

```sh
moss plugin disable moss/web
```

That turns off reading web pages too. A page a bot reads is fetched straight from your computer, not through anyone.

## Updates come from GitHub

Both apps check the project's releases on GitHub when they start and every 4 hours, download a new version on their own, and install it when MOSS has nothing running. There is no setting to turn this off. GitHub sees your IP address, and from the files asked for, the version you have.

## Paired devices

When you pair your computers and phones:

- **A WaifuCave service** helps them find each other, with or without an account. When you pair by code it holds a sealed pairing slot for up to 10 minutes. For each pair it keeps the devices' public keys and sealed address records, and holds sealed messages for a device that is briefly away, for up to two minutes. Sealed means only your devices can open it.
- **Public STUN servers** at Cloudflare and Google tell each device its own network address, and see its IP address.
- **n0's address lookup** helps devices without an account find each other.
- **A relay** carries the traffic of two devices that can't connect directly: n0's public relays unless you choose a relay server of your own, or none, in Settings under **Relay** ([Relays](/docs/relays/)). What your devices say to each other is encrypted end to end, so a relay can't read it. It does see their IP addresses, which of them are online, which talk to each other, and how much they send.
- **Public time servers** at Cloudflare and Google keep your devices' clocks in step while they are linked.
- **Phone notifications** say only how many things are waiting, never what they are. The [phone apps](/docs/phones/) are being built.

If you signed in to an account at WaifuCave, **Delete account** in Settings, or `moss account delete` in a terminal, deletes it for good: your sign-in, your devices' list with their names and keys, your phones' push addresses, your computers' webhook keys and the webhooks waiting for them. Your other computers and phones sign out the next time they reach WaifuCave. Your conversations, bots, memory, settings and files, and your providers' keys, stay on your computer.

## Webhook routines

A routine that starts when a service calls its webhook gets that call through a WaifuCave forwarder by default. The forwarder receives the call over an encrypted connection, seals it at once so only your computers can open it, and holds it until one of them takes it, for at most 7 days. While it seals the call, the forwarder sees it.

## Downloads you OK

Some things are downloaded only after you say yes on a card, and come from where the card says: the adapters Claude Code and Codex need, from npm, checked against fingerprints their plugins name; a plugin from npm or from an address you gave.

## Plugins

A plugin's card says which hosts its code may reach, and a tool that can reach any public website says so on its card. What a plugin sends there is up to the plugin: install the ones you trust. [Plugins](/docs/plugins/) has more.

If you see MOSS connect anywhere this page doesn't name, please tell us through the [security policy](https://github.com/waifucave/moss/blob/main/SECURITY.md).
