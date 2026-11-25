---
title: Systems
description: MOSS runs on macOS, Windows and Linux. This page says what each one needs, and where MOSS works differently on each.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

## What each needs

| System | Version | Chips |
| :- | :- | :- |
| macOS | 27 or later | Apple silicon |
| Windows | 11 | x64 |
| Linux | Ubuntu 26.04 LTS, current Fedora | x64 and arm64 |

[Install](/docs/install/) says which file to download for each.

## Where they differ

| | macOS | Windows | Linux |
| :- | :- | :- | :- |
| **Installer** | a `.dmg`, signed and notarized by Apple | an installer that isn't code-signed at first, so Windows may warn that it doesn't know the publisher | a `.deb` or `.rpm`, or an `.AppImage` anywhere else |
| **The engine at login** | a launch agent | a scheduled task | a `systemd --user` service |
| **The sandbox around commands** | the Mac's own sandbox | a separate, restricted account | bubblewrap; the `.deb` and `.rpm` also install the security profile it needs on Ubuntu, which an AppImage can't |
| **Your keys** | the Keychain, readable only by MOSS's engine | an encrypted file whose key Credential Manager keeps | an encrypted file whose key the Secret Service keeps, or `systemd-creds`, or, with neither, a key file only you can read |
| **A plugin's code** | fenced from MOSS's keys and from the engine's door | runs as you; its card says it could read MOSS's logins and approve its own cards | runs as you; its card says it could read MOSS's logins and approve its own cards |
| **The island** | at the top of the screen | at the top of the screen | at the top of the screen; on Wayland, an ordinary window, since Wayland doesn't let a window stay on top |

The apps, your bots, MOSS Code, plugins, cards and pairing work the same way on all three.
