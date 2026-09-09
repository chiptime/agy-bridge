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

- Models are **discovered dynamically** from `agy models` and registered by
  the plugin, with a 24h cache at
  `~/.local/state/agy-bridge/models-cache.json` (honors `XDG_STATE_HOME` and
  the `stateDir` option). Delete the cache file and restart to force a
  refresh.
- Discovery runs at plugin init; if `agy models` fails at startup the static
  fallback list (`agy/default` + `gemini-3.8-flash-*` tiers) is used.
- Models must also be **declared in the config `models` map** to be
  selectable before the provider initializes (host lookup ordering). The
  plugin-registered extras appear once the provider has initialized in the
  session.

## Progress shows raw JSON instead of readable lines

The running server cached the pre-`formatStepUpdate` module. Rebuild
(`bun run build` in `packages/opencode-adapter`) and restart opencode —
ESM caches `dist/provider.js` by URL per process.

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
in `~/.local/state/agy-bridge/opencode-sessions.json` — delete an entry to
force a completely fresh conversation.

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
