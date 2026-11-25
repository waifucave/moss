---
title: An agent MOSS doesn't ship
description: Writing the plugin for another coding agent that speaks ACP: its entry in moss.json, its mark, its quirks file, and the OK it asks for before it starts.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

MOSS Code runs coding agents that speak ACP, the Agent Client Protocol. Each agent MOSS ships is a plugin of its own, in a folder named `agent-<id>`, and another agent is added the same way: a folder with a `moss.json`, a quirks file and, if you like, its mark. [MOSS Code and coding agents](/docs/moss-code/#adding-an-agent-moss-doesn-t-ship) shows OpenCode's manifest as MOSS ships it.

## The entry in moss.json

An agent is an entry under `contributes`, `agentBackends`:

| Field | What it is |
| :- | :- |
| `id` | The agent's id. Not `moss` or `moss-code`, which are MOSS's own, and not the id of an agent MOSS ships while that plugin is on. |
| `name` | The name people see. Only MOSS's own agents may have a name that starts with "MOSS". |
| `protocol` | `"acp"` |
| `command`, `args` | The program MOSS starts and its arguments, the same on every system. The program is found on your `PATH`; on Windows, as its `.exe` or `.cmd`. |
| `quirks` | The quirks file, a JSON file in the plugin's folder. An agent without one isn't offered. |
| `icon`, `iconDark` | The agent's mark: a PNG or SVG file in the folder, at most 64 KiB, and a second one for the dark theme if it needs one. An SVG must be plain, with no script. Without one, or with one MOSS refuses, MOSS Code draws the agent's first letter. |
| `color`, `color2` | The agent's colour as `#rrggbb`, and a second one for a gradient. |

## The quirks file

The quirks file says what MOSS knows about how the agent behaves, so MOSS can work with it: how it starts, which versions were tried, how it reports its work, how it resumes a session, which MCP transports it takes, how its model and effort are set, and how it signs in. The easiest start is a copy of the one an agent MOSS ships uses, such as OpenCode's ([`plugins/moss/plugins/agent-opencode`](https://github.com/waifucave/moss/tree/main/plugins/moss/plugins/agent-opencode)), changed for your agent. Where you don't know a row, keep the careful value.

Two parts matter most:

- **`launch.identity`**: how MOSS checks the program is that agent. It runs the program with `versionArgs` (such as `--version`) and matches what it prints with `versionPattern`, whose first group is the version.
- **`launch.versions`**: the versions the file was written for, as a range such as `>=2.2.5 <3.0.0`.

`launch.envAllow` names the environment variables the agent gets from MOSS's, and `launch.envSet` the ones MOSS sets for it. A plugin that isn't MOSS's own may not ask for a variable whose name looks like a secret.

A quirks file that fails MOSS's check leaves the agent out, with the reason in MOSS's log, `~/.moss/logs/daemon.log`.

## Its OK before it starts

Like every plugin, yours asks for your OK on a card before it loads. The agent then asks once more before it starts, when MOSS has no sandbox it trusts for it, or its version is outside the range its quirks file names. MOSS trusts a sandbox only for some of the agents it ships, never for one from another plugin, so yours asks. The card names the agent, its version, the program, who started it, the folder, and what it gets from your environment. MOSS asks again for each new version, and on each computer.

To try your folder while you work on it, use `moss plugin dev <folder>` ([Write your first plugin](/docs/first-plugin/)).
