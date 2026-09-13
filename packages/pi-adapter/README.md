# agy-bridge-pi

pi extension exposing the agy CLI as provider `agy`, the `AskAgy` tool, and
`/agy`.

## Install

Published on npm as
[`agy-bridge-pi`](https://www.npmjs.com/package/agy-bridge-pi) — `0.3.0` is
the first published version (0.1.0 and 0.2.0 were never published):

```sh
pi install npm:agy-bridge-pi
```

The package ships TypeScript source: pi's jiti loader runs it directly,
there is no build step. For development against a checkout, load it
straight from the repo instead (`bun install` once at the repo root, then
`pi -e ./packages/pi-adapter`).

Full install, safety wall, continuity, and configuration docs: see the
[repository README, "Install (pi)"](../../README.md#install-pi).

## Surface (v0.3)

- **Provider `agy`** — discovered models, thinking levels, live token
  streaming with strict envelope reconciliation (the final envelope wins on
  mismatch, logged under `AGY_BRIDGE_DEBUG`). Provider turns already see pi's
  skills through the system prompt — no forwarding seam needed.
- **Tool `AskAgy`** — opt-in (`askAgy.enabled: true` in file config; a
  one-time startup notice explains how to enable it). Params include
  `scope` (`scratch` | `worktree`) and `mode` (`read` default → agy plan
  mode | `none` → plan mode + forced fresh scratch | `full` → accept-edits).
  Successive non-isolated calls continue **one agy thread per pi session**
  (new in v0.3); `isolated: true` stays a one-shot.
- **Command `/agy`** — `status` (config, session binding, thread binding,
  in-flight provider turn; in-flight thread delegations are not shown on
  the turn line) and `clear` (drops BOTH the session and thread rows).
- **File config** — `~/.pi/agent/agy-bridge.json` then project
  `.pi/agy-bridge.json`; precedence factory options > project > global >
  env. `askAgy` section: `enabled`, `name`, `label`, `description`,
  `defaultMode`, `allowFullMode`, `defaultIsolated`, `appendSkills`.

## Behavior changes vs 0.2.0

1. `AskAgy` non-isolated calls have **thread memory**: successive DISTINCT
   prompts in the same pi session continue ONE agy conversation (v0.2 opened
   a fresh conversation whenever the prompt changed). There is **no opt-out**
   — `isolated: true` remains the one-shot escape hatch, `/agy clear` resets
   the thread, and pi `/new` starts a fresh thread (`/resume` restores it).
2. `/agy status` reports the thread binding (`thread: <id> (resume-always)`);
   `/agy clear` clears the session and thread rows together.

## Behavior changes vs 0.1.0

1. `AskAgy` is **off by default** — enable with `askAgy.enabled: true`
   (unset → one-time notice; `false` → silent).
2. `AskAgy`'s **default mode is `read`** (agy plan mode) instead of
   always-full. `askAgy.enabled: true` + `defaultMode: "full"` restores
   v0.1 delegation exactly.
