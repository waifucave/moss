---
title: Approval cards and levels
description: Before a bot does something its level doesn't allow on its own, it asks you on a card. This page says what each level lets a bot do alone, what always asks, and how the sandbox around its commands works.
---

> **Not released yet.** This page describes the rules MOSS is being built to, for the first release.

## A card

When a bot wants to do something its level doesn't let it do on its own, it stops and asks you on a card. A coding agent in MOSS Code asks the same way.

{{picture moss-card "A card in MOSS: Juniper wants to click Book on example-air.test. Under it: Submit the booking form? and the computer's name, Studio. Then what the press does: Press Book, 8:05 nonstop to Lisbon, seat 14A, $312.40. A link, Show everything this approves, and two buttons, Not now and Book it." "A card, as MOSS draws it."}}

A card says who wants to do what, on which computer, and what exactly you're approving. **Show everything this approves** opens the full details. Its buttons say what they do: *Book it* or *Not now*, *Allow* or *Deny*. Many cards also offer **Always allow**, which keeps that permission for the bot that asked, never for every bot.

**Only a real press answers a card.** A bot can't answer its own card, and neither can a command it runs. MOSS draws the cards itself, apart from the rest of the window, so a plugin's code in the window can neither read a card's words nor press its buttons. (On Windows and Linux, a plugin's other code runs as you, and the card that installs such a plugin says it could answer cards.) If another window is covering the button when you press, MOSS doesn't count the press and tells you to bring MOSS to the front.

**A card finds you.** It shows in the bot's conversation when you're looking at it, in a strip at the top of the window when you're looking at another bot, and on the island at the top of your screen when you're in another app. Every one of your devices that can answer shows it, and the first answer counts everywhere.

**A card doesn't wait for ever.** If you write to the bot while a card is waiting, the step that asked is stopped and its card is withdrawn. A card from work you didn't start yourself, such as a routine, is refused after 10 minutes with no answer.

## The levels

The level says how much a bot may do on its own on a computer. You set it for each computer in **Settings**, under **Approval level**, and changing it asks you on a card first. Every bot gets the same level: it depends on the computer, never on which bot is acting.

| Level | Reads and searches | Changes files | Runs commands, opens pages | Deletes, buys |
| :- | :- | :- | :- | :- |
| Read only | Yes | No | No | No |
| Ask before every action | Yes | Asks | Asks | Asks |
| Ask before risky actions | Yes | In your ordinary folders, yes. Elsewhere, checked | Inside the sandbox, yes. Otherwise, checked | Asks |
| Ask before risky actions, edits allowed | Yes | Yes | Inside the sandbox, yes. Otherwise, checked | Asks |
| Fully automatic | Yes | Yes | Yes | Yes |

**Checked** means MOSS's safety reviewer, a model, looks at the action first. If it is sure the action is safe, the bot goes ahead; if it isn't sure, you get a card.

**Ask before risky actions** is the default on a new computer. **Read only** is absolute: nothing you saved, and no card, lets anything but a read through.

## The default level, in detail

At **Ask before risky actions**, a bot works on its own for whatever its sandbox already holds in, and asks when it wants to go further, or to do something that isn't easily undone.

**Runs without asking:**

- Reading files and searching.
- Changing files in your own folders: Documents, Downloads, Desktop, a project folder.
- Searching the web, and reading a page whose address already came up in the conversation, in your own message or as a search result: up to 5 pages from one site, and 20 in all, in one turn.
- Commands, inside the sandbox.
- Messaging its own side threads and the agents it started, starting a coding agent MOSS has tested, and stopping one it started.

**Goes to the safety reviewer, and asks you if it isn't sure:**

- Changing files in sensitive places: the settings files and folders in your home folder whose names start with a dot, your Library folder on a Mac, the data and preferences of your apps, anything inside an app, and anything outside your home folder.
- Moving files.
- A plugin's tool, unless it is one of MOSS's own.
- A page at an address the bot made up, or found on a page it read: a page can tell a bot where to go next, and an address can carry what the bot has read.

**Always asks:**

- Deleting files.
- Buying anything.

**Always a card, with no reviewer and no *Always allow*:**

- Changing anything in a `.git` folder, whose hooks and settings run later, outside any sandbox.
- Changing a folder on your `PATH`, where a program runs the next time you type its name.

**At every level, fully automatic included,** changes to MOSS's own settings, levels, permissions, plugins and trusted folders come to you on a card.

## The sandbox around commands

Every command a bot runs goes through a sandbox: the Mac's own sandbox on macOS, bubblewrap on Linux, and a separate, restricted account on Windows.

At the default level, a command can write only to the bot's own folders and the temporary folder, and can't reach the network. From **Ask before risky actions, edits allowed** up, it can also write to your home folder.

**When a command needs more,** the bot asks for it on a card: *"Juniper wants write access to Projects for shell commands."* **Always allow** keeps that folder for that bot. A sensitive folder is never given to commands, and in the first release neither is the network.

**Running one command outside the sandbox** always raises a card that shows the whole command and says plainly that it runs as you, with the network and everything your account can reach. There is no *Always allow* for it, and at **Read only** it is refused.

**Some places are fenced off from bots at every level,** inside the sandbox or out: MOSS's settings and levels, its keys, its plugins folder, and the places your system starts programs from when you log in. A bot that wants one of them changed asks you.

## Coding agents in MOSS Code

Each coding agent runs as its own program, with its own sign-in and its own sandbox, which MOSS starts with its fenced places denied. When an agent asks permission for something, the request goes through the same level: answered on its own where the level allows, otherwise shown to you as a card. A model never answers them.

An agent that has no sandbox on a computer starts there only after you OK it, on a card that says what that means.
