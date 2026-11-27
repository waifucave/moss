---
title: Reporting a security problem
description: If you find a security problem in MOSS, report it privately through GitHub. This page says how, what to include and what happens next.
---

MOSS runs bots and agents with real access to your computer: your files, your commands, a browser, and a link to your other devices. Reports about any of that are welcome, and taken seriously.

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
