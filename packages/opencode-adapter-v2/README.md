# agy-bridge-opencode-v2

opencode v2 (`@opencode/plugin` 2.2.5) entry for agy-bridge. It ships the same
behavior as the v1 server plugin in `packages/opencode-adapter`, through the v2
plugin contract:

```ts
export default { id: "agy-bridge", setup: async (ctx) => { ... } }
```

Use this package with opencode v2 only. opencode v1 keeps loading
`packages/opencode-adapter` unchanged.

## Configure opencode v2

Build the package first:

```bash
bun install
cd packages/opencode-adapter-v2 && bun run build
```

Then add the package directory to the `plugin` array of the v2
`opencode.json`. opencode resolves `exports["."]` to `dist/index.js`:

```json
{
  "plugin": ["/absolute/path/to/agy-bridge/packages/opencode-adapter-v2"]
}
```

Do not list the v1 package (`packages/opencode-adapter`) in a v2 config. v2
rejects it with `Plugin must export a default definition with an id and an
effect or setup function.`

### Provider entry

The provider factory runs on both opencode versions. Both of these values work
for `provider.agy.npm`:

```json
{ "provider": { "agy": { "npm": "file:///absolute/path/to/agy-bridge/packages/opencode-adapter/dist/provider.js" } } }
```

```json
{ "provider": { "agy": { "npm": "file:///absolute/path/to/agy-bridge/packages/opencode-adapter-v2/dist/provider.js" } } }
```

If you leave out `provider.agy`, the plugin registers the provider itself and
points it at this package's `dist/provider.js`.

## How the v1 hooks map to v2

| v1 hook | v2 registration | Notes |
| --- | --- | --- |
| `chat.params` | `ctx.session.hook("context", ...)`, scoped to provider `agy` | Sets `options.sessionId`, `options.worktree` and `options.agy = { sessionId, worktree }`. opencode sends keys that are not generation settings to the provider as `providerOptions`. |
| `provider.models` | `ctx.provider.transform(...)` | v2 transform callbacks are synchronous. The first callback starts model discovery (cache first, 24 h TTL) and reloads providers when it finishes. The next callback publishes the models. Nothing runs at `setup`. |
| `tool.{open_agy_session, agy_open, agy_cleanup_preview}` | `ctx.tool.transform(...)` adds the same three tools | Inputs use JSON Schema. Each tool returns `{ content }`. |

Worktree: v2 has no `input.worktree`. The plugin uses
`ctx.location.project.directory`, which is the git root opencode resolved. For
the `global` project (a directory outside git, reported as `/`), it uses
`ctx.location.directory`. v1 falls back the same way.

Plugin options (`ctx.options`) take the same keys as the v1 server options:
`bin`, `env`, `stateDir`, `models`, `imageInput`.

## TUI plugin

The package also ships a v2 TUI plugin (`exports["./tui"]`, `dist/tui.js`). It
has the same commands and dialogs as the v1 TUI.

The v2 TUI reads its plugins from `cli.json` in the config directory, not from
`tui.json`. opencode copies `tui.json` into `cli.json` only once, the first
time it migrates. Add the package directory to `cli.json`. opencode resolves
`exports["./tui"]` from it:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["/absolute/path/to/agy-bridge/packages/opencode-adapter-v2"]
}
```

| Trigger | Action |
| --- | --- |
| `/agy-open` (aliases `/agy:open`, `/agy`), command palette, `alt+a`, `ctrl+alt+a` | Open the agy dialog for the current session. Outside a session, list the saved sessions. |

Differences from v1:

- The commands are registered with `mode: "global"`. On 2.2.5, a layer in the
  default mode shows up in neither the palette nor slash completion.
- v2 `dialog.select` hides disabled options. The informational rows (session
  details and empty states) are selectable instead. Selecting one shows the
  same dialog again.
- The worktree is the git root of the session's project. For the `global`
  project, it is the session directory.

## Test

```bash
cd packages/opencode-adapter-v2 && bun test
```
