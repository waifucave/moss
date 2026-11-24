---
title: Plugins
description: What a plugin is, the card that asks for your OK before one runs, adding one in either app or from a terminal, the two settings every tool has, and turning a plugin off, updating it and removing it.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

A plugin is a folder of files with a `moss.json` that says what it brings. Model providers, tools, voices, coding agents, routine triggers and MCP servers all come as plugins, and so does most of MOSS Code's window, down to its canvas and its panels. Many come with MOSS; you can add more.

The two apps take a plugin differently. In MOSS, a plugin's tools, models and voices work right away, and parts that draw on your screen run in the background with no window of their own. MOSS's own window doesn't change. In MOSS Code, plugins can also restyle the window and add parts to it.

## Nothing runs before your OK

When a plugin arrives, by any of the ways below, a card says what it is and what it may do, and nothing of it runs until you answer. A plugin with code says so plainly: its card says it runs code on your computers, and which hosts its code may reach. On Windows and Linux the card also says that this code could read MOSS's logins and approve its own cards, because there a plugin's code runs as you. A new version that changes a plugin's code asks again.

Plugins are trusted code: install the ones you trust, and read the card before you say OK. On a Mac, MOSS fences each plugin's processes to its own folder and data.

## Adding a plugin

**In MOSS**, press **Plugins** at the bottom of the list of bots. Under **Add a plugin**, paste a link (`https://…`, or `npm:` and a package's name) and press **Add**, or press **From a file…**. Then look for its card.

{{picture moss-plugins "MOSS's Plugins page: a field to add a plugin from a link or a file, which runs only after you OK its card; then the MOSS Browser plugin's tools, Click, Fill, Open and Read, each with two settings: whether bots get it (Off, On demand, Always on) and what happens when a bot uses it (Always allow, Ask, Always block)." "MOSS's Plugins page, with the browser's tools."}}

**In MOSS Code**, press **Plugins** in the sidebar, then **Add**:

- **From a folder on this computer**: a MOSS plugin, a Claude Code plugin, a skill folder or an agent file. MOSS copies the folder into its plugins folder and leaves the original as it is. Unzip a `.zip` first.
- **From npm**: a package's name, and a version if you want one. Its files are checked against npm's own record.
- **An MCP server**: paste a configuration (an `.mcp.json`, or its `mcpServers`) or a server's address. Each server becomes a plugin of its own, and keys in the configuration go into your system's secret store.
- **From an index**: search the plugin indexes you added under **Indexes**.

**From a terminal**, with MOSS running:

```sh
moss plugin install ./hello-tool
moss plugin list
```

`install` takes a folder, `npm:` and a package's name, or a plugin's id from one of your indexes. The plugin still waits for your OK on its card in the app.

Installed plugins live in `~/.moss/plugins/`, one folder each. To write one of your own, see [Write your first plugin](/docs/first-plugin/).

## Each tool, two settings

Every tool a plugin gives your bots has two settings of its own: on MOSS's Plugins page, and in MOSS Code's Settings under **What each tool may do**, where they cover coding agents too.

| Setting | Choices |
| :- | :- |
| **Bots get it** | **Off** hides the tool. **On demand** lets a bot look it up when it needs it. **Always on** puts it in every turn. The plugin's own choice is marked *default*. |
| **When a bot uses it** | **Always allow** runs it. **Ask** follows your [approval level](/docs/approvals/). **Always block** refuses every use while the tool stays in sight. |

*On demand* keeps a plugin with many tools from filling a bot's context: the bot finds the tool when a job calls for it.

## Turning one off, updating, removing

In MOSS Code, open a plugin from **Installed** to see what it may do, the tools it gives your bots, its settings, its sign-ins and its log, with these buttons:

- **Turn off** and **Turn on**. MOSS's own window has no switch for a whole plugin: turn it off in MOSS Code, or from a terminal by its id. `moss plugin disable moss/web`, for example, turns off web search and fetch.
- **Restart**, while it runs.
- **Remove…**, or **Remove and delete its data…**. Both ask you on a card first.

**Updates.** A plugin from npm or from an index may have a newer version. MOSS offers it under **Updates** and never applies one on its own: **Check now** looks, **Apply** takes one, and **Hold back** keeps a plugin at its version until you let it update.
