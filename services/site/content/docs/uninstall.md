---
title: Removing MOSS
description: How to remove MOSS completely today, in order: stop the engine and its login start, remove the apps, then remove your data.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

MOSS and MOSS Code share one engine and one home folder, `~/.moss`. Removing one app leaves your bots and sessions in place for the other. To remove MOSS completely, do these in order.

## 1. Stop the engine and its login start

The engine starts every time you log in, and it runs from its own copy in `~/.moss`, so it would go on starting after the apps are gone. Quit both apps, then remove its login start, which also stops the engine:

```sh
moss autostart remove
```

It prints `autostart removed (dist); the daemon:` and what happened to the running engine. Where `moss` isn't a command in your terminal, run the engine's own copy instead, which works even after the apps are gone:

- **macOS and Linux**: `~/.moss/bin/daemon/moss-core autostart remove`
- **Windows**: `%USERPROFILE%\.moss\bin\daemon\moss-core.exe autostart remove`

On macOS, the login start it removes is `~/Library/LaunchAgents/com.waifucave.moss.core.plist`.

## 2. Remove the apps

- **macOS**: drag MOSS and MOSS Code from Applications to the Trash. With Homebrew, `brew uninstall --cask moss` and `brew uninstall --cask moss-code` do it instead:
  - MOSS's cask removes the login start only when MOSS Code isn't installed.
  - MOSS Code's cask always removes it, even with MOSS still installed. MOSS sets it up again the next time you open it.
  - `--zap` also removes each app's caches, preferences and logs, and MOSS Code's also removes the login start's file.
- **Windows**: remove each app from **Settings**, **Apps**. Removing the last of the two also removes the login start.
- **Linux**: remove the `moss` and `moss-code` packages with your package manager, or delete the `.AppImage`. A package's removal leaves the login start, so do step 1 first.

Dragging an app to the Trash leaves its caches, preferences and logs. These are the ones Homebrew's `--zap` removes, which you can delete yourself:

| | MOSS | MOSS Code |
| :- | :- | :- |
| Caches | `~/Library/Caches/com.waifucave.moss`, `com.waifucave.moss.ShipIt` and `@waifucavemoss-moss-updater` | `~/Library/Caches/com.waifucave.moss.code`, `com.waifucave.moss.code.ShipIt` and `@waifucavemoss-desktop-updater` |
| Preferences | `~/Library/Preferences/com.waifucave.moss.plist` | `~/Library/Preferences/com.waifucave.moss.code.plist` |
| Logs | `~/Library/Logs/MOSS` | `~/Library/Logs/MOSS Code` |

## 3. Remove your data

Nothing removes your data for you today: your bots, conversations, memory, routines, sessions and settings stay in `~/.moss` until you delete that folder yourself. Delete it only once you are sure: it can't be undone, and archived bots are in it too.

In a later release, **Erase everything** in Settings will do this for you. <!-- pending: deletion -->

On macOS, your keys aren't in that folder. They are Keychain items of the service `com.waifucave.moss.core`: remove them in Keychain Access by searching for that name.

On Windows and Linux, your keys are in `~/.moss/secrets.enc` and go with the folder. The key that unlocks that file is beside it, or in Credential Manager or the Secret Service under the name `com.waifucave.moss.core.key`.
