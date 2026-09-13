# agy-bridge-opencode

An [opencode](https://opencode.ai) custom provider + plugin that routes chat
turns through the `agy` CLI. opencode keeps its UI and session flow; agy owns
the conversation, tools, and permissions inside its workdir. Backed by
`agy-bridge-engine` for spawn, classification, and error semantics. Live agent
steps (tools, responses) stream into the reasoning panel as readable progress
lines, e.g. `▸ tool view_file (path: src/index.ts)…`,
`✓ view_file (path: src/index.ts) (0.3s)`.

**Host pin:** implements `LanguageModelV3` for opencode `>=1.15.0 <2`
(deps: `@opencode-ai/plugin` 1.18.30, `@ai-sdk/provider` 3.0.8). The provider
id must stay `agy` — the plugin's session channel keys on it.

## Install

**From npm (≥0.2.1)** — the package serves both the plugin and the provider
factory from the same entrypoint (it re-exports `createAgyProvider`, which
opencode's loader looks for):

```jsonc
// opencode.json
{
  "plugin": ["agy-bridge-opencode"],
  "provider": {
    "agy": {
      "npm": "agy-bridge-opencode",
      "options": { "workdirMode": "session", "timeoutMs": 600000 },
      "models": {
        "default": { "name": "Agy Default" },
        "gemini-3.8-flash": {
          "name": "Gemini 3.8 Flash",
          "variants": {
            "high": { "agyModelId": "gemini-3.8-flash-high" },
            "medium": { "agyModelId": "gemini-3.8-flash-medium" },
            "low": { "agyModelId": "gemini-3.8-flash-low" }
          }
        }
      }
    }
  }
}
```

**Local development (from this repo)** — `npm` must be a `file://` URL to the
**entry file** (`dist/index.js`), and `models` keys are **BARE ids** (no
`provider/` prefix — full ids cause `ProviderModelNotFoundError`). Verified
against opencode 1.18.29: registry-style specs and directory paths are
treated as npm coordinates and fail to initialize; `file://` URLs to an
entry file are imported directly:

```jsonc
{
  "plugin": ["file:///abs/path/to/agy-bridge/packages/opencode-adapter/dist/index.js"],
  "provider": {
    "agy": {
      "npm": "file:///abs/path/to/agy-bridge/packages/opencode-adapter/dist/index.js",
      "options": { "workdirMode": "session", "timeoutMs": 600000 }
    }
  }
}
```

- Rebuild after source changes (`bun run build` in the package) — the host
  imports `dist/`, and the module is cached per server process (restart
  opencode to pick up a rebuild).
- `models` in config is what the `/model` picker renders — and the reliable
  channel on verified hosts: opencode does NOT consult the plugin's
  `provider.models` hook for providers declared via `provider.<id>.npm`
  (verified on 1.18.30), so materialize the live `agy models` catalog into
  config with `scripts/export-config-models.ts` (see
  [Effort variants](#effort-variants)). Legacy flat keys (e.g.
  `gemini-3.8-flash-high`) still work as pass-through ids; config entries
  override names/limits.
- ⚠️ **0.2.0 is broken in the registry form** (missing `create*` re-export on
  the entrypoint) — use ≥0.2.1, or the local `file://` form above.

## Workdir modes

- `scratch` (default): each turn runs in a fresh `agy-run-*` dir under
  `scratchRoot` (default: system tmp); dirs older than 7 days are pruned,
  `run.log` kept.
- `session`: the turn runs directly in the opencode worktree (requires an
  absolute, existing worktree — config error otherwise).

## Effort variants

agy encodes the reasoning effort in model ids as a `-high`/`-medium`/`-low`
suffix. The adapter collapses those suffixed ids into their **base model**:
the `/model` picker shows ONE entry (e.g. `agy/gemini-3.8-flash`) whose
variants (`high`, `medium`, `low`) carry the full agy id passed as
`--model` at turn time. Switching effort mid-session takes effect on the
next turn — `--model` is resolved per call, including on resumed
conversations.

Per turn, the `--model` value is resolved in this order:

1. **Merged payload** — opencode merges the selected variant's `agyModelId`
   into the call options (`providerOptions.agy`).
2. **Variant name** — the selected variant key
   (`providerOptions.agy.variant`).
3. **Fallback** — the base model's own default: the HIGHEST discovered
   effort (a collapsed base has no exact bare agy id to spawn).

Fallbacks are LOUD, not silent: when a base has variants but none was
selected (or the variant name is unknown), the adapter emits a provider
warning, e.g. `model "agy/gemini-3.8-flash" has effort variants but none
was selected; using "gemini-3.8-flash-high"`.

Directly selecting a suffixed id (`agy/gemini-3.8-flash-high`) still works
for legacy pinned configs and existing sessions — it passes through as a
flat model whose `--model` is the full id.

### Materializing the catalog into config

The dynamic registry (plugin `provider.models` hook, backed by
`agy models` with a 24h cache) only applies on hosts that consult that
hook — verified opencode versions do not for providers declared via
`provider.<id>.npm`. The reliable path is to regenerate the config
fragment and merge it under `provider.agy.models`:

```bash
cd packages/opencode-adapter
bun run scripts/export-config-models.ts   # optional: --bin /path/to/agy
```

The script prints a JSON fragment to stdout (bare model ids as keys;
collapsed bases carry `name` + `variants`; `default` stays flat). Merge it
into your `opencode.json` and restart opencode.

## History divergence (re-seeding)

agy owns the conversation: each turn forwards only the last user message and
resumes via the stored conversation id. But opencode re-sends the full message
array every turn, and if you **edit, delete, or reorder earlier messages** in
the client, the visible thread no longer matches agy's server-side history —
agy would answer with stale context silently.

The adapter detects this by keeping per-session baselines of ordered
per-message hashes (first 16 hex of sha256 of each forwarded message, in
`opencode-sessions.json`) and comparing them against the incoming array.
Since 0.4.0, one opencode sessionID maps to a **list of conversation
bindings** (each `{ conversationId, hashes?, updatedAt }`, capped at 3 —
oldest evicted). opencode issues several model calls under one sessionID
(side agents, compaction), and each call continues the binding whose
baseline is the **longest prefix** of the incoming hashes instead of
overwriting one shared baseline:

- **Linear continuation** (a binding's baseline is a prefix of the incoming
  hashes; longest prefix wins) or no baseline yet → resume as usual.
- **Unknown baseline** (a binding stored without hashes — sessions mapped
  before this feature shipped; v1 single-entry files migrate automatically
  on load) → adopted as-is for one turn (resuming preserves agy's context),
  then protection is active from the stored hashes onward.
- **Divergence** (no binding baseline is a prefix — earlier messages
  changed) → a fresh agy conversation is started and the prompt becomes a
  bounded re-seed: the last **20** text-bearing messages rendered as
  `User: …` / `Assistant: …` inside a guarded block, each text truncated to
  **4000** chars, followed by your actual message. The reasoning panel shows
  `⟲ history diverged — new agy conversation seeded`. The new conversation
  id + incoming hashes are appended as a NEW binding — the other bindings
  (e.g. the main thread's) are untouched.

Responses are CRLF-normalized ( `\r\n` → `\n` ) and trailing whitespace at the
very end of a response is stripped before it reaches opencode.

## Reasoning progress panel

Live agent steps render as sanitized, single-line progress lines:

- Tool ACTIVE → `▸ tool view_file (path: src/index.ts)…`
- Tool DONE → `✓ view_file (path: src/index.ts) (0.3s)`
- Tool ERROR → `✗ view_file (path: src/index.ts) failed`
- Response ACTIVE with a text delta → `▸ response: <sanitized preview>`;
  without one → `▸ response…`
- Response DONE → `● response (10.0s)`

Tool lines carry the first matching `tool_info` key by precedence (`path`,
`AbsolutePath`, `command`, `pattern`, `query`, `url`, …), rendered as
`key: value`; response previews collapse newlines and truncate to 60 chars
(`sanitizePreview` / `extractToolParam`, both exported from
`language-model.ts`). Rendering is strictly non-throwing: hostile getters,
circular structures, or unexpected `tool_info` shapes degrade through a
compact-JSON fallback and a final `(step update)` line — a bad payload can
never crash the stream.

One-way data flow: the panel is presentation-only. The bridge forwards only
the last user message text (all opencode history — reasoning parts included —
is dropped), and agy owns the conversation in its own SQLite history, resumed
via the stored conversation id. Nothing the panel shows is ever sent back to
agy, so the upstream KV-cache is unaffected; the only footprint is opencode's
local session storage on disk, kept small by the truncated one-line format.

## Errors you will see

Missing `agy` → "install agy" (fatal). Transient outage → retried once
automatically. Mid-turn timeout → **one** silent resume via the stored
conversation id; a second failure is fatal and names the `run.log` path.
Auth/quota failures are fatal with re-auth guidance / reset time; agy task
failures surface agy's own text.

## `small_model` must point at another provider

opencode uses `small_model` for titles/summaries on **every** turn. Those
calls would each start an agy-owned conversation, polluting the very sessions
your main model relies on (and burning quota). Point it at another provider,
e.g. `"small_model": "google/gemini-2.5-flash"`.

## Debugging

Every attempt writes `run.log` next to its workdir: scratch mode →
`<scratchRoot>/agy-run-*/run.log`; session mode → `<worktree>/run.log`.
The session↔conversation store lives at
`${XDG_STATE_HOME ?? ~/.local/state}/agy-bridge/opencode-sessions.json`:
`{ version: 2, sessions: { [sessionID]: [binding, …] } }` with each binding
`{ conversationId, hashes?, updatedAt }` (v1 single-entry files migrate on
load). Bindings older than 30 days are pruned automatically — a
fire-and-forget sweep runs next to the scratch prune every turn, so the
store no longer grows unbounded.
