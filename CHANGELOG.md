# Changelog

## 0.1.0 — 2026-10-27

Initial release.

- Hide models per provider via config rules with `hide`/`show` globs and a
  `types` scope (chat by default).
- Catalog replacement through the documented `pi.registerProvider` API:
  factory-time registration from the catalog shipped with pi, plus a
  `refreshModels` hook that re-filters the provider's persisted catalog on
  every refresh.
- Config via `@graelo/pi-ext-config`: project `.pi/extensions/pi-hide-models/`
  over global `<agent-dir>/extensions/pi-hide-models/`, first match wins.
- `/hide-models` status command: active rules, visible model counts, config
  source, and problems.
