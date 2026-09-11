# agy-bridge-pi

pi extension exposing the agy CLI as provider `agy`, the `AskAgy` tool, and
`/agy`. Full install, safety wall, continuity, and configuration docs: see the
[repository README, "Install (pi)"](../../README.md#install-pi).

## Surface (v0.2)

- **Provider `agy`** — discovered models, thinking levels, live token
  streaming with strict envelope reconciliation (the final envelope wins on
  mismatch, logged under `AGY_BRIDGE_DEBUG`).
- **Tool `AskAgy`** — opt-in (`askAgy.enabled: true` in file config; a
  one-time startup notice explains how to enable it). Params include
  `scope` (`scratch` | `worktree`) and `mode` (`read` default → agy plan
  mode | `none` → plan mode + forced fresh scratch | `full` → accept-edits).
- **Command `/agy`** — `status` and `clear`.
- **File config** — `~/.pi/agent/agy-bridge.json` then project
  `.pi/agy-bridge.json`; precedence factory options > project > global >
  env. `askAgy` section: `enabled`, `name`, `label`, `description`,
  `defaultMode`, `allowFullMode`, `defaultIsolated`, `appendSkills`.

## Behavior changes vs 0.1.0

1. `AskAgy` is **off by default** — enable with `askAgy.enabled: true`
   (unset → one-time notice; `false` → silent).
2. `AskAgy`'s **default mode is `read`** (agy plan mode) instead of
   always-full. `askAgy.enabled: true` + `defaultMode: "full"` restores
   v0.1 delegation exactly.
