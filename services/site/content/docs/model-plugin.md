---
title: A model provider
description: Add a model provider MOSS doesn't list, as a plugin with no code: its endpoint in the manifest, its models in a catalog file, and an API key MOSS asks for.
---

> **Not released yet.** This page describes MOSS as it is being built for the first release.

A provider whose endpoint speaks one of the formats MOSS knows can be added as a plugin with no code at all. Start from the template:

```sh
moss plugin new model my-provider
```

That writes a folder, `my-provider`, with three files: `moss.json`, `catalog.json` and a `README.md` that explains every field.

## The manifest

```json
{
  "manifest": 1,
  "id": "my-provider",
  "name": "My provider",
  "description": "My provider's models, on its compatible endpoint.",
  "engines": {
    "moss": "^1.0.0"
  },
  "contributes": {
    "models": [
      {
        "provider": "my-provider",
        "name": "My provider",
        "catalog": "catalog.json",
        "auth": [
          {
            "method": "api-key",
            "secret": "api-key",
            "help": "Your My provider API key. MOSS keeps it in your credential store."
          }
        ],
        "endpoint": {
          "protocol": "openai-chat",
          "baseUrl": "https://api.example.com/v1"
        }
      }
    ]
  }
}
```

Change two things in the `models` entry:

- `endpoint.baseUrl`: the provider's address.
- `endpoint.protocol`: the format it speaks, one of `openai-chat`, `openai-responses` or `anthropic-messages`.

`auth` asks for an API key, which MOSS keeps in your system's secret store and adds to each request itself: the plugin never sees it. `help` is the line shown beside the key's field.

## The catalog

`catalog.json` lists the provider's models, one row each. The template's one row, `example-model`, shows every field a row needs. The ones to change for each model:

- `key`: the provider and the model's id, `my-provider/<model id>`; `upstreamId`: the model's id as the endpoint takes it.
- `displayName`: the name the model picker shows.
- `inputModalities` and `outputModalities`: `["text"]`, or with `"image"` for a model that reads pictures.
- `toolCalling`: `"native"` for a model that takes tools. Bots need tools, so the picker leaves out a model without them.

## Trying it

Check it, add it as a development folder, and install it, as with [any plugin](/docs/first-plugin/#check-it):

```sh
moss plugin validate my-provider
moss plugin dev my-provider
```

The provider then shows in the setup guide and in Settings, under **Keys and sign-ins**, asking for its key. [Adding a model provider](/docs/setup/) goes on from there.
