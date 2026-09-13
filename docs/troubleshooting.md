# Troubleshooting — agy-bridge

Symptom → cause → fix, ordered by how often they bite. Everything here was
reproduced on opencode 1.18.29 + agy 1.1.28 unless noted.

## The provider fails to initialize

**Symptom**: chat or `opencode run` fails with
`Failed to initialize provider: agy` (or `ProviderInitError`).

**Causes, in order of likelihood**:

1. **Wrong `npm` field form.** opencode imports the `npm` value DIRECTLY when
   it starts with `file://`, and treats everything else as an npm registry
   coordinate (verified: a minimal provider with zero dependencies fails the
   same way; the package cache shows the path split into registry-like
   segments). The supported local form is a `file://` URL to the **entry
   file**, not a directory:

   ```jsonc
   "npm": "file:///abs/path/to/agy-bridge/packages/opencode-adapter/dist/provider.js"
   ```

   A directory path, a plain absolute path, or a `file://` URL to the package
   root all fail. Point at `dist/provider.js` (provider) and `dist/index.js`
   (plugin).

2. **Stale build.** `dist/` must exist and match the sources. After any
   source change: `bun run build` inside `packages/opencode-adapter`, then
   **restart opencode** — the module is cached per server process.

3. **Install cache is stale or broken.** opencode installs provider packages
   under `~/.cache/opencode/packages/<spec-path>/`. Inspect that directory:
   if it is missing files, delete the spec's entry and restart opencode to
   force a fresh install.

4. **Corporate npm proxies** silently block package downloads (no error is
   logged). Diagnostic: the cache directory above is empty despite a clean
   startup. Workaround: point `npm` at the local `file://` path, or allowlist
   the package in the proxy.

## `ProviderModelNotFoundError: Model not found: agy/x. Did you mean: agy/x?`

The model exists but the config key form is wrong. opencode indexes
`provider.<id>.models` by **bare model id** — the `agy/` prefix is added by
the provider id. Use `"default"`, `"gemini-3.8-flash-high"`, … — never
`"agy/default"`.

## A model is missing from `/model`

- The `/model` picker renders `provider.<id>.models` from **config** — that
  is the reliable channel. The plugin's `provider.models` hook (dynamic
  registration from `agy models`) is NOT consulted by opencode for
  providers declared via `provider.<id>.npm` (verified on 1.18.30: the
  hook never fires and the discovery cache is never written). Generate the
  live catalog and merge it into config:

  ```bash
  cd packages/opencode-adapter
  bun run scripts/export-config-models.ts   # optional: --bin /path/to/agy
  ```

  Paste the printed JSON fragment under `provider.agy.models`, then
  restart opencode.
- On host forms that DO consult the hook, discovery is lazy (first hook
  call, memoized per server — not at plugin init) and cache-first: 24h
  cache at `~/.local/state/agy-bridge/models-cache.json` (honors
  `XDG_STATE_HOME` and the `stateDir` option). Delete the cache file and
  restart to force a refresh. If `agy models` fails, the static fallback
  registry is used (`agy/default` plus a collapsed `gemini-3.8-flash` base
  with three effort variants).
- Models must be **declared in the config `models` map** to be selectable
  before the provider initializes (host lookup ordering). Effort-suffixed
  ids collapse into their base: pick the base entry and choose the effort
  variant; a suffixed id like `gemini-3.8-flash-high` in config still
  works as a flat pass-through.

## Turns run at the wrong effort, with a warning about variants

**Symptom**: a provider warning like
`model "agy/<base>" has effort variants but none was selected; using …` or
`unknown variant "<name>" for model "agy/<base>"; using …` — and the turn
runs at a different effort than the one you picked.

**Cause**: the adapter resolves `--model` per turn from the selected
variant; when the selection does not reach it (config fragment missing or
stale `variants` payload, or a variant name the base does not carry), it
falls back to the base's default — the highest discovered effort — and
reports it loudly instead of guessing silently.

**Fix**: regenerate the config fragment (`bun run
scripts/export-config-models.ts` in `packages/opencode-adapter`), merge it
under `provider.agy.models`, restart opencode, and reselect the effort.

## Progress shows blind `▸ response…` lines and tools without parameters

Responses render as a static `▸ response…` per delta and tools as
`▸ tool view_file…` with no arguments. Cause: the running server cached the
pre-enrichment dist bundle (before parameterized tool lines and response
previews shipped). Fix: rebuild (`bun run build` in
`packages/opencode-adapter`) **and restart opencode** — a running session
never picks up a rebuilt bundle, even with `dist/` already updated.

## Progress shows raw JSON instead of readable lines

The running server cached the pre-`formatStepUpdate` module. Rebuild
(`bun run build` in `packages/opencode-adapter`) and restart opencode —
ESM caches `dist/provider.js` by URL per process.

## Concerned the reasoning panel content reaches agy (cache/history impact)

It does not; the flow is one-way. The bridge forwards only the last user
message text (all opencode history, reasoning parts included, is dropped),
and agy owns the conversation in its own SQLite history, resumed via the
stored conversation id. The model's KV-cache depends exclusively on the bytes
agy sends upstream, so panel content cannot break caching (~96% cache hits
observed in a live resumed session); the only footprint is opencode's local
session storage, kept small by the sanitized one-line format.

## You see "Thinking..." but cannot open the reasoning text

The reasoning content IS delivered and persisted (check `type: "reasoning"`
rows in opencode's session store — the text is there). opencode **hides
finished thinking blocks by default**: while the part streams you see it
live, but once it ends the client filters it out unless the thinking
visibility toggle is on.

- TUI: run `/thinking` (alias `/toggle-thinking`) to expand/collapse thinking
  blocks. The `display_thinking` keybind exists but defaults to unbound —
  bind it in `opencode.json` if you want a key.
- Web UI: Settings → General → enable **"Show reasoning summaries"**
  (persisted per browser as `settings.v3 → general.showReasoningSummaries`,
  off by default; verified on 1.18.x). The TUI `/thinking` command does not
  exist in the web build. Raw stream always available in `run.log`.

## The turn timed out (or agy was cut mid-generation)

Timeouts are **recoverable by design** — agy has three distinct timeout exit
signatures and all of them map to the same recoverable outcome:

- The adapter resumes **once** automatically via the stored conversation id
  (agy keeps full memory — the answer usually completes).
- A second failure is fatal and names the `run.log` path. Read it: every
  `step_update` the agent emitted is in there, so you can see how far it got.
- Where `run.log` lives: scratch mode →
  `<scratchRoot>/agy-run-*/run.log`; session mode → `<worktree>/run.log`.

Note: `--print-timeout` bounds agy's **contiguous response wait**, not total
wall time — a run that streams tool activity can legitimately run longer than
the print timeout without triggering it. Total time is bounded by the engine's
hard cap (`timeoutMs`).

## Answers reference context you edited or regenerated (`⟲ history diverged`)

agy's server-side history is append-only; when you edit, delete, or
regenerate messages, opencode's visible thread diverges from it. The adapter
detects the mismatch (per-message hash baseline) and starts a **fresh agy
conversation seeded with your visible thread**, so the model answers from
what your screen shows. One reconciliation turn (re-sends context, no cache
warm-up), then normal operation. Sessions are mapped per opencode session id
in `~/.local/state/agy-bridge/opencode-sessions.json` as a **list of
conversation bindings** (cap 3, oldest evicted): each divergence appends a
new binding instead of overwriting the previous one. Delete ONE binding to
force a fresh conversation for that thread; delete the whole session key to
reset every thread under that sessionID. Bindings older than 30 days are
pruned automatically.

## Tool errors like `✗ view_file failed` in the progress panel

Expected in **scratch** workdir mode: agy runs in an empty temporary
directory, so it cannot see your repository files. Use
`"workdirMode": "session"` for repo-aware chats (agy then works inside the
opencode worktree — mind that it runs with elevated permissions there).

## Titles/summaries create agy conversations or burn agy quota

opencode calls `small_model` on **every** turn. Point it at a non-agy
provider — see the adapter README (`small_model` section).

## agy authentication expired / captcha errors

Run `agy` standalone once to complete the OAuth flow, then retry. Auth
failures are fatal (non-retryable) by design — the adapter surfaces them
instead of burning retries.

## Engine-level context (why the errors look the way they do)

The engine classifies every agy run into a typed outcome; the three timeout
signatures and the full taxonomy (auth / quota / transient / task_failure /
artifact) are documented in the root README ("Hard limits discovered about
agy"). If you are extending the adapter, classify first — never guess from
exit codes.
