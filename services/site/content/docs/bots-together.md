---
title: Bots that work together
description: Your bots can message each other, and a bot can hand a coding job to a coding agent that works in the background. This page says how, and what you see of it.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

Each conversation is you and one bot. Bots work together by messaging each other, and by handing work to coding agents. (Several bots in one conversation comes in a later release.)

## Bots messaging bots

A bot can send a message to another of your bots, for example *"Ask Maple for the trip budget."* The message joins the other bot's turn after the tool it is running finishes, so bots never cut each other off the way your own messages do. The answer comes back the same way.

## Handing work to a coding agent

A bot can start a coding agent in the background, for a job such as *"Fix the failing test in the web-app folder."* It picks the agent, the model, the computer and the folder, and carries on with your conversation at once. The agent works on its own, under that computer's [approval level](/docs/approvals/): when it wants to do something the level doesn't allow, you get a card, the same as from a bot.

When the agent finishes, its report comes back to the bot, which tells you. While it works:

- the job shows in the bot's conversation as it goes;
- with MOSS Code installed, it opens there as a session, joined on the canvas to the bot that started it, where you can watch it, write to it, interrupt it and stop it;
- the bot can check on it, message it, or stop it.

What the agent did is kept with the bot, in `~/.moss/bots/` under the bot's own folder, in `agents/`. [MOSS Code and coding agents](/docs/moss-code/) says which agents MOSS works with and how to add one.
