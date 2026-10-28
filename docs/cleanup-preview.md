# Preview conversation cleanup without deleting data

Both adapters expose `agy_cleanup_preview`. It inventories Antigravity conversations
and reports possible old subagents, protections, and estimated storage. It never
invokes `agy-gc`, deletes conversations, prunes bindings, or changes MCP configuration.

## Quick path

Ask the host to call `agy_cleanup_preview` with `{}` (seven-day retention) or:

```json
{ "ttlDays": 14 }
```

`ttlDays` must be an integer from 0 to 36500. There is **no `apply` option**.
The tool is available independently of Pi's opt-in `AskAgy` delegation tool.

## Read the result

| Field | Meaning |
| --- | --- |
| `readOnly` | Always `true`; there is no destructive operation. |
| `complete` | Whether the scoped sources were read without warnings or truncation. |
| `entries` | Conversation IDs, structured evidence, protections, dates, and estimated bytes. |
| `disposition: candidate` | An old structured subagent with no observed protection; **not permission to delete**. |
| `disposition: protected` | A binding, lock, activity, retention rule, or missing evidence excludes it. |
| `disposition: unclassified` | There is insufficient structured evidence that this is a subagent. |
| `warnings` | Missing/unsupported metadata, corrupt stores, size limits, or partial results. |
| `totals` | Counts for the returned entries and estimated candidate bytes, not actual reclaimed space. |

Protection includes both OpenCode and Pi binding files in the configured bridge
state directory, **including expired rows still on disk**, and any matching
conversation exclusion lock. Active or unknown activity, invalid/unknown/timezone-less
dates, and recent sessions are protected. Corrupt/unknown binding formats make
the inventory conservative. Transcript text is not read or used for classification;
neither `ping` nor words such as `mapping` can create a candidate. Missing `brain`
alone does not establish that a conversation is disposable.

## Storage and runtime boundaries

- Source: `~/.gemini/antigravity-cli/` for the current OS user. No caller-supplied
  filesystem path is exposed by the tool.
- SQLite reads an owned, private temporary copy of the summary database and WAL.
  The live database is never opened with SQLite; only the owned copy is removed.
  A changing source or rollback journal produces incomplete evidence.
- Bun uses native `bun:sqlite`. Node uses optional `node:sqlite` when available
  (unflagged in Node 22.13+). An unsupported/disabled backend does not prevent
  plugin loading; invocation returns a protected filesystem inventory instead.
  No Python interpreter or new package dependency is required.
- The inventory is bounded to 500 entries, 128 MiB of snapshot data, 4 MiB per
  binding file, and 10,000 size-inspection nodes. Limits produce warnings rather
  than silently claiming a complete scan. File symlinks are not traversed.
- MCP bridges/configuration, diagnostics, attachments, and other installations'
  custom state directories are outside this first version's scope.

This is an advisory snapshot, not a global activity detector or a future deletion
plan. Sessions and bindings can change after inspection, and other configured
state directories may contain additional bindings. Any later destructive feature
requires its own coordination, revalidation, confirmation, and recovery design.
