---
title: MCP servers, skills and Claude Code plugins
description: Bring the MCP servers, skills, agent files and Claude Code plugins you already have. MOSS wraps each in a small plugin for you. This page says what it does with each, and what it leaves unused.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

In MOSS, everything that adds to your bots and agents comes as a plugin. You don't have to make one by hand for something you already have: add it, and MOSS writes a small plugin around it in its plugins folder. From then on it is a plugin like any other. It asks for your OK before it runs, and you can open the plugin it made and edit it.

## What you can bring

| Bring | How |
| :- | :- |
| **An MCP server's configuration**: an `.mcp.json`, or its `mcpServers` | Paste it in MOSS Code's Plugins page, under **Add**, **An MCP server**. Each server becomes a plugin of its own. |
| **An MCP server's address** | The same place: paste its address. |
| **A skill folder**, a folder with a `SKILL.md` | MOSS Code's Plugins page, **Add**, **From a folder on this computer**, as *A skill folder*. |
| **An agent file** | The same, as *An agent file*. |
| **A Claude Code plugin**, a folder with `.claude-plugin/plugin.json` | The same, as *A Claude Code plugin*. |

From a terminal, with MOSS running:

```sh
moss plugin wrap mcp-config ./.mcp.json
moss plugin wrap mcp-url https://mcp.example.com/mcp
moss plugin wrap skill-folder ./my-skill
```

The kinds `agent-file` and `claude-plugin` work the same way, with the file or the folder. Each waits for your OK on its card in the app.

## Keys stay out of the folder

When MOSS wraps an MCP configuration, it moves every value under `env` and `headers` into your system's secret store and leaves a reference to it in the plugin instead, so the plugin's folder can be shared without its keys.

## What a wrapped server may reach

A wrapped MCP server, or a Claude Code plugin's hook, that runs on your computer may reach any host on the network, and its card says so before you OK it. Like every plugin, it is fenced away from MOSS's own files.

## A Claude Code plugin

MOSS turns a Claude Code plugin's skills and commands into skills, its agents into agent definitions, its MCP servers into MOSS's, its hooks into hooks and its settings into the plugin's settings. Parts MOSS has no place for yet, such as output styles, language servers and mods, stay in the folder unused, and the card that asks for your OK names them.

## A project's own servers and skills

MCP servers and skills that a project defines for itself, in its own `.mcp.json` or skills folder, are not wrapped or installed. They load only while a bot or agent works inside that project, once you trust it.
