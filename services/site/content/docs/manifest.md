---
title: The manifest
description: Every field of moss.json, the file at the top of every plugin's folder.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

Every plugin is a folder with a `moss.json` at its top. It is JSON; comments and trailing commas are accepted. `moss plugin validate <folder>` checks it, and says what the plugin's OK card will say ([Write your first plugin](/docs/first-plugin/)).

A path in the manifest is relative to the plugin's folder and must stay inside it, links included. Text that people read, such as `name`, is a string, or an object with an `en` string and others by language.

## The top level

| Field | What it is |
| :- | :- |
| `manifest` | Required. Always `1`. |
| `id` | Required at the top of a plugin, and the same as its folder's name. A plugin inside another one leaves it out. |
| `name` | Required. The plugin's name. |
| `version` | Its version, as semver. `0.0.0` when left out, and needed to publish it to an index. Plugins inside it take it too. |
| `description`, `icon` | One line about it, and its picture: SVG, PNG or WebP, at most 256 KiB. |
| `author`, `license`, `homepage` | Who made it (`name`, and an optional `url`), its licence, and its web page. |
| `namespace` | The start of its tools' names. Lowercase letters and digits, with single hyphens between them, up to 40. Its `id` when left out; `moss` is MOSS's own. |
| `engines` | `{ "moss": "^1.0.0" }`: the plugin-API versions it works with. Required when the plugin has code. |
| `platforms` | Where its code runs: `darwin-arm64`, `windows-x64`, `linux-x64` and `linux-arm64`. All of them when left out. |
| `adult` | `true` keeps the whole plugin off until you confirm you are 18 or older. |
| `enabledByDefault` | For a plugin inside another one: `false` leaves it off until you turn it on. |
| `scope` | Which sessions get its MCP servers, skills, agents and hooks: `bots`, `agents` (coding agents) or `both`, the default. |
| `onlyBackends` | Only these coding agents get it, such as `["claude-code"]`. |
| `host` | The plugin's code that runs in the background (below). |
| `client` | The plugin's parts of the window: `entry`, one JavaScript module of React components, or TypeScript that MOSS builds; `css`, its stylesheets; `isolated`, for a part that needs threaded WebAssembly. |
| `helper` | A native program MOSS starts and watches over: `bin`, the file for each platform (a signed `.app` on macOS); `permissions` it needs from the system (`accessibility`, `screen-recording`, `input-monitoring`, `microphone`, `camera`); and `ipc`, `socket` or `stdio`. |
| `capabilities` | What it may do through the plugin API, such as `conversation.read`, `notify` or `network:<host>`. Its OK card names them. |
| `settings` | Its settings (below). |
| `auth` | Sign-ins for its own service. |
| `addons` | It runs add-ons of its own, in a format it chooses: `description` says what they are. |
| `contributes` | What it adds to MOSS (below). |
| `generated` | Written by MOSS when it [wraps](/docs/wrapping/) something into a plugin: what it came from, who made it and when. A hint only: the OK card shows MOSS's own record. |
| `$schema` | An editor's hint, the address of the manifest's JSON Schema. MOSS ignores it. |

Two more fields, `availability` and `built`, belong to MOSS's own plugins only. Any other plugin that carries them is refused.

## host

| Field | What it is |
| :- | :- |
| `entry` | The file that starts it. |
| `runtime` | `bun`, the default, runs it as a worker in MOSS's plugin host; `node` runs it in a process of its own. |
| `process` | `"own"` runs a Bun plugin in a process of its own too, for one that keeps a secret from other plugins. |
| `programs` | `true`, with `process: "own"`: it may start programs, inside its own sandbox. The OK card says so. |
| `outside` | Programs (`programs`) it runs outside its sandbox, with your own access, and folders of yours (`read`) it reads. The OK card names each one with a warning, and a change to either list asks again. |
| `start` | Where it starts at once: `each` computer, the `main` one or the `chosen` ones. Otherwise only when it is needed. |
| `declares` | Points it offers other plugins. |

## settings

Each setting is a key, with:

| Field | What it is |
| :- | :- |
| `type` | `string`, `number`, `boolean`, `enum`, `color` or `secret`. A secret goes to MOSS's secret store only. |
| `title`, `description` | What Settings shows. |
| `default`, `options`, `min`, `max` | Its first value, an `enum`'s choices, and a number's bounds. |
| `scope` | `account`, the default, the same on all your computers; `device`, for this computer only; or `bot`, one value per bot. |
| `required` | The plugin waits until it has a value. |
| `hidden` | The plugin's own state, never listed in Settings. Not for a secret. |

## contributes

| Field | What it adds |
| :- | :- |
| `models` | Model providers and their models ([A model provider as a plugin](/docs/model-plugin/)). |
| `mcpServers` | MCP servers, by name: their tools join the sessions in its `scope`. |
| `skills` | Folders holding a `SKILL.md`; patterns such as `skills/*` are allowed. |
| `agents` | Agents a session can hand work to: a file, or an entry with its `backend`, `model`, `effort`, `instructions` and the `computer` and `root` folder it works in. |
| `agentBackends` | Coding agents for MOSS Code ([An agent MOSS doesn't ship](/docs/agent-plugin/)). |
| `hooks` | Code that runs on `tool.before`, `tool.after`, `message.in`, `message.out`, `turn.start`, `turn.end`, `compact.before` or `compact.after`. |
| `commands` | Commands people run, each with a `name`, a `description`, a `handler` and, if you like, a `key` to press. |
| `triggers` | New ways for a [routine](/docs/routines/) to start: a `type`, a `title`, the `fields` it asks for and a `handler`. |
| `turns` | Turns of its own another plugin may take. |
| `computerProviders` | A provider of cloud computers, with its sign-ins and a `handler`. |
| `computer` | One cloud computer: its `provider`, `name`, `size`, `region` and, if you like, `image`. |
| `relays`, `notifiers`, `companions` | Services, each with an `id` and a `handler`. |
| `themes` | Themes, each an `id` and a theme `file` ([Themes and window parts](/docs/window-parts/)). |
| `locales` | Translations, each a language (`lang`) and a `file`. |
| `ui` | Parts of the window ([Themes and window parts](/docs/window-parts/)). |

Any entry may also carry `declares`, the points it offers other plugins. And a key with a dot in it, such as `"webhook.ingress"`, fills a point another plugin offers.
