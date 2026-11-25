---
title: The command sandbox
description: What a bot's shell commands can and can't touch on macOS, Windows and Linux, at each approval level, and how a bot asks for a folder.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

Every shell command a bot runs goes through a sandbox. It decides which folders a command may write, what it may read, and keeps it off the network. A command runs outside the sandbox only when you say yes to a card for that one command ([Approvals](/docs/approvals/#the-sandbox-around-commands)).

## On each system

- **macOS**: the Mac's own sandbox.
- **Linux**: bubblewrap. The `.deb` and `.rpm` install it; with the `.AppImage`, install bubblewrap yourself. Without it, or where the system turns off what it needs (Ubuntu's AppArmor can switch off user namespaces), MOSS refuses each command instead of running it unsandboxed.
- **Windows**: a bot's **Bash** is Git for Windows' bash, with its usual tools, and its **PowerShell** is Windows PowerShell. Both run as a separate, restricted account that MOSS sets up, held to the same rules as on the other systems. Bash needs Git for Windows installed. Until the restricted account is set up on a computer, MOSS refuses each command, and the refusal says how to set it up.

MOSS's own coding agent in MOSS Code runs its commands the same way, on Windows too.

## What a command may write

What a command may write depends on the computer's [approval level](/docs/approvals/):

| Level | Shell commands write to |
| :- | :- |
| **Ask** and **Ask before risky actions** (the default) | the bot's own folders, the session's folder and the temp folder |
| **Accept edits** | those, and the folders at the top of your home, such as Documents, Downloads and your projects' folders; never `~/Library`, a dot-folder or the files at the top of your home |
| **Fully automatic** | your whole home |

At the default level, that's why a bot's commands run without asking: what they can change is already held in.

## What a command never touches

At every level, and whatever folder you give it:

- **The network.** A command reaches no network, and no socket on your computer either: not MOSS's own, not an SSH agent's, not Docker's. A bot reaches the web through its web tools instead.
- **MOSS's own settings**: approval levels, saved rules, keys, the device list, plugins and their data. A bot changes those only through MOSS, which asks you on a card.
- **Your secret places**, read or written: `~/.ssh`, `~/.gnupg`, `~/.aws` and other cloud sign-ins, `~/.netrc`, `~/.docker/config.json`, package registries' tokens, `gh`'s sign-in, and coding agents' own sign-in files.
- **Places that would run something later**, outside the sandbox: where your system starts programs at login, shell startup files, folders on your `PATH`, and a repository's `.git/hooks`.

## Asking for a folder

When a command needs to write somewhere its level doesn't let it, the bot asks with its **RequestAccess** tool. You get a card, *Give shell commands write access*, naming the bot, the folder and the computer. Say yes, and the bot runs the command again at once, under the wider sandbox. **Always allow** keeps that folder for that bot only.

Some places are never given to shell commands, and the bot is told so without a card: a dot-folder, `~/Library`, a `.git` folder, a folder on your `PATH`, anything outside your home, and MOSS's own folder. The bot's file tools can still reach those, and ask you first.

Network access can't be given to shell commands yet: the bot is told to use its web tools.
