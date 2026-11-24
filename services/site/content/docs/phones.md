---
title: The phone apps
description: MOSS and MOSS Code for iPhone and Android are being built. This page says what they are being built to do, what a paired phone may do on your computer, and what to do if you lose one.
---

> **Being built.** The phone apps are not out yet, and the desktop release doesn't wait for them. This page describes what they are being built to do; things may change before they ship.

## Two apps

Each desktop app gets a phone app of its own, on iPhone and on Android:

- **MOSS** on the phone is your list of bots, with a few pinned at the top as large faces, and their conversations.
- **MOSS Code** on the phone is your coding sessions: what each one is doing, its history, and starting a new one.

The iPhone apps are built with Apple's own components and the Android apps with Android's, over one shared core that holds the link, pairing, keys and card answers for all four.

## Pairing

Each phone app pairs with your computer on its own, so a phone with both apps counts as two devices. You pair the way you pair two computers: scan the code your computer shows, then check that the same four words show on both screens.

The phone and the computer then talk over one encrypted link. When they can't connect directly, a relay carries the traffic, still encrypted end to end. [What leaves your computer](/docs/privacy/#paired-devices) says what a relay can see.

## What a paired phone can do

A paired phone is a remote control for your computer. From it you can:

- read your bots, their conversations and your coding sessions, and send them messages;
- answer cards, the same cards the desktop shows (your answer is signed with a key that only that phone holds);
- interrupt or stop what a bot or a session is doing, and pause your bots;
- start a coding session in any folder on the computer: starting one raises the same cards as on the desktop, and you answer them on the phone;
- make a bot, with a name and a model;
- send a file to a bot or a session, up to 50 MiB a file and 10 files a message;
- see activity, routines and usage;
- change a computer's approval level, choose which computer is the main one, and rename or remove your devices;
- watch a bot's browser.

It can't delete or edit a bot, pair a new device, install plugins or change MOSS's other settings.

**Anyone holding your paired, unlocked phone can do all of this.** Keep the phone locked.

## Notifications

When something needs you, the phone gets a push that says only how many things are waiting: *You have 3 updates*. It never carries what they are. The app then connects to your computer itself to fetch them, so the push service never sees your bots' words.

## If you lose a phone

Remove it from any of your computers: in MOSS's Settings, under **Devices**, press **Remove** beside the phone, then answer the card. The computer ends the phone's pairing and cuts its link, and the phone can't reach that computer again until it is paired anew.
