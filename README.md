# pi-hide-models

Hide models from a provider's catalog in [pi](https://pi.dev) — the model
picker (`/model`, <kbd>Ctrl+P</kbd>), `pi --list-models`, session restore, and
subagent bare/fuzzy model resolution only ever see what you keep.

The motivating case: with Mistral and OpenAI Codex subscriptions plus an
OpenRouter account, a bare id like `gpt-6-luna` or `mistral-large-4` exists on
both the subscription and OpenRouter (pay-as-you-go), and the OpenRouter
duplicate can win resolution. This extension removes the duplicates from the
registry itself, so they cannot be picked, cycled into, restored, or resolved
— while keeping OpenRouter usable for the models you do want.

## Install

```sh
pi install git:<remote-url>   # or a local path while in development
```

## Configure

Config lives in the standard per-extension locations, resolved by
[@graelo/pi-ext-config](https://github.com/graelo/pi-ext-config): a project
`.pi/extensions/pi-hide-models/config.json` (trusted projects only, wins) or
a global `<agent-dir>/extensions/pi-hide-models/config.json`. First match
wins; defaults are "hide nothing".

```json
{
  "rules": [
    {
      "provider": "openrouter",
      "hide": ["*"],
      "show": ["deepseek/*"]
    }
  ]
}
```

Rule semantics:

- `hide` — globs of model ids to hide, matched against the model id
  (`openai/gpt-6-luna`) and the qualified form (`openrouter/openai/gpt-6-luna`).
  `*` crosses `/`, `?` matches one character.
- `show` — exceptions; a `show` match always wins over `hide`.
- `types` — model operations the rule applies to; defaults to `["chat"]`, so
  image and classifier models pass through untouched. Use
  `"types": ["chat", "image", "classifier"]` to scope wider deliberately.
- `debug` — notify on config loading.

Config is read when the extension loads; apply changes with `/reload` or a
new session.

`/hide-models` shows the active rules, the number of visible models per
provider, the config file in effect, and any problems.

## How it works

Pi's documented `pi.registerProvider(name, { models })` call *replaces* a
provider's catalog when `models` is supplied, while authentication,
streaming, and refresh behavior stay inherited from the built-in provider.
The extension registers each rule's provider with its catalog filtered by the
rule:

1. **At load time**, from the extension factory, with the catalog shipped
   with pi (`getAllBuiltinModels` from `@earendil-works/pi-ai`). Pi queues
   factory registrations and flushes them *before* startup model selection
   and `pi --list-models`, so the filtered catalog is in effect everywhere
   with no race.
2. **On every catalog refresh**, a `refreshModels` hook re-filters the
   provider's persisted catalog, so metadata stays fresh and OpenRouter key
   personalization (the models, limits and prices your key may use) keeps
   flowing through.

Because the replacement happens in the registry itself, every reader is
covered — pickers and cycling read the registry snapshot, subagents resolve
bare ids against the registry, session restore falls back safely when a
pinned model no longer exists — with no patching of pi internals.

### Why not a blocklist overlay (e.g. pi-hide-providers)

The alternative approach patches pi's internal `ModelRuntime` accessors and a
private TUI component method to filter reads. That couples the extension to
undocumented internals: each pi minor needs a dedicated compatibility
release of the patcher. Catalog replacement uses only documented SDK
surfaces, needs no pi-version conditionals, and additionally covers
`pi --list-models` (which the patching approach currently misses — it only
runs from `session_start`, which does not fire in that mode).

## Caveats

- A fully-qualified id that no longer exists, e.g.
  `pi --model openrouter/openai/gpt-6-luna`, falls back to pi's "custom model
  id" behavior and would still reach the provider. That is pi core behavior
  for unknown qualified ids, not something catalog filtering can intercept;
  a provider-side key restriction (e.g. an OpenRouter provisioning key with
  an allowlist and spend limit) is the guard for that hole.
- Custom models added for a filtered provider via `models.json` `models`
  entries are dropped by the replacement (the extension cannot see them at
  load time). Avoid filtering providers you extend that way.
- Rules for providers pi does not know as built-ins are skipped with a
  diagnostic.

## Development

```sh
npm run check   # tsc --noEmit
npm test        # unit tests (node:test via tsx)
```

MIT license.
