---
title: Write your first plugin
description: Give your bots a new tool. A plugin is one folder; this page makes one from the template, explains each file, checks it, and tries it on your computer.
---

> **Not released yet.** The `moss` command comes with the apps. Until the first release, developers can run it from the repository ([Install](/docs/install/#until-the-release-from-source)).

A plugin is a folder of files. Nothing else makes something a plugin: it needs no build step and no signature. MOSS finds the folder, asks you whether to load it, and from then on its tools are your bots' tools.

This page makes a plugin with one tool, `hello`, which says hello to someone by name.

## Make the folder

```sh
moss plugin new tool hello-tool
```

That writes a folder called `hello-tool` from the plugin SDK's **tool** template:

```text
hello-tool/
├── moss.json        the manifest: what the plugin is and what it adds
├── host/index.ts    its code: one MCP server with the hello tool
└── README.md
```

The folder's name is the plugin's id: lowercase letters, digits and single hyphens, 2 to 40 characters. The same command makes other kinds of plugin from their own templates: `theme` (colours for MOSS Code's window), `ui` (a part of MOSS Code's window), `model` (a model provider), `trigger` (a routine trigger) and `point` (a list other plugins can add to). For example, `moss plugin new theme my-theme`.

## The manifest

`moss.json` says what the plugin is, and what it adds where:

```json
{
  "manifest": 1,
  "id": "hello-tool",
  "name": "Hello tool",
  "description": "Hello tool, a tool.",
  "engines": {
    "moss": "^1.0.0"
  },
  "host": {
    "entry": "host/index.ts",
    "runtime": "bun"
  },
  "contributes": {
    "mcpServers": {
      "tools": {
        "type": "host",
        "tools": {
          "hello": "preload"
        }
      }
    }
  }
}
```

- `manifest` is the format's version, and `engines.moss` the versions of MOSS it works with.
- `id` must equal the folder's name. `name` and `description` are what people see, on the Plugins page and on the card that asks to load it.
- `host` is the plugin's own code, which MOSS runs with Bun.
- `contributes` lists what it adds. Here, one MCP server called `tools`, served by the plugin's own code (`"type": "host"`), with one tool.

`"preload"` means the tool is always in front of your bots. `"on-demand"` keeps it out of the way until a bot looks for it with its Glossary tool, which saves room in the bot's context when a plugin has many tools. Either way, you can change it for each tool on the Plugins page: off, on demand, or always on.

A bot sees the tool as `mcp__hello-tool__hello`: `mcp`, the plugin's id, then the tool's name.

## The code

`host/index.ts` answers the MCP server's requests. It speaks MCP's JSON-RPC directly, so the plugin needs no dependency:

```ts
// Hello tool's host half: one MCP server, `tools`, served on the in-process transport MOSS hands it. It speaks
// MCP's JSON-RPC directly, so the plugin ships no dependency. Its key here is the one under `contributes.mcpServers`.
import type { HostModule, McpServerTransport } from "@waifucave/moss-plugin-sdk";

const TOOLS = [
  {
    name: "hello",
    description: "Says hello to someone by name.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Who to greet" } }, required: ["name"] },
  },
];

function answer(method: string, params: Record<string, unknown> | undefined): unknown {
  if (method === "initialize") return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "hello-tool", version: "0.1.0" } };
  if (method === "tools/list") return { tools: TOOLS };
  if (method === "tools/call" && params?.name === "hello") {
    const who = String((params.arguments as { name?: unknown } | undefined)?.name ?? "there").slice(0, 100);
    return { content: [{ type: "text", text: `Hello, ${who}!` }] };
  }
  throw new Error(`unknown method ${method}`);
}

export const mcp: HostModule["mcp"] = {
  tools: async (transport: McpServerTransport) => {
    transport.onmessage = (m) => {
      if (typeof m.id !== "number" && typeof m.id !== "string") return; // a notification: nothing to answer
      try {
        void transport.send({ jsonrpc: "2.0", id: m.id, result: answer(String(m.method), m.params as Record<string, unknown> | undefined) });
      } catch (err) {
        void transport.send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: err instanceof Error ? err.message : String(err) } });
      }
    };
    await transport.start();
  },
};
```

The key under `mcp`, `tools`, matches the server's name under `contributes.mcpServers` in the manifest. MOSS hands it a transport, and it answers three requests: `initialize`, `tools/list` and `tools/call`. The `import type` line is erased when the code runs; it's only there for your editor.

MOSS runs the code in its plugin host, each plugin in a worker of its own, apart from the engine, so a plugin that crashes takes nothing else down. A plugin that crashes three times in ten minutes is stopped, and the app shows its last log lines.

## Check it

```sh
moss plugin validate hello-tool
```

`validate` reads the folder without running anything and says what is wrong, if anything: a field it doesn't know, an id that doesn't match the folder, a file the manifest names that isn't there.

## Try it

```sh
moss plugin dev hello-tool
```

This adds `hello-tool` as a **development folder**: MOSS loads it at once, and loads it again every time you change a file in it, without asking. Because you typed the command in your own terminal, it needs no card. Bots can't write to a development folder, it never copies to your other computers, and it turns itself off after 24 hours unless you renew it (`moss plugin dev renew hello-tool`).

Now ask a bot: *"Use the hello tool to say hello to Ada."*

At the default level, a tool from a plugin that isn't MOSS's own goes to MOSS's safety reviewer first, and you get a card when the reviewer isn't sure. **Always allow** on that card keeps it allowed for that bot.

## Install it

When it's ready, install it like any other plugin, from the Plugins page (**Add**, then choose the folder) or from your terminal:

```sh
moss plugin install ./hello-tool
```

The plugin waits for your OK on a card that says what it is and what it may do. A plugin with code is told apart plainly: the card says it runs code on your computers. On Windows and Linux, it also says that this code could read MOSS's logins and approve its own cards, because there a plugin's code runs as you. Any later change to the plugin's code asks again.

Installed plugins live in `~/.moss/plugins/`, one folder each.

## Trust

Plugins are trusted code. MOSS keeps them apart from each other's parts of the window and from its approval cards, and on a Mac it fences each plugin's processes to the plugin's own folder and data. But a plugin's tools do what their code does, so install plugins you trust, and read the card before you say OK.

## Where to go next

- **Reach the network.** A plugin names the hosts it reaches, for example `"capabilities": ["network:api.example.com"]`, and the OK card lists them. A plugin that can reach the network has no tool that skips the card, even one that only reads. The SDK's [weather example](https://github.com/waifucave/moss/tree/main/packages/plugin-sdk/examples/example-weather) shows this, with an API key kept in your credential store.
- **Keep a secret.** A setting with `"type": "secret"` is entered in the app's own key dialog and kept in the credential store, never in the plugin's folder.
- **Other kinds of plugin.** The SDK's examples in [`packages/plugin-sdk/examples`](https://github.com/waifucave/moss/tree/main/packages/plugin-sdk/examples) cover skills, a part of MOSS Code's window, and more.
