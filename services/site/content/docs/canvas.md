---
title: The canvas
description: MOSS Code's start page is a canvas of all your sessions, each a block, joined by lines to the sessions they start and talk to. This page covers what a block says, starting a session from it, and writing to one without leaving it.
---

> **Not released yet.** This page describes MOSS Code as it is being built for the first release.

MOSS Code opens on a canvas of your sessions. Each session is a block, and lines join a session to the ones it started and the ones it talks to.

{{picture moss-code-canvas "MOSS Code's canvas with sample sessions: Fix login redirect loop, idle; Run the dev server, waiting on one background job, with a dashed edge; Profile checkout page load, running and lit; and MOSS, a bot, joined by a line to Study notes, the session it started." "Sessions on MOSS's own coding agent, and the bot that started one of them."}}

## A block

Each block shows the agent's mark, the session's title, its model and effort, and one line saying where it is:

| Line | Means |
| :- | :- |
| **Running** | working now: the block is lit |
| **Starting** | the agent is starting up |
| **Waiting** | its turn is over, but background jobs it started still run; the block's edge is dashed |
| **Needs you** | a card or a question is waiting for you |
| **Idle** | done, waiting for your next message |
| **Idle · the last turn failed** | its last turn ended in an error |
| **Ended**, **Failed** | the session is over |

A helper an agent started (a subagent) hangs from its block by a line. A block also counts the sessions it started.

When a bot in MOSS starts a coding session, the bot gets a block of its own, with its face and what it is doing, joined to each session it started. Pressing it offers **Open in MOSS**.

The bar at the top counts your sessions. **Hide ended** takes the ended ones off the canvas; the bar says how many there are.

## Starting a session

Press **+** on the bar, or **New session** in the sidebar. Pick the **Agent**, its **Model and effort** and the **Folder** it works in, each already set to what you used last, then press **Create session**. An agent that isn't installed on this computer is marked *not installed*.

## Writing to a session from the canvas

Press a block to write to it without leaving the canvas: type in *Message this session…* and press **Send**. **Open tab** opens the session in its own tab, and **Show on the canvas**, in a tab's corner, brings you back.

[MOSS Code and coding agents](/docs/moss-code/) has more on agents, sessions and how sessions message each other.
