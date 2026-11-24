---
title: Adding a model provider
description: MOSS doesn't come with a model. This page covers the setup guide that adds one when you first open MOSS, adding or changing providers later, giving one bot its own model, and a provider MOSS doesn't list.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

MOSS doesn't come with a model. Every bot talks through a model provider you add: an account or API key of your own, or a model server running on your own computer. What you write, and what a bot reads to answer you, goes to that provider, with your key or sign-in. [What leaves your computer](/docs/privacy/) has the rest.

## The setup guide

The first time you open MOSS, a setup guide walks you through three steps. **Skip for now** closes it; you can open it again at any time from Settings: press **You** at the bottom of the list of bots, then **Open the setup guide**.

### Step 1: add a provider

The guide lists the model providers that MOSS's model plugins offer, with a **Search providers** field when the list is long. Press a provider to open it.

- **An API key.** Most providers take a key you make on their own website. Paste it in the **Paste a key** field and press **Save** (or Return). MOSS's engine keeps it in your system's secret store, and it is never shown again.
- **A sign-in.** A few take a sign-in instead, such as **Codex (OAuth)** and **Grok (xAI OAuth)**. Press **Sign in…** and finish in your browser.
- **Terms.** Where a provider has terms MOSS shows them first, or a link to them, with a box to tick before you can add it.

{{picture moss-setup "Step 1 of 3 of MOSS's setup guide: Welcome to MOSS. MOSS needs a model to talk to. Add a provider: sign in to a subscription you have, or paste an API key. A search field and a list of providers: Codex, Grok, OpenAI, Anthropic, Google Gemini API, OpenRouter, xAI." "Step 1: add a provider."}}

A provider you have added shows **Added**. You can add more than one. **Next** goes on once one is added.

Claude subscriptions can't be used in MOSS. An Anthropic Console sign-in, billed to your API account, can.

### Step 2: your default model

Your bots use this model unless you pick another for one of them in its settings. With one provider added, its model is already chosen and **Change** picks another. With several, you pick one.

{{picture moss-setup-model "Step 2 of 3: Your default model. MOSS will use Claude Opus 5.5, medium, from Anthropic, with a Change button." "Step 2: the default model."}}

### Step 3: you're set up

The last step says which model answers MOSS's first message. **Talk to MOSS** closes the guide on your conversation with MOSS, the first bot. **Connect your other devices** sets how your computers and phone reach each other when they can't connect directly: n0's public relays (the default), a relay server of your own, or no relay. The same choice is in Settings, under **Relay**.

## Adding or changing a provider later

In Settings, **Keys and sign-ins** lists every provider and voice your plugins bring, each marked **Key saved**, **Signed in**, **No key** or **Signed out**:

- **Replace key** puts a new key in place of the old one.
- **Sign out** removes a key or a sign-in. It asks you on a card first.
- **Sign in…** signs in to a provider that takes one.

If your default model's provider is signed out (a key removed, a sign-in that lapsed), a line across the top of the window names the model and the provider, with a **Sign in** button that opens the guide where you sign in.

## One bot, its own model

Each bot can use a model of its own. Open the bot's settings, and under **Model** pick one from the list, or **Your default model**. The list marks a model whose provider you haven't signed in to. The change applies from the bot's next turn.

## A provider MOSS doesn't list

A provider with a compatible endpoint, such as one that speaks OpenAI's chat format, can be added as a small plugin with no code:

```sh
moss plugin new model my-provider
```

That writes a folder with two files. In `moss.json`, put the provider's address in `endpoint.baseUrl`, and the format it speaks in `endpoint.protocol`. In `catalog.json`, list its models, one row each; the folder's `README.md` says what every field means. A model needs to take tools (`"toolCalling"` set to `"native"`) for bots to use it. Then [check it, try it and install it](/docs/first-plugin/#check-it) like any other plugin, and the provider appears in the setup guide and in **Keys and sign-ins**, asking for its API key.
