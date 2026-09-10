# agy-bridge

[![npm version](https://img.shields.io/npm/v/agy-bridge-opencode.svg)](https://www.npmjs.com/package/agy-bridge-opencode)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](packages/opencode-adapter/LICENSE)

Host-agnostic bridge engine for the `agy` CLI plus thin host adapters. The
engine owns everything that talks to agy — spawning, the `stream-json` NDJSON
runner, outcome classification (error taxonomy), resume handles, budgets, and
passive quota selection. Host adapters stay thin: they translate their host's
task format into an engine run and map engine outcomes back.

## Architecture

```
opencode provider ─┐
pi extension ──────┼─► agy-bridge-engine ───► agy CLI (--print --output-format stream-json)
legacy CLI ────────┘   (spawn / classify /
                        resume / budgets / quota)
```

- **engine** (`packages/engine`): the ported runtime layer from
  `dotfiles/ai/opencode-router` `src/agy/*`. Zero host imports.
- **engine** (`packages/engine`): the ported runtime layer from
  `dotfiles/ai/opencode-router` `src/agy/*`. Zero host imports.
- **adapters**: **opencode provider — shipped** (`packages/opencode-adapter`,
  published as [`agy-bridge-opencode`](https://www.npmjs.com/package/agy-bridge-opencode)).
  Pending: pi extension, legacy CLI.

## Install (opencode)

Requires opencode `>=1.15` and an authenticated `agy` (run `agy` standalone
once). In your `opencode.json`:

```jsonc
{
  "plugin": ["agy-bridge-opencode"],
  "provider": {
    "agy": {
      "npm": "agy-bridge-opencode",
      "options": { "workdirMode": "session" }
    }
  }
}
```

Restart opencode, `/model` → pick an `agy/*` model. `workdirMode: "scratch"`
runs each turn in a disposable dir (safe default for unattended use);
`"session"` lets agy work inside the open worktree. `small_model` must point
at a non-agy provider. Full details — bare model keys, budgets, divergence
policy, local `file://` development form — in the
[adapter README](packages/opencode-adapter/README.md).

## Install (pi)

Requires pi `>=0.85` and an authenticated `agy`. Until the npm release, load
the package straight from a checkout — pi's jiti loader runs the TypeScript
source, there is no build step:

```sh
bun install                                   # once, at the repo root
pi -e ./packages/pi-adapter --list-models     # provider "agy" appears
pi -e ./packages/pi-adapter --model agy/default
```

What the extension registers:

- **Provider `agy`** — models discovered from `agy models` (24h cache,
  fallback catalog when discovery fails). `agy/default` maps to no `--model`.
  Effort-suffixed ids collapse into one model with thinking levels:
  `gemini-3.8-flash-{low,medium,high}` → `agy/gemini-3.8-flash:low|medium|high`.
- **Tool `AskAgy`** — one contained agy run per call. Params: `prompt`,
  `model?`, `thinking?`, `scope?` (`scratch` default | `worktree`),
  `isolated?` (no conversation continuity), `skills?` (inject the skills
  catalog; off by default).
- **Command `/agy`** — `status` (config, discovery cache, session binding,
  in-flight turn) and `clear` (drop this session's binding).

### Safety wall — read before pointing it at a real repository

- **Provider turns run agy inside pi's cwd with `--dangerously-skip-permissions`.**
  agy edits files itself; pi never sees those edits as diffs to approve. This
  is inherent to agy (no tool passthrough) — only use provider turns in a
  worktree you can `git checkout -- .` away.
- **`AskAgy` defaults to `scope: "scratch"`**: a fresh `agy-run-*` temp dir,
  never your cwd. Pass `scope: "worktree"` only when you want agy in the repo.
- The prompt travels to agy as one `stream-json` NDJSON line on **stdin, never
  argv** (a bare `--print` is rejected by agy and raw stdin is ignored, so the
  argv is `--input-format stream-json --output-format stream-json`).
- The globally installed `@estebanforge/pi-antigravity-bridge` coexists
  (different provider id and state file) but its tool-call hook logs a
  harmless `call-tool-fail` line whenever `AskAgy` runs.

### Continuity

Bindings live in `~/.local/state/agy-bridge/pi-sessions.json`, keyed by the
pi session id (cwd as fallback). Each turn resumes the bound agy conversation
with `--conversation <id>` while pi's history is a prefix of what agy already
saw; after `/model` switches, compaction, or edits that make the history
diverge, the adapter opens a fresh conversation seeded with a bounded
transcript (20 messages / 4000 chars) and emits `⟲ history diverged`.
`/new`, `/resume`, `/fork`, and `/reload` recycle all in-memory state; the
file survives (30-day prune).

### Configuration

Environment: `AGY_BIN` (binary override), `XDG_STATE_HOME` (state root).
Factory options (for a wrapper extension calling `createAgyExtension`):
`timeoutMs`, absolute `stateDir`, absolute `scratchRoot`, `models` override
map (same semantics as the opencode adapter). Relative paths throw before
any spawn.

### Not in v1

Tool passthrough, MCP, mid-run steering, token streaming (agy does emit
`text_delta` — future work), ACP, OAuth, images.

## Status & Roadmap

- ✅ **v0** — engine port: spawn runner (stream-json NDJSON, stall watchdog,
  hard cap), outcome taxonomy (three agy timeout signatures), quota preflight.
- ✅ **v1 — opencode provider adapter** (`packages/opencode-adapter`):
  LanguageModelV3 provider + plugin, dynamic model discovery from
  `agy models`, live agent progress, typed error mapping with resume-once,
  session↔conversation persistence, divergence detection with history
  re-seeding. Verified end-to-end against real agy (see its README).
- ✅ **npm publication** —
  [`agy-bridge-opencode@0.2.1`](https://www.npmjs.com/package/agy-bridge-opencode)
  (registry form requires ≥0.2.1; 0.2.0's entrypoint lacked the `create*`
  re-export — use 0.2.1 or the local `file://` form).
- ✅ **pi extension adapter** (`packages/pi-adapter`, `agy-bridge-pi` v0.1.0):
  native pi provider `agy` with discovered models and thinking levels, the
  `AskAgy` contained delegation tool, `/agy status|clear`, session continuity
  with divergence re-seeding. Verified end-to-end against real pi 0.85 + agy
  (see [Install (pi)](#install-pi)). Not yet published to npm.
- ⬜ **CLI adapter** for the transition period, then deprecate the dotfiles
  router (`ai/opencode-router`).
- `metrics.ts` is intentionally not ported yet — port once the engine's
  result types settle.

## Hard limits discovered about agy

These are empirical constraints the engine is built around; do not design
against them:

- **No tool-call passthrough.** agy cannot relay tool calls to the host; the
  host never sees structured tool use from an agy run.
- **No steering.** A running agy process cannot be steered mid-run — you get
  one prompt, one run, and resume (`--conversation <id>`) as the only
  continuation mechanism.
- **`--print-timeout` bounds the contiguous response wait, not total wall
  time.** A single long LLM turn can exceed it (silent while generating),
  while long runs with streaming events can stay under it. The engine derives
  the flag from its own budget (10s before the hard cap) and keeps the async
  runner's hard cap as the outer killer.
- **Three timeout exit signatures** (all classified as the recoverable
  `timeout / agy_print_wait_timeout` outcome):
  1. nonzero exit + plain-text `Error: timeout waiting for response`
     (pre-turn, the print client's own wait deadline);
  2. exit 0 + `status: "ERROR"` envelope whose error is the same
     `timeout waiting for response` (mid-turn cut);
  3. exit 0 + `status: "SUCCESS"` + empty response + stderr marker
     `[agy] print timeout after Ns with turn in progress` (mid-turn cut,
     artifact never lands).

## Models (opencode adapter)

The agy provider's model list is **discovered dynamically** from `agy models`
(TSV rows `<id>\t<Human Name>` after one preamble line; no `--json` flag,
~1-2s backend round-trip):

- `agy/default` is always first and maps to NO `--model` argument.
- Discovered models register as `agy/<id>` with agy's own display names,
  through the plugin's `provider.models` hook (pinned
  `@opencode-ai/plugin@1.18.30`).
- The static builtin list (default + the three `gemini-3.8-flash-*` tiers)
  is only the fallback when discovery is absent or empty.
- **Cache**: the discovery result is cached at
  `~/.local/state/agy-bridge/models-cache.json` (honors `XDG_STATE_HOME` and
  the adapter's `stateDir` option) with a **24h TTL**. A stale cache still
  beats an empty refresh; refresh failures degrade silently
  (cache → static list). Set `AGY_BIN` to point at a non-PATH agy binary.
- **Config overrides still win**: a `models` config key matching any
  registry entry overrides name/limits in place; any other key extends the
  list. Unknown model ids keep passing through as `--model <id>`.

## Development

```
bun install
bun test            # root: runs all workspace tests
```

Engine package: `cd packages/engine && bun test && bunx tsc --noEmit`.

## Documentation

- [CHANGELOG.md](CHANGELOG.md) — notable changes per release.
- [docs/troubleshooting.md](docs/troubleshooting.md) — symptom → cause → fix
  for the failure modes observed in the wild (provider init, model lookup,
  timeouts, divergence, quota pollution, auth).
- [`packages/opencode-adapter/README.md`](packages/opencode-adapter/README.md)
  — install, configuration, workdir modes, divergence policy, errors.
