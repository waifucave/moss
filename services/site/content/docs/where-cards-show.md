---
title: Where cards show
description: A card waits for you wherever you are looking: in the conversation, in a strip at the top of the window, on the island at the top of your screen, or on your phone. This page says how MOSS decides, and what answering one takes.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

Every card, from a bot in MOSS or an agent in MOSS Code, goes through one place in MOSS's engine, which shows it where you are looking. It is answered once, wherever you answer it, and then it clears everywhere.

## Where it goes

- **In the conversation**, when a MOSS or MOSS Code window is in front and showing the bot or session that asked.
- **In a strip at the top of the window**, when that window is in front but showing something else. In MOSS, the bot's row in the list also says *Needs you*.
- **In the window that asked for it**, for a card that belongs to no bot or session: a plugin's OK from a Plugins page, or an update.
- **On the island**, a small bar at the top of your screen, when neither app is in front: you are working in another app. A MOSS window that is open but not in front, on a second screen say, doesn't move a card off the island.
- **On your phone**, once the [phone apps](/docs/phones/) are out: a paired phone shows the cards that are waiting, and answers one only once it has shown all of it. A computer with no screen of its own, such as a server, sends its cards there.

On Linux with Wayland, the island is an ordinary window, since Wayland doesn't let a window stay on top of the others. [Install](/docs/install/#linux) says more.

## Answering one

A card is answered only by a real press on its button. A bot can't answer its own card, and neither can a plugin or a script: only your own press counts.

If something covers the button when you press it, or the button isn't fully showing yet, the press doesn't count: MOSS says what is in the way and asks you to press again.

When several of your devices show the same card, the first answer wins and the card clears from the rest.

[Approval cards and levels](/docs/approvals/) says what a card asks and how your approval level decides which actions need one.
