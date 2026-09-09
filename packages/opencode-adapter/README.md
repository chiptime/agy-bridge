# agy-bridge-opencode

An [opencode](https://opencode.ai) custom provider + plugin that routes chat
turns through the `agy` CLI. opencode keeps its UI and session flow; agy owns
the conversation, tools, and permissions inside its workdir. Backed by
`agy-bridge-engine` for spawn, classification, and error semantics. Live agent
steps (tools, responses) stream into the reasoning panel as readable progress
lines, e.g. `▸ tool view_file…`, `✓ view_file (0.3s)`.

**Host pin:** implements `LanguageModelV3` for opencode `>=1.15.0 <2`
(deps: `@opencode-ai/plugin` 1.18.30, `@ai-sdk/provider` 3.0.8). The provider
id must stay `agy` — the plugin's session channel keys on it.

## Install

```jsonc
// opencode.json
{
  "plugin": ["agy-bridge-opencode"],
  "provider": {
    "agy": {
      "npm": "agy-bridge-opencode",
      "options": { "workdirMode": "session", "timeoutMs": 600000 },
      "models": {
        "agy/gemini-3.8-flash-high": { "name": "gemini-3.8-flash-high" }
      }
    }
  }
}
```

`agy/default` (first in `/model`, agy picks the backend) plus the
`gemini-3.8-flash-*` tiers ship built in; `models` entries override limits or
add ids passed through as `--model <suffix>`. Budgets pass through `options`:
`timeoutMs` is the per-attempt cap, per-model `limit: { context, output }`
scales the window opencode shows.

## Workdir modes

- `scratch` (default): each turn runs in a fresh `agy-run-*` dir under
  `scratchRoot` (default: system tmp); dirs older than 7 days are pruned,
  `run.log` kept.
- `session`: the turn runs directly in the opencode worktree (requires an
  absolute, existing worktree — config error otherwise).

## History divergence (re-seeding)

agy owns the conversation: each turn forwards only the last user message and
resumes via the stored conversation id. But opencode re-sends the full message
array every turn, and if you **edit, delete, or reorder earlier messages** in
the client, the visible thread no longer matches agy's server-side history —
agy would answer with stale context silently.

The adapter detects this by keeping a per-session baseline of ordered
per-message hashes (first 16 hex of sha256 of each forwarded message, in
`opencode-sessions.json`) and comparing it against the incoming array:

- **Linear continuation** (baseline is a prefix of the incoming hashes) or no
  baseline yet → resume as usual.
- **Unknown baseline** (session mapped before this feature shipped) → adopted
  as-is for one turn (resuming preserves agy's context), then protection is
  active from the stored hashes onward.
- **Divergence** (baseline not a prefix — earlier messages changed) → a fresh
  agy conversation is started and the prompt becomes a bounded re-seed: the
  last **20** text-bearing messages rendered as `User: …` / `Assistant: …`
  inside a guarded block, each text truncated to **4000** chars, followed by
  your actual message. The reasoning panel shows
  `⟲ history diverged — new agy conversation seeded`. The new conversation id
  becomes the stored baseline.

Responses are CRLF-normalized ( `\r\n` → `\n` ) and trailing whitespace at the
very end of a response is stripped before it reaches opencode.

## Errors you will see

Missing `agy` → "install agy" (fatal). Transient outage → retried once
automatically. Mid-turn timeout → **one** silent resume via the stored
conversation id; a second failure is fatal and names the `run.log` path.
Auth/quota failures are fatal with re-auth guidance / reset time; agy task
failures surface agy's own text.

## `small_model` must point at another provider

opencode uses `small_model` for titles/summaries on **every** turn. Those
calls would each start an agy-owned conversation, polluting the very sessions
your main model relies on (and burning quota). Configure it elsewhere, e.g.
`"small_model": { "provider_id": "opencode/grok-code", "model_id": "..." }`.

## Debugging

Every attempt writes `run.log` next to its workdir: scratch mode →
`<scratchRoot>/agy-run-*/run.log`; session mode → `<worktree>/run.log`.
The session↔conversation map lives at
`${XDG_STATE_HOME ?? ~/.local/state}/agy-bridge/opencode-sessions.json`.
