---
title: Relays
description: Your devices connect to each other directly. When two of them can't, a relay carries their traffic, still encrypted end to end. This page says what a relay sees and how to choose n0's public relays, your own server, or none.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

Your computers and phone connect to each other directly whenever they can: on the same network, or across the internet. Some can't, for example two devices behind strict routers or on a mobile carrier's network. For those, a relay carries their traffic between them.

## What a relay sees

Everything stays end-to-end encrypted, so a relay never sees what your devices say. It does see which of your devices are online, their IP addresses, which of them talk to each other, and how much they send.

## Choosing a relay

Choose in Settings, under **Relay** (press **You** at the bottom of the list of bots), or from the setup guide's last step, **Connect your other devices**:

| Choice | What it means |
| :- | :- |
| **n0's public relays** | The default. Relays run by n0, the makers of the networking library MOSS's links are built on. |
| **A server of your own** | Your own relay server, by its `https://` address. |
| **No relay** | Devices that can't reach each other directly won't connect at all. A small share of pairs are like that. |

Press **Save**. The links use the new choice at once.

A relay plugin you install shows in the list but can't be chosen yet: the links don't take one in the first release.
