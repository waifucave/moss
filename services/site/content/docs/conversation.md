---
title: Talking to a bot
description: Each bot has one conversation that never ends. This page covers sending messages and files, interrupting, the line that says what a bot is doing, its questions, and what it shows of the web.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

## One conversation

Each bot has one conversation, like texting a person. You never start a new chat with it. Scroll up and MOSS reads the earlier messages back in.

When the conversation grows long, the bot sums up what came before and carries on from the summary. It does this when its context is nearly full, and also, on a long conversation, just before the model's cached copy of it would expire, which is when summing up costs least.

You can change a bot's model in its settings at any time; the next turn uses it.

## Sending

Type in the box that says *Message* and the bot's name, and press Return.

- **Files and pictures.** Press **+** (*Attach files*). A message can carry up to 4 pictures and 10 files.
- **Talking.** With a voice set up, hold the microphone button, or Ctrl+Shift+Space, while you talk. [Voice](/docs/voice/) says more.
- **If it can't send.** Sending needs MOSS's engine reachable on the computer that runs the bot. If it isn't, MOSS says *MOSS couldn't send just now. Your message is still here: press Send again.*

## Your message interrupts

A message from you stops what the bot is doing at once: its answer in progress is cancelled, a tool it was running is stopped and marked as interrupted, and a card waiting for that step is withdrawn. Then it reads your message. Work it has running in the background, such as a dev server or a routine, carries on.

While it works, the **Stop** button stops it without a message.

Messages from your other bots, and results from its routines, never cut it off this way: they join its turn after the tool it is running finishes.

## What it's doing

While a bot works, one line under the conversation says what it is doing, in plain words, and the same words show beside its face in the list of bots:

*Thinking*, *Searching the web*, *Reading a page*, *Reading a file*, *Editing a file*, *Writing a file*, *Running commands*, *Using the browser*, *Making a routine*, *Making a bot*, *Saving to memory*, or *Working*.

Its face shows it too: [Faces and moods](/docs/faces/).

## Its questions

When a bot needs a choice from you, it asks a question in the conversation: the question, a few answers to pick from, each with a line about it, and a box for your own words. Some questions take more than one answer. Once answered, the question says what you chose.

## What it shows of the web

A bot's replies can have bold and italic text, lists, code and links. A link opens in your own browser, and only if it is an ordinary web or email link. A picture in a reply is shown as a link and never loaded, so a reply can't fetch anything on your behalf just by being read.
