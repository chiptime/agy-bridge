# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(`0.x` = development line).

## [0.4.1] - 2026-09-13

### Changed
- **Docs-only release** (opencode adapter): the package README and the
  troubleshooting guide now document the 0.4.0 behavior — effort variants
  (collapse of `-high/-medium/-low` ids, loud V3-warning fallback,
  `scripts/export-config-models.ts` because the plugin `provider.models`
  hook does not fire for npm providers), session store v2 (multi-binding
  per sessionID, cap 3, longest-prefix routing, v1 auto-migration,
  divergence appends a new binding) and the wired 30-day prune — and fix
  the stale "discovery runs at plugin init" claim (discovery is lazy and
  memoized on first `provider.models` use). No code changes; published so
  npm serves the updated README for the 0.4.x line.

## [0.4.0] - 2026-09-12

### Added
- **Effort variants**: effort-suffixed agy ids (`-high/-medium/-low`)
  collapse into base models with variants; opencode delivers the selection
  as a merged payload (`agyModelId`) and the adapter resolves `--model`
  per turn. Falls back LOUDLY (V3 warning) instead of silently picking the
  highest effort. `scripts/export-config-models.ts` materializes the live
  catalog into opencode config (the plugin `provider.models` hook does not
  fire for npm providers).
- **Session store v2**: one sessionID now holds a LIST of conversation
  bindings (cap 3) with prefix-based routing, so side agents and
  compaction under the same sessionID no longer overwrite the main
  thread's baseline. v1 stores migrate automatically; divergence appends
  a new binding; `rebind` drops only the failed binding.
- **store.prune() wired** (30-day retention, fire-and-forget per turn).

### Fixed
- chat.params fixtures now mirror the real host request shape; the hook
  tolerates opencode's null second invocation per turn.
- prune() count bug (re-loaded through the implicit-prune path, always 0).

### Removed
- Temporary session-context diagnostic probes (both transport questions
  closed with production evidence).

## [pi 0.3.0] - 2026-09-13

First published `agy-bridge-pi` release — 0.1.0 and 0.2.0 were never
published, so `pi install npm:agy-bridge-pi` delivers both blocks below in
one version.

### Added
- **pi extension**: live token
  streaming with strict envelope reconciliation (streamed text is checked
  against agy's final response; on mismatch the envelope wins and the
  first-divergence offset is logged), `AskAgy` execution modes (`read`
  default → agy plan mode, `none` → plan mode in a forced fresh scratch dir,
  `full` → accept-edits, hideable via `allowFullMode: false`), layered file
  config (`~/.pi/agent/agy-bridge.json` then project `.pi/agy-bridge.json`,
  per-section merge, project wins per key; factory options > project >
  global > env), opt-in `AskAgy` registration (`askAgy.enabled`, one-time
  startup notice when unset) with name/label/description overrides, and an
  opt-in unified debug log (`AGY_BRIDGE_DEBUG=1` →
  `<stateDir>/agy-bridge/debug.log`, `AGY_BRIDGE_DEBUG_PATH` override,
  prompt bodies never logged). Behavior changes vs 0.1.0: `AskAgy` is now
  opt-in, and its default mode is `read` instead of always-full
  (`askAgy.enabled: true` + `defaultMode: "full"` restores v0.1 delegation).

### Changed
- **pi extension**: `AskAgy` non-isolated calls now have **thread memory**
  — successive DISTINCT
  prompts in the same pi session continue ONE agy conversation (keyed
  `<sessionKey>:ask` in pi-sessions.json, resumed with `--conversation`
  every call; the divergence re-seed table no longer applies because the
  tool prompt is the whole input). pi `/new` starts a fresh thread,
  `/resume` restores it, `isolated: true` stays a one-shot, and
  `/agy clear` clears the session and thread rows together (`/agy status`
  reports the thread binding). This is a clean break vs 0.2.0 with **no
  opt-out**: v0.2's fresh-conversation-per-distinct-prompt behavior is
  gone. Provider turns are unchanged (hashes + divergence byte-identical).
  Note: provider turns already see pi skills through the system prompt —
  no skills-forwarding seam exists or is needed.

## [Unreleased]

### Documentation
- Root README "Hard limits discovered about agy" extended with the verified
  stream-json stdin contract (bare `--print` rejected, raw stdin ignored,
  output shape identical to `--print --output-format stream-json`), the
  graceful SIGTERM mid-run partial flush, `result.response` as the
  concatenation of all `agent_response` `text_delta` chunks across steps,
  plan-mode headless write/command blocking (plan file + link output), and
  the `--sandbox` / `--dangerously-skip-permissions` incompatibility.

## [0.3.0] — 2026-09-11

### Changed
- **Enriched reasoning progress** (opencode adapter): `formatStepUpdate`
  now renders tool lines with the extracted parameter —
  `▸ tool view_file (path: src/index.ts)…`,
  `✓ view_file (path: src/index.ts) (0.3s)`,
  `✗ view_file (path: src/index.ts) failed` — and response lines with a live
  preview from `text_delta` (`▸ response: <sanitized preview>`,
  `● response (10.0s)` on done) instead of the blind placeholders the
  `formatStepUpdate` rewrite had introduced (static `▸ response…` per delta,
  tools without arguments). New exported helpers: `sanitizePreview` (newlines
  collapsed, trimmed, 60-char truncation with `…`) and `extractToolParam`
  (key precedence: `path`, `AbsolutePath`, `command`, `pattern`, `query`,
  `url`, …). Rendering is strictly non-throwing: hostile getters, circular
  structures, and unexpected `tool_info` shapes degrade through a
  compact-JSON fallback and a final `(step update)` line. 38 adapter unit
  tests; workspace suite 482 green; 100% line/function coverage of
  `language-model.ts`.

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
