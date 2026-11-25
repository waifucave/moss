---
title: Removing MOSS
description: How to remove MOSS completely, in order: your account if you have one, then everything MOSS keeps on this computer with Erase everything, then the apps.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

MOSS and MOSS Code share one engine and one home folder, `~/.moss`. Removing one app leaves your bots and sessions in place for the other. To remove MOSS completely, do these in order.

## 1. Delete your account, if you have one

You don't need an account to use MOSS. If you signed in to one at WaifuCave, delete it first, while MOSS still runs: **Delete account** in Settings, or `moss account delete` in a terminal. [What leaves your computer](/docs/privacy/#paired-devices) says what goes with it.

## 2. Erase what MOSS keeps on this computer

**Erase everything** in Settings deletes every conversation, bot, memory, setting, plugin, routine and log MOSS keeps on this computer, MOSS's saved keys and sign-ins, and starting MOSS at login. You say yes on a card first; then MOSS and MOSS Code quit, and the engine erases. It can't be undone.

With both apps quit, `moss erase` in a terminal does the same, after you type ERASE.

It leaves:

- the MOSS and MOSS Code apps themselves (step 3);
- the apps' own folders: their browser cookies and the key that signs your approvals;
- your projects, and the `.moss` folder inside a project you opened;
- files your bots or agents wrote outside MOSS's folder;
- anything at your AI providers, plugins' services and WaifuCave (step 1 is for that).

The next time MOSS starts on this computer, it says **MOSS is starting fresh on this computer.** If something couldn't be erased, it says **MOSS couldn't erase everything.** and which kinds are still there, and you can try again.

## 3. Remove the apps

- **macOS**: drag MOSS and MOSS Code from Applications to the Trash. With Homebrew, `brew uninstall --cask moss` and `brew uninstall --cask moss-code` do it instead, and `--zap` also removes each app's caches, preferences and logs.
- **Windows**: remove each app from **Settings**, **Apps**.
- **Linux**: remove the `moss` and `moss-code` packages with your package manager, or delete the `.AppImage`.

Dragging an app to the Trash leaves its caches, preferences and logs. These are the ones Homebrew's `--zap` removes, which you can delete yourself:

| | MOSS | MOSS Code |
| :- | :- | :- |
| Caches | `~/Library/Caches/com.waifucave.moss`, `com.waifucave.moss.ShipIt` and `@waifucavemoss-moss-updater` | `~/Library/Caches/com.waifucave.moss.code`, `com.waifucave.moss.code.ShipIt` and `@waifucavemoss-desktop-updater` |
| Preferences | `~/Library/Preferences/com.waifucave.moss.plist` | `~/Library/Preferences/com.waifucave.moss.code.plist` |
| Logs | `~/Library/Logs/MOSS` | `~/Library/Logs/MOSS Code` |

## Removing the apps without erasing

If you remove the apps and keep your data, the engine would go on starting at every login: it runs from its own copy in `~/.moss`. Quit both apps and remove its login start first, which also stops the engine:

```sh
moss autostart remove
```

It prints `autostart removed (dist); the daemon:` and what happened to the running engine. Where `moss` isn't a command in your terminal, run the engine's own copy, which works even after the apps are gone:

- **macOS and Linux**: `~/.moss/bin/daemon/moss-core autostart remove`
- **Windows**: `%USERPROFILE%\.moss\bin\daemon\moss-core.exe autostart remove`

On macOS, the login start it removes is `~/Library/LaunchAgents/com.waifucave.moss.core.plist`. The uninstallers remove it only in some cases:

- MOSS's Homebrew cask removes it only when MOSS Code isn't installed. MOSS Code's cask always removes it, even with MOSS still installed; MOSS sets it up again the next time you open it. MOSS Code's `--zap` also removes its file.
- On Windows, removing the last of the two apps removes it.
- On Linux, removing a package leaves it.

Your data stays in `~/.moss` until you erase it or delete that folder yourself. On macOS your keys aren't in that folder: they are Keychain items of the service `com.waifucave.moss.core`, which you can remove in Keychain Access by searching for that name. On Windows and Linux your keys are in `~/.moss/secrets.enc` and go with the folder. The key that unlocks that file is beside it, or in Credential Manager or the Secret Service under the name `com.waifucave.moss.core.key`.
