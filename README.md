# agy-bridge

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
- **adapters** (future): opencode provider, pi extension, legacy CLI. Each one
  shells into the same engine instead of re-implementing agy plumbing.

## Roadmap

- **v0** — engine port (this commit): spawn runner, outcome taxonomy, quota.
- **v1** — opencode provider adapter.
- **v1** — pi extension adapter.
- **CLI adapter** for the transition period, then deprecate the dotfiles
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

## Development

```
bun install
bun test            # root: runs all workspace tests
```

Engine package: `cd packages/engine && bun test && bunx tsc --noEmit`.
