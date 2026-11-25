---
title: Themes and window parts
description: Restyling MOSS Code's window with a theme, and restyling, hiding, replacing or adding one part of it with a plugin.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

MOSS Code's window is made of parts, and each part fills a named **spot**. A plugin can restyle the whole window with a theme, or change one part: dress it, hide it, put its own in its place, or add one beside the others. You never copy a page to change one thing.

## Themes

A theme is a plugin with a `themes` entry and a theme file. `moss plugin new theme my-theme` writes one:

```json
{
  "theme": 1,
  "name": "My theme",
  "appearance": "both",
  "tokens": {
    "color.canvas": "#F4F6F2",
    "color.surface": "#FFFFFF",
    "color.text": "#1E2420"
  },
  "dark": {
    "tokens": {
      "color.canvas": "#151916",
      "color.surface": "#1C211D",
      "color.text": "#E8ECE7"
    }
  }
}
```

- `tokens` are the window's named values, such as its colours. Name any of them; the rest stay as they are. The full list is the SDK's token catalog, [`catalogs/tokens.ts`](https://github.com/waifucave/moss/blob/main/packages/plugin-sdk/src/catalogs/tokens.ts).
- `appearance` is `light`, `dark` or `both`. For `both`, `dark` holds only the values that differ in the dark appearance.
- `css` names a stylesheet in the folder. MOSS cleans it first: no `@import`, and `url()` only for files inside the folder, so no font or picture comes from another site.
- `fonts` names font files in the folder, each with its `family` and, if you like, its `weight` and `style`.
- `icons` swaps the window's icons for pictures in the folder, by icon name.

Install it, then pick it in MOSS Code's Settings, under **Theme**. Light, dark or following the system is a setting of its own.

## One part of the window

Each change is one entry under `contributes`, `ui`. It names a `spot`, a `key` for one cell of a keyed spot, its own `id`, and exactly one of these:

| Field | What it does |
| :- | :- |
| `style` | Dresses what fills the spot, inside the part only, with a theme file: tokens and cleaned CSS. Several styles apply one after another, and none replaces the part. |
| `hide` | `true` shows nothing there. In a list spot, `target` names the entry it hides: `<plugin-id>#<entry-id>`, or `<plugin-id>` for all of that plugin's entries. |
| `component` | Your own React component, from the plugin's `client` entry, in your plugin's own frame. In a list spot it is added beside the others, placed by `order` (lower first; 500 when left out). |
| `web` | A web page in its place: an address (`url`) or a page in the folder (`entry`), with storage of its own (`partition`). |

`when` limits an entry to some systems (`os`), a setting's value, or kinds of session. `moss plugin new ui my-part` writes a plugin to start from, with a section of its own in Settings.

This restyles the composer:

```json
"contributes": {
  "ui": [
    { "spot": "composer", "id": "rounder", "style": "look/composer.json" }
  ]
}
```

And this hides the composer's model button:

```json
"contributes": {
  "ui": [
    { "spot": "composer.action", "key": "model", "id": "no-model-button", "hide": true }
  ]
}
```

## The spots

| Spot | What fills it |
| :- | :- |
| `app.root` | The whole window: the shell, which holds every other spot. |
| `app.surface` | Windows of their own that float, such as the island. |
| `app.background` | A part with no place in the window, which runs while MOSS is open. |
| `app.tray` | A line in the menu-bar menu. |
| `sidebar` | The sidebar, the same on every tab. |
| `sidebar.app` | Buttons in the sidebar, each opening a page or a panel. |
| `main` | The main area, keyed by page: `agent`, `settings`, `plugins`, `app` and `start`, the start page. |
| `page.bar` | A page's own line and controls on the window's top bar. |
| `panel` | The panels, keyed `session`, `terminal`, `diff`, `files`, `browser` and `agent`, each a plugin of its own. Another key adds a panel of your own, with its own button. |
| `panel.view` | A place inside each panel, keyed by the panel. |
| `settings.section` | A section of Settings. |
| `status` | The status bar. |
| `conversation` | A session's conversation. |
| `session.corner` | Small controls in a session tab's top corner. |
| `composer` | Where you write a message. Filling or hiding it needs the `conversation.post` capability. |
| `composer.action` | The composer's buttons, keyed `attach`, `model`, `level`, `send` and `stop`. Another key adds a button of your own. |
| `conversation.message` | One message, keyed by its kind. The `approval` cell can't be hidden. |
| `conversation.message.extra` | Something of your own under every message, each in a frame of its own. For a button, use the next spot. |
| `conversation.message.action` | A small button in a message's row of actions, beside copy and speak: a `title`, an `icon`, and a `call` to a handler of your plugin. |
| `tool.result` | A tool's result, keyed by the tool's name. |
| `file.preview` | A file's preview, keyed by its type, such as `image/*`. |
| `island.tab` | A tab of the island. |
| `pill.target` | Something the Dispatch pill can send a message to. |
