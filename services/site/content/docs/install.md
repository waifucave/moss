---
title: Install
description: MOSS isn't released yet. Here is what the first release will hold for each system, how installing will work, and what to do until then.
---

> **Not released yet.** There is nothing to download today. The first release brings both apps, MOSS and MOSS Code, to macOS, Windows and Linux at the same time, from the project's [releases on GitHub](https://github.com/waifucave/moss/releases). This page is ready for that day.

MOSS is for people 13 and older.

## What you will download

Each app has its own installer for each system. Install MOSS, MOSS Code, or both: each one carries the engine and runs on its own, and with both installed they share one engine and one home folder.

{{release-files}}

`<version>` is the release's version number. The `.yml` files and the macOS `.zip` on the release page are for the apps' own updater; you don't need them.

## macOS

You need macOS 27 or later on a Mac with Apple silicon.

1. Open the `.dmg`.
2. Drag MOSS (or MOSS Code) into Applications.
3. Open it from Applications.

The apps are signed and notarized by Apple.

## Windows

You need Windows 11 on an x64 PC.

1. Run the installer, `MOSS-Setup-<version>.exe` (or `MOSS-Code-Setup-<version>.exe`).
2. Open MOSS from the Start menu.

At first the installer isn't code-signed, so Windows may warn that it doesn't know the publisher.

## Linux

MOSS supports Ubuntu 26.04 LTS and current Fedora, on x64 and arm64.

- On Ubuntu, install the `.deb`.
- On Fedora, install the `.rpm`.
- Anywhere else, the `.AppImage` runs as it is.

The `.deb` and `.rpm` are the ones to prefer: they also install the security profile that the app's sandbox needs on Ubuntu, which an AppImage can't. On Wayland, the island that shows cards at the top of the screen is an ordinary window, since Wayland doesn't let a window stay on top.

## Updates

Both apps update themselves, on every system. They check the project's releases on GitHub when they start and every 4 hours, download a new version on their own, and install it when MOSS has nothing running. There is no switch to turn this off.

## The engine

Whichever app you install first also installs the engine, `moss-core`, and starts it every time you log in: as a launch agent on macOS, a scheduled task on Windows, and a `systemd --user` service on Linux. It keeps your bots running while every window is closed.

Removing one app leaves the other working.

## When you first open MOSS

A setup guide walks you through three steps. [Adding a model provider](/docs/setup/) goes through each in more detail.

**1. Add a model provider.** MOSS needs a model to talk to, and doesn't come with one: you need an account or an API key with a model provider, or a model running on your own computer, with Ollama, LM Studio or another local server. Sign in to a subscription you already have, or paste an API key. You can search the list of providers, and add more than one.

{{picture moss-setup "Step 1 of 3 of MOSS's setup guide: Welcome to MOSS. MOSS needs a model to talk to. Add a provider: sign in to a subscription you have, or paste an API key. A search field and a list of providers: Codex, Grok, OpenAI, Anthropic, Google Gemini API, OpenRouter, xAI." "Step 1: add a provider."}}

Claude subscriptions can't be used in MOSS. An Anthropic Console sign-in, billed to your API account, can.

**2. Pick your default model.** Your bots use this model unless you pick another for one of them in its settings. If you added one provider, its model is already chosen, and you can change it. If you added several, you pick.

{{picture moss-setup-model "Step 2 of 3: Your default model. MOSS will use Claude Opus 5.5, medium, from Anthropic, with a Change button." "Step 2: the default model."}}

**3. Talk to MOSS.** The guide ends at the conversation with MOSS, the default bot, ready for your first message. From there, [Your first bot](/docs/first-bot/) goes on.

You can skip the guide and come back to it later from Settings.

## Until the release: from source

If you're a developer, you can run MOSS from its repository today. You need Bun, at the version the repository pins, and a GitHub token that can read packages, since some of MOSS's own packages are published on GitHub Packages. The repository's [CONTRIBUTING.md](https://github.com/waifucave/moss/blob/main/CONTRIBUTING.md) has the steps.
