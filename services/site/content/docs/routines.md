---
title: Routines
description: A routine runs a bot with saved instructions on a schedule or when a webhook arrives. Each is a file you can read and edit. This page covers making one, the file, schedules, webhooks, missed runs and a routine's own approval level.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

A routine runs a bot with saved instructions when something happens: a time comes round, or a service calls the routine's webhook.

## Making one

Ask the bot in your own words: *"Every weekday at 9, sort my Downloads folder and tell me what you moved."* It writes the routine for itself and tells you.

Each run happens in a side thread of the bot, so it never gets in the way of your conversation, and posts a short result into the conversation when it's done. If the conversation can't be reached just then, the result waits and posts when it can.

## In the side panel

Open the bot's side panel, from the button at the top right of its conversation. **Routines** lists each one with its schedule and its state: *On*, *Paused*, or *Waiting for your OK* (for a raised level, below). A routine copied to a second computer with the same id shows *A copy: paused* there, and MOSS asks you which one runs.

- **Run now** starts it at once. Its result posts in the conversation.
- **Pause** and **Resume** stop and restart its triggers.
- **Edit** changes its name, its schedule and what it does.

## A routine is a file

Each routine is a Markdown file on the computer that runs it, in `~/.moss/routines/` under a folder named for its bot. The bot can edit it, and so can you, with any editor: MOSS notices a new, changed or deleted file at once.

```markdown
---
name: Morning brief
triggers:
  - schedule: "0 8 * * 1-5"
missed: run-once
---
Read my inbox and post a short brief.
```

- `name` is what the side panel shows.
- `triggers` lists what starts it: one or more of a `schedule`, a `webhook`, or a trigger a plugin adds.
- `level` is optional: the routine's own [approval level](/docs/approvals/), one of `read-only`, `ask`, `ask-risky`, `accept-edits` or `automatic` (below).
- `timezone` is optional, such as `Europe/London`: the zone its schedule is read in.
- `missed` is what happens to runs missed while the computer was off: `run-once` (the default) runs one of them when it's back, `skip` drops them.
- Everything after the second `---` is the instructions.

MOSS adds an `id` line when it first reads a file without one. Keys never go in the file.

## Schedules

A `schedule` is either an interval or a cron line:

| Schedule | Runs |
| :- | :- |
| `every 15m` | every 15 minutes (`s`, `m`, `h` and `d` work) |
| `0 8 * * 1-5` | at 8:00, Monday to Friday |
| `30 18 * * 0` | at 18:30 on Sundays |

A cron line is five fields: minute, hour, day of the month, month and day of the week, where 0 and 7 are both Sunday. Each field takes `*`, a number, a range such as `1-5`, a list such as `1,15`, and a step such as `*/10`.

## Webhooks

A routine with `webhook: true` among its triggers has an address a service can call, such as GitHub when you push or a monitoring service when something breaks. The bot gives you the address when it makes the routine. The routine's key is kept in your system's secret store, never in the file. A webhook routine's card says that anyone with the address can start it.

What the service sends reaches the bot marked as outside text it shouldn't take orders from. The call comes through a WaifuCave forwarder by default: [What leaves your computer](/docs/privacy/#webhook-routines) says what it sees and how long it holds a call.

## Its approval level

A routine runs at the approval level of its computer unless its file sets `level`. Setting a higher level than the computer's waits for your OK on a card before the routine runs at it, and any later edit to the file, or moving it to another computer, drops it back to the computer's level until you OK it again. A lower level needs no OK.
