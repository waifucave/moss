---
title: Removing MOSS
description: How to remove MOSS completely today, in order: stop the engine and its login start, remove the apps, then remove your data. Removing one app leaves the other working.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

MOSS and MOSS Code share one engine and one home folder. **Removing one app leaves the other working**, with all your bots and sessions. To remove MOSS completely, do these in order.

## 1. Stop the engine and its login start

The engine starts every time you log in, and it keeps its own copy under `~/.moss`, so it would go on starting after the apps are gone. Quit both apps, then remove its login start, which also stops the engine:

```sh
moss autostart remove
```

It prints `autostart removed (dist); the daemon:` and what happened to the running engine. Where `moss` isn't a command in your terminal, run the engine inside the app instead:

- **macOS**: `/Applications/MOSS.app/Contents/Resources/daemon/moss-core autostart remove` (or the same inside `MOSS Code.app`).
- **Linux**: the `.deb` and `.rpm` put `moss` in `/usr/bin`, so the command above works.
- **Windows**: the uninstaller does this step for you, unless MOSS Code is still installed.

## 2. Remove the apps

- **macOS**: drag MOSS and MOSS Code from Applications to the Trash. If you installed with Homebrew, `brew uninstall --cask moss` and `brew uninstall --cask moss-code` remove them instead; MOSS's cask removes the login start only when MOSS Code isn't installed, and `--zap` also removes each app's caches, preferences and logs, nothing else.
- **Windows**: remove each app from **Settings**, **Apps**.
- **Linux**: remove the `moss` and `moss-code` packages with your package manager, or delete the `.AppImage`.

## 3. Remove your data

Nothing removes your data for you today: your bots, conversations, memory, routines, sessions and settings stay in `~/.moss` until you delete that folder yourself. Delete it only once you are sure: it can't be undone, and archived bots are in it too.

In a later release, **Erase everything** in Settings will do this for you. <!-- pending: deletion -->

Your keys aren't in that folder on macOS. They are Keychain items of the service `com.waifucave.moss.core`: remove them in Keychain Access by searching for that name. On Windows and Linux, the keys are in `~/.moss`, and the key that unlocks them is in Credential Manager or the Secret Service, named `com.waifucave.moss.core.key`.

On macOS, the engine's login start is `~/Library/LaunchAgents/com.waifucave.moss.core.plist`, which step 1 removes.
