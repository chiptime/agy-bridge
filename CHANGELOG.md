# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(`0.x` = development line).

## [0.2.0] — 2026-09-09

### Added
- **Dynamic model discovery** (opencode adapter): the plugin registers every
  model `agy models` reports (24h cache in the state dir; stale cache beats an
  empty refresh; config `models` overrides/extends). New agy models appear
  without an adapter release.
- **Divergence detection with history re-seeding**: per-message hash baselines
  detect edited/regenerated/deleted threads. On divergence the adapter starts
  a fresh agy conversation seeded with the visible thread (last 20
  text-bearing messages, 4000 chars/message) and emits a
  `⟲ history diverged` reasoning line. Unknown baselines (pre-feature
  sessions) are adopted once.
- **Readable agent progress**: agy `step_update` events map to human-readable
  reasoning lines (`▸ tool view_file…`, `✓ view_file (0.3s)`,
  `✗ view_file failed`, `● response (1.7s)`) instead of raw JSON.
- **CRLF normalization** of model responses before they reach opencode.

### Fixed
- **Self-contained distribution**: `dist/` bundles the engine and runtime
  dependencies (zero externals), and `exports` point at the bundle. Local
  directory/registry-name provider specs fail to initialize in opencode
  1.18.29 (verified with a minimal trivial provider — the loader imports the
  `npm` field directly when it starts with `file://` and treats everything
  else as an npm registry coordinate). The supported local form is a `file://`
  URL to the dist entry file; models self-reference their transport the same
  way.
- **Bare model keys**: opencode indexes `provider.<id>.models` by bare model
  id; full `agy/<id>` config keys caused `ProviderModelNotFoundError` with a
  "Did you mean" suggestion of the same id.

### Documentation
- Install section rewritten around the verified contract (`file://` entry
  file, bare model keys, rebuild/restart note); root roadmap refreshed (v0
  engine and v1 opencode adapter shipped).

## [0.1.0] — 2026-09-09

### Added
- **Monorepo scaffold** (bun workspaces) and **agy-bridge-engine**: the
  host-agnostic agy runtime ported from the dotfiles router — async
  `stream-json` NDJSON runner (`init`/`step_update`/`result` events, stall
  watchdog, hard cap, progressive `run.log`), failure classification covering
  agy's three timeout exit signatures, resume via conversation ids captured
  from the `init` event, quota snapshot preflight. 83 tests at port.
- **Engine seams**: `expectArtifact` (artifact-less success for chat turns)
  and `logPath` (run.log destination), both backward-compatible.
- **opencode adapter** (`agy-bridge-opencode`): LanguageModelV3 provider +
  plugin — session↔conversation persistence (atomic state file, mutexes,
  30-day prune, resume via `--conversation`), message reduction to the last
  user turn (agy owns history), typed error taxonomy mapping
  (retryable/fatal + resume-once on mid-turn timeouts), workdir modes
  (`scratch`/`session`), quota preflight, `small_model` guidance, and a
  smoke suite against the installed opencode contracts.

### Verified
- End-to-end: real opencode loads the provider; a real chat turn completes
  through provider → engine → agy (Gemini); mid-turn cut resumes with full
  conversation memory; divergence re-seeds; 177 tests green at the archive
  point (208 by v0.2.0).
