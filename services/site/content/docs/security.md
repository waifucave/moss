---
title: Reporting a security problem
description: If you find a security problem in MOSS, report it privately through GitHub. This page says how, what to include and what happens next.
---

MOSS runs bots and agents with real access to your computer: your files, your commands, a browser, and a link to your other devices. Reports about any of that are welcome, and taken seriously.

## What the engine can tell about its own apps

When you approve something in MOSS or MOSS Code, the engine has to trust that the press came from the real app. How sure it can be depends on your system.

- **macOS** checks each app's code signature while it runs: only MOSS's signed apps, which refuse injected code and debuggers, can answer for you.
- **Linux and Windows** have no such check, so MOSS checks the little they allow. On Linux, the app must run from a file with MOSS's name, laid out as MOSS's app, not replaced while it runs, and not traced by another program. Only a copy installed by your package manager, owned by the system, counts as verified; an AppImage or a copy in your home folder is accepted but noted as unverified. On Windows, the app must run from the file MOSS's installer put in your user folder, at medium integrity or above.

These checks only turn away a script that copied MOSS's connection key and doesn't pose as the app. They can't stop a program that already runs as you, and they don't prove that the app is MOSS. Such a program could put its own code in a file named and laid out like MOSS's. It could start the real app with its own code loaded into it, even the copy your package manager installed. It could also replace a copy of the app that you can write. On Linux with `kernel.yama.ptrace_scope` set to 0, it could attach to the running app. Any of these lets it approve cards as MOSS, including the ones your other devices act on. If something you don't trust runs on your Linux or Windows computer outside MOSS's sandbox, treat that computer as able to act as you in MOSS.

## How to report

Please don't open a public issue, discussion or pull request for a security problem. Report it privately on GitHub instead: in the repository, open **Security**, then **Advisories**, then **Report a vulnerability**, or go straight to [the form](https://github.com/waifucave/moss/security/advisories/new).

It helps to include:

- your MOSS version, which `moss --version` prints, and your system and its version;
- which part is affected: the engine, the command line, an app, the link between your devices, a plugin;
- what someone could gain, and what access they would need to begin with;
- the steps that show it, or a proof of concept.

## What happens next

- You hear back within 5 days.
- Once the problem is reproduced, you get an assessment and a rough timeline for the fix.
- You are credited in the advisory and the release notes, unless you'd rather not be.
- Please give us reasonable time to ship a fix before you disclose it publicly. We'll tell you when the fix is out.

Fixes ship in a new release; only the latest release is supported, and the apps update themselves. The full policy is the repository's [SECURITY.md](https://github.com/waifucave/moss/blob/main/SECURITY.md).

## A known limit on Linux

On macOS, a bot's command can't make a new repository or a file that runs later (a `.git`, `.husky`, `.envrc`, `.vscode`) anywhere it writes: the sandbox refuses the write. Linux's sandbox can't refuse a name that doesn't exist yet. It holds the ones that are there when the command starts, and when the command ends it moves aside anything it finds put in their place (the original isn't restored), but a command of a bot on your own computer can still make a new repository with hooks, which then run when you use git there. For a command from another of your computers, MOSS also checks the one folder it was given when the command ends, moves aside anything of that kind the command made, and tells the bot if the folder couldn't be fully checked. A proper fix needs to know who made each file, which Linux's sandbox can't tell today. It is planned after the first release.
