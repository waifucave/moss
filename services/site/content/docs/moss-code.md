---
title: MOSS Code and coding agents
description: MOSS Code runs the coding agents you already use, each in a session of its own, side by side on one canvas. This page covers starting a session, the canvas, the cards, and adding an agent.
---

> **Not released yet.** This page describes MOSS Code as it is being built for the first release. It has no picture yet: one of the app with sample sessions will be added.

## What MOSS Code is

MOSS Code is the app for working with coding agents. A session in it is a conversation with one coding agent, the one you pick, working in one folder. Its window has a sidebar of your sessions, the conversation, the box you type in, and panels beside it: a terminal, the changes the agent made, the session's files, and a browser.

Its window is made of plugins, so it can be restyled and rearranged. There are no bots in MOSS Code; they live in MOSS.

## The agents it runs

MOSS Code comes with a plugin for each of these agents. You install the agent itself the way its makers say, and sign in to it the way it asks; MOSS Code finds it on your computer.

| Agent | What MOSS Code starts |
| :- | :- |
| MOSS's own coding agent | Nothing to install: it is built in. |
| Claude Code | Your `claude`, through a small adapter MOSS downloads once (below) |
| Codex | Your `codex`, through a small adapter MOSS downloads once |
| Gemini CLI | `gemini --acp` |
| Antigravity CLI | `agy acp` |
| Cursor | `cursor-agent acp` |
| Copilot | `copilot --acp` |
| Devin | `devin acp`, and `devin acp --cloud` for Devin in the cloud |
| Grok | `grok agent stdio` |
| DeepSeek Harness | `dsh --profile acp` |
| OpenCode | `opencode acp` |
| Qwen | `qwen --acp` |
| Kimi | `kimi acp` |

If an agent isn't installed, MOSS Code says so, in those words: *"opencode isn't installed on this computer."*

**The adapters.** Claude Code and Codex don't speak the protocol MOSS uses to talk to agents (ACP) themselves, so MOSS runs a small adapter for each, from npm. The first time, it asks on a card that names the package, its version, where it comes from and its size, and says plainly that it is code from npm that MOSS will run on your computer. Nothing is downloaded unless you say yes, and every file is checked against a fingerprint the agent's plugin names before anything is unpacked or run.

## Starting a session

Press **+**, then pick the agent, its model and effort, and the folder it works in. Each is already set to what you used last, or to the default. The session opens in a tab of its own.

You can also start one from the command line:

```sh
moss code ~/projects/web-app --backend opencode -p "Fix the flaky login test"
```

`--backend` is the agent's id (`claude-code`, `codex`, `opencode` and so on); `--model` and `--effort` pick the rest.

## The canvas

MOSS Code's start page is a canvas of all your sessions, each one a block with its agent, its title, its model and one line saying what it's doing.

- A block that is running is lit; one that is waiting on its own background work shows that it's waiting.
- A helper an agent started (a subagent) hangs from its block by a line.
- When a bot in MOSS starts a coding session, the bot has a block of its own, joined to each session it started. Pressing it offers **Open in MOSS**.
- When one session sends another a message, the line between them lights up.

Click a block to write to that session without leaving the canvas, or open it in its tab. A control in a tab's corner switches between the tab and the canvas.

## The cards

Each agent runs as its own program, with its own sign-in and its own sandbox; MOSS doesn't wrap it in another. It starts the agent in a mode where the agent asks before risky actions, and every permission the agent asks for goes through your [level](/docs/approvals/#the-levels) for that computer: answered on its own where the level allows, otherwise shown to you as a card, the same cards MOSS shows for its bots. A model never answers them.

MOSS also tells each agent's sandbox to keep away from MOSS's own settings, keys and plugins, in that agent's own format. An agent that has no sandbox on a computer, or one whose sandbox MOSS hasn't checked there, starts only after you OK it, on a card that says what that means.

## Sessions that talk to each other

Every session can message other sessions and list the ones it may reach. A session you started can message any other session. A session a bot started can message that bot, and any other session. No session can message another bot until that bot has written to it first.

So an agent can hand a question to another agent, and a bot can follow the work it handed out. A conversation between sessions with you out of it stops after a few rounds; your next message starts it over.

## With MOSS installed too

A bot in MOSS can hand a coding job to an agent. The job shows in the bot's conversation as it goes, and with MOSS Code installed it carries a link that opens it as a session, which you can watch, write to, interrupt and stop.

## Adding an agent MOSS doesn't ship

Any agent that speaks ACP can be added with a plugin: a folder with a `moss.json` that names the program to start. This is OpenCode's, as MOSS ships it:

```json
{
  "manifest": 1,
  "name": "OpenCode",
  "description": "OpenCode CLI (`opencode acp`) as an agent bots can delegate to.",
  "engines": { "moss": "^1.0.0" },
  "contributes": {
    "agentBackends": [
      {
        "id": "opencode",
        "name": "OpenCode",
        "protocol": "acp",
        "command": "opencode",
        "args": ["acp"],
        "quirks": "quirks.json",
        "icon": "opencode.svg"
      }
    ]
  }
}
```

- `command` and `args` are what MOSS starts, found on your computer's `PATH`.
- `icon` is the agent's mark, a PNG or SVG file in the plugin's folder, and `color` its colour. Without one, MOSS Code draws the agent's first letter.
- `quirks` is an optional file of what MOSS knows about how the agent behaves. Where it says nothing, MOSS takes the careful choice.

Put the folder in your plugins folder, `~/.moss/plugins/`, named as the plugin's id, or add it from the Plugins page. MOSS asks for your OK on a card before it loads it. [Write your first plugin](/docs/first-plugin/) has more on plugins.
