# agy-bridge-opencode

An [opencode](https://opencode.ai) custom provider + plugin that routes chat
turns through the `agy` CLI. opencode keeps its UI and session flow; agy owns
the conversation, tools, and permissions inside its workdir. Backed by
`agy-bridge-engine` for spawn, classification, and error semantics.

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
