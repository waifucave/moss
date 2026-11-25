---
title: Voice
description: With a voice set up, your bots speak their replies and hear you while you hold the talk button. This page covers MOSS Voice, its providers, each bot's voice and what is sent where.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

Voice comes as a plugin that MOSS ships, **MOSS Voice**. It speaks your bots' replies aloud, each bot in its own voice, and hears you with push-to-talk. Without it, or without a provider set up, everything works in text.

## Setting it up

MOSS Voice speaks through a voice provider. MOSS comes with one, **Fish Audio**, which needs a Fish Audio key of your own: add it in Settings, under **Keys and sign-ins**. A plugin can add other providers.

## Talking to a bot

Hold the microphone button in the message box while you talk, or hold **Ctrl+Shift+Space**, and let go when you're done. What you said is written down by the provider and sent to the bot as your message straight away, without being shown to you first.

Without a voice set up, the button stays dimmed and says why.

## Hearing it

With **Speak replies** on, each bot says its replies aloud. It is on by default; turn it off in Settings, among the plugins' settings, under MOSS Voice.

- **One at a time.** Only one voice talks at once on a computer: a bot's new reply takes over from its last one, and replies from different bots wait their turn. Holding the talk button stops whatever is playing.
- **Where.** A reply is spoken on the computer that runs the bot.

## Each bot's voice

In a bot's settings, MOSS Voice adds a few settings for that bot: its **Voice provider**, its **Voice** and **Voice model** at that provider, and **No voice**, which keeps that one bot silent whatever the rest do.

## What is sent where

When a bot speaks, the text of its reply goes to its voice provider. When you hold the talk button, the recording goes to the provider to be written down. Both use your own key. [What leaves your computer](/docs/privacy/#your-voice-provider) has the rest.
