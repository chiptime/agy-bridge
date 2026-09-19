# PRD: Bounded timeout recovery with trustworthy diagnostics

**Status:** Slices 1 and 2 implemented (uncommitted in the working tree). Slice 3 (enabling recovery for continuing conversations) remains blocked on verified `agy` CLI resume-safety evidence — see "Implementation status" below. **Revision 2 (this session):** decision A adopted — an explicit non-retryable `termination_unconfirmed` outcome with bounded local termination, applied to BOTH adapters, plus a ten-session concurrency model. Scope previously limited to OpenCode is explicitly extended to Pi; see "Superseded boundaries" below.

## Executive outcome

OpenCode users should receive the same bounded opportunity to recover a timed-out call whether it starts or continues an agy conversation. Recovery must not silently replay work, override cancellation, or erase the evidence needed to explain failure. When recovery is unsafe or exhausted, the provider must explain why and identify the preserved logs. From the host's perspective, a successful recovery remains a single request/response pair: OpenCode receives one turn result, never a visible duplicate or an extra host-level retry.

**Revision 2:** When local child termination cannot be confirmed, neither adapter may classify the call as an ordinary replayable timeout, spawn another agy process for the same request, or present it to its host as retryable. The call must end with an explicit `termination_unconfirmed` outcome inside a bounded wall-clock budget, stating what triggered termination (total timeout, silence watchdog, or caller abort), which signals were requested and observed, and that remote work may still be running. Ten concurrent host sessions (five OpenCode, five Pi) sharing one project directory must run isolated: independent conversations, exclusive logs, non-interfering cancellations, and no lost store updates.

**Delivery gate:** Verify the supported agy CLI's continuation and interrupted-turn semantics before enabling additional automatic recovery. A conversation ID alone is not proof that recovery is safe.

## Problem and evidence

The sanitized incident ended with `error: interrupted`, an `ERROR` result with an empty response, and a valid conversation ID. The user received `agy timed out and could not be resumed` despite visible progress.

| Verified observation | Implication and limit |
| --- | --- |
| The result reports approximately 164.8 seconds. | This is not established as total process wall-clock duration; it does not identify the timer that fired. |
| The first response reports approximately 48,879 input tokens. | Large context is observed, not proven to cause the interruption. |
| Configured local bundles belong to a checkout declaring adapter version 0.5.1; no timeout override was found in the inspected global/project configuration. | On-disk configuration and bundles do not prove which bytes the failing process had loaded. |
| Inspected bundle defaults are 1,230,000 ms per attempt and 600,000 ms without stdout/stderr. Default stdin transport omits `--print-timeout`. | Increasing the timeout is not an evidence-backed fix for this incident. |
| Continuing a stored conversation sets `resumed` before timeout recovery is considered. The recovery gate requires `!resumed`. | Conversation continuation consumes eligibility intended for a recovery attempt. |
| Every attempt opens the same workdir `run.log` with truncation. | A single remaining initialization event cannot establish that no earlier attempt occurred; concurrent calls can also overwrite evidence. |
| In `workdirMode: "session"`, the workdir is the plugin's worktree itself, reused verbatim across every host (OpenCode/Pi) session that operates on that project. | The `run.log` collision is not limited to the two attempts of one call: unrelated host sessions on the same worktree can overwrite each other's log entirely. |
| `interrupted` alone is not classified as timeout. | The actual timeout flag, exit code, or recognized timeout text remains unknown. |

Source anchors, relative to the repository:

- `packages/opencode-adapter/src/turn.ts`: `runTurn`, continuation selection, recovery gate, timeout default, and log path.
- `packages/opencode-adapter/src/workdir.ts`: `prepareWorkdir`, session-mode worktree reuse across host sessions, and scratch-mode per-call `mkdtemp` isolation.
- `packages/opencode-adapter/src/errors.ts`: `mapClassification`, `ErrorContext.resumed`, and `Full log:` formatting.
- `packages/engine/src/spawn.ts`: `runAgyStream`, `buildAgyArgs`, watchdogs, process outcome, and log creation.
- `packages/engine/src/outcomes.ts`: `classifyRun` and timeout classification precedence.
- Inspected runtime equivalents: `packages/opencode-adapter/dist/provider.js:429–514,578–608,1528–1540,1573–1699`. These are evidence anchors, not files to hand-edit.

## Goals and boundaries

**Goals:** Separate conversation continuity from recovery accounting; allow at most one safe automatic recovery per adapter call; preserve cancellation and failure causes; retain distinct call/attempt evidence; provide actionable terminal guidance.

**Non-goals:** Unlimited retries, exactly-once execution guarantees, changing model/context selection, raising timeout defaults, redesigning session routing, implementing a new recovery service. Shared-engine changes must preserve other consumers' behavior.

### Superseded boundaries (Revision 2 — traceability preserved)

| Original boundary | Revision 2 disposition |
| --- | --- |
| Non-goal: "changing Pi adapter recovery policy" (original §Goals and boundaries) | **Explicitly superseded, narrowly.** Pi now handles the new `termination_unconfirmed` outcome (no replay, non-retryable, honest message, per-attempt log evidence). Pi's existing resume-once behavior for *confirmed* local-termination timeouts is unchanged and remains a separate policy question outside this revision. |
| Original §2 recovery-eligibility emphasis on OpenCode only | Both adapters are in scope for outcome mapping and termination handling. Slice 3's OpenCode-only continuation gate (`RECOVERY_RESTRICTED_TO_NEW_CONVERSATIONS`) is unchanged. |
| Original §3 log identity satisfied per adapter ad hoc | Pi gains per-attempt log filenames (its resume attempt must no longer truncate the initial attempt's log). A general cross-adapter diagnostics extraction is NOT authorized; reuse stays minimal. |

Nothing else in the original non-goals list is relaxed.

## Required behavior

### 1. One recovery budget per call

A call is one invocation of the adapter's turn orchestration. Its initial attempt may start a new conversation or continue a stored one. Neither choice consumes its recovery budget. Track recovery consumption separately from conversation continuation; avoid parallel policy decisions in orchestration and error formatting.

Only a timeout-classified initial attempt with a usable conversation ID, no cancellation, and verified safe continuation is eligible. Permit at most one recovery attempt and at most two child invocations per call. Non-timeout failures do not enter this recovery path. Preserve existing non-timeout host retry semantics without marking exhausted timeout recovery as automatically retryable.

| Situation | Required result |
| --- | --- |
| New conversation succeeds | Return success and persist the normal binding; no recovery. |
| New conversation times out with usable ID and safe continuation | Consume the call's one recovery opportunity. |
| Existing conversation times out with usable ID and safe continuation | Same opportunity; ordinary continuation must not count as recovery. |
| Timeout without usable ID | Stop with an explicit missing-ID reason; do not invent an ID or silently start a new conversation. |
| Continuation safety cannot be established | Stop with an explicit safety reason and preserved logs; no speculative replay. |
| Recovery succeeds | Return the recovered response and apply normal successful binding/hash persistence. |
| Recovery fails, including another timeout | Stop; report both the initial cause and recovery outcome. No third attempt. |
| Caller cancels before spawn, between attempts, or during recovery | Abort, prevent any further spawn, and retain diagnostics. Cancellation never authorizes recovery. |

Preserve divergence/re-seeding behavior and existing abort persistence unless a separately justified change is necessary. Do not commit successful history hashes for a failed recovery. Define terminal binding retention/invalidation before implementation; do not discard a usable binding merely because the recovery budget is exhausted.

### 2. Recovery safety and termination

- Verify whether `--conversation` continues an interrupted turn, adds a new user turn, or can duplicate queued/executed work for each supported transport. Record supported CLI versions and concrete evidence before enabling the new path. No such guarantee is established by this PRD.
- Do not blindly resend the full original prompt or attachments as a recovery instruction. The selected transport/payload must follow the verified semantics. If safety cannot be established, suppress automatic recovery rather than infer safety from tool names or incomplete logs.
- Side effects may already have occurred before interruption. A timeout or terminated local process does not prove that remote work stopped. Never promise exactly-once execution or automatically undo prior work.
- Wait for confirmed local child termination before starting recovery; if termination cannot be confirmed within a bounded cleanup interval, stop instead. Local termination alone is not sufficient proof of remote recovery safety.
- Check cancellation at every spawn boundary and settle once under timer/abort/exit races. Caller cancellation is the public outcome when it cancels the in-flight call; retain an earlier timeout as diagnostic history rather than relabeling it.
- Preserve distinct observed causes: total deadline, silence watchdog, recognized CLI timeout, caller abort, child exit/signal, and unclassified interruption. Keep unknowns explicit.

Keep the current per-attempt timeout configuration and defaults initially. With two attempts, the maximum configured active-process budget is twice `timeoutMs`, plus bounded cleanup; it is not one shared deadline. Select the cleanup bound before implementation and ensure cleanup failure cannot create an unbounded call.

### 3. Logs and bounded diagnostics

Allocate a unique call identity and an exclusive attempt log for each child invocation, generated through a collision-resistant scheme (for example a UUID/ULID) combined with the attempt index, not derived from a low-resolution timestamp alone. This identity alone is sufficient to isolate every call and attempt regardless of workdir mode, so it must not be substituted with an existing correlation identifier. Neither retries nor concurrent sessions in the same workdir may truncate another attempt's evidence. Use non-sensitive generated identifiers in filenames, not prompt text or raw session content. Do not name logs after the agy conversation ID or the host (OpenCode/Pi) session ID: both are reused across many calls over their lifetime — the conversation ID across every turn that continues it, the session ID across every call the host issues, and in `workdirMode: "session"` across every unrelated host session sharing the same worktree — so keying the filename on either would let a later call overwrite an earlier one's log, the same class of collision this PRD closes. Both identifiers are also excluded from persisted artifacts as raw session content.

Preserve the exact `Full log: <absolute-path>` convention. The path must name a readable regular file for that specific call, containing a bounded summary and the paths to all its attempt logs, including the first failure. Do not point errors at a mutable shared latest-run alias. Migrate away from the fixed workdir `run.log` as part of slice 1, alongside the unique call/attempt logs it introduces; if that legacy filename is retained for convenience, it must not be authoritative or required for diagnosis.

Use a bounded, allowlisted diagnostic record: call/attempt identity, continuation-versus-recovery mode, ID availability, effective thresholds, bridge-measured wall elapsed time, exit code/signal, observed timeout/abort flags, classification reason, recovery disposition, and log paths. Record loaded bridge/CLI version only when already reliably known; otherwise use `unknown`, without spawning discovery commands for logging.

Do not additionally capture prompts, attachments, environment variables, credentials, raw session identifiers, or arbitrary provider error text in metadata. Existing process output may contain sensitive data: logs remain local with owner-restricted access, no automatic upload, and no new copying into telemetry. Sanitize bounded user-facing excerpts and mark truncation explicitly.

Retention must have finite age and byte/count limits, apply to session and scratch modes, and delete only bridge-owned completed call groups. Never prune active attempts or follow arbitrary symlinks. Preserve summaries and their attempt logs together. Specify numeric limits before implementation; do not ship indefinite retention. Logging/pruning failures must not trigger recovery or replace the original cause; report diagnostic unavailability honestly instead of claiming a readable log exists.

### 4. Actionable terminal errors

State the observed cause, whether recovery was attempted, and why it stopped: missing ID, unsafe/unsupported continuation, cancellation, unconfirmed termination, or exhausted budget. Retain the original cause even if recovery fails differently. Avoid `could not be resumed` when the actual reason is a policy decision.

Guidance should direct the user to the call-specific logs and, where appropriate, inspection of partial side effects before a deliberate retry/new session. Do not print an unverified CLI resume command or recommend an automatic replay. A cancellation message must not recommend automatic recovery.

### 5. Unconfirmed local termination (Revision 2, decision A)

When a termination request (total timeout, silence watchdog, or caller abort) does not lead to a confirmed child exit/close, the engine must resolve the call explicitly instead of hanging or pretending the timeout replayed safely.

**Required engine behavior (`runAgyStream`):**

1. On any termination trigger, send `SIGTERM` and record it as the requested signal.
2. Start a finite grace interval. If the child exits/closes within it, settle normally with the observed exit code/signal.
3. If the grace interval expires, attempt `SIGKILL` and record the escalation. A `kill()` that throws or fails must be caught and recorded, never crash the process, and must still hand control to the final deadline.
4. Arm a finite final settle deadline after the escalation. If neither `exit` nor `close` has arrived by then, settle exactly once: close the attempt-log fd, destroy child streams, clear every timer and listener-owned resource, and resolve with an explicit `terminationUnconfirmed` marker plus the original trigger (`timeout`, `stall`, or `abort`), the requested signal(s), and the observed signal if any. A late exit/close after settlement must be ignored.
5. All termination stages (grace, escalation, final deadline) must be represented by timers cleared in `finish()`, must check the settle-once guard, and must add a documented finite worst-case latency per attempt.

**Required classification:** a run whose local termination could not be confirmed classifies as a distinct, non-retryable outcome (`termination_unconfirmed`) that precedes the stalled/timeout rules, preserving the original trigger in its reason. It is never fallback-eligible. Confirmed terminations keep today's classifications.

**Required adapter behavior (OpenCode and Pi):**

- `termination_unconfirmed` never produces a second spawn for the same request (no recovery attempt, no new conversation, no host-level retryable flag).
- The outcome maps to an explicit, honest terminal message naming the trigger, the missing confirmation, the per-attempt log path(s), and a warning that remote work may still be running and side effects may be partial.
- Caller cancellation keeps its public contract (abort outcome). If the child's termination could not be confirmed, that fact is retained as diagnostic history on the abort, not relabeled as success or plain timeout.
- A later request on a conversation left in an uncertain state is NOT treated as proof the remote turn finished; no binding/hash is persisted as success for the failed call, and no automatic remote reset is invented (none exists in the CLI). Whether to quarantine such a conversation remains an open decision (see open decisions).

**Guarantee boundary:** settling with `termination_unconfirmed` proves only that the bridge stopped waiting and stopped trying to signal the local child. It does not prove the child died, and it never proves remote work stopped — changelog evidence (1.2.4/1.2.6) shows remote turns and daemon background tasks survive local process death. Messages must not claim otherwise.

### 6. Concurrency model: ten sessions, two adapters (Revision 2)

Four identities are distinct and must stay distinct:

| Identity | Example source | Used for |
| --- | --- | --- |
| Host session identity | OpenCode session id / Pi session key | bindings, divergence checks |
| agy conversation identity | captured `conversation_id` | resume, continuation |
| Execution (call) identity | `generateCallId` | log group, diagnostics summary |
| Attempt identity | call id + attempt index | per-attempt log filename |

Required properties:

- Independent agents use independent conversations and executions; ten sessions may share one project directory and run in parallel.
- At most one active request per agy conversation; exclusion of one conversation must not block other conversations, and no global lock may be held during inference.
- Logs, results, cancellations, and bindings belong to a specific execution; shared-state writes stay atomic (existing store pattern: O_EXCL lockfile + tmp+rename). Cross-process exclusion must work across processes, not only between objects in one process.
- Existing per-conversation exclusion was ABSENT: neither adapter enforced one-active-request-per-conversation. Revision 2 adds a bounded, per-conversation lock reusing the proven O_EXCL + stale-takeover lockfile pattern; a second concurrent request on the same conversation fails fast with an explicit busy error instead of overlapping. The lock is released when the call settles (including `termination_unconfirmed` and abort), and never held across host turns.

**Verification criteria (deterministic, fake children, no real agy):** five OpenCode and five Pi sessions on one temporary project directory; a barrier proving ten genuinely overlapping executions (not an internally serialized `Promise.all`); per-session response/binding correctness; one cancellation affecting only its own session; one timeout not blocking the set; an unconfirmable child settling as `termination_unconfirmed` with exactly one spawn; exclusive untruncated logs; retention never deleting active executions' logs; failures persisting no success hashes; no lost store updates; and two requests on the same conversation never overlapping (including a focused cross-process lock proof with its own temporary resources). This proves the bridge supports the simulated scenario; it does not measure provider-side concurrency capacity.

## Acceptance criteria and proposed verification

All tests below are **proposed**, not executed. Use fake child processes, deterministic clocks, temporary local log roots, and existing adapter/engine seams; no live agy or provider access is required for these tests. Fake-process tests prove bridge behavior, not real CLI resume semantics.

| ID | Acceptance criterion | Proposed deterministic test |
| --- | --- | --- |
| AC1 | First-call success uses one spawn and normal persistence. | Fake successful stream; assert response, binding, and spawn count. |
| AC2 | Both new and existing conversations receive one eligible recovery. | Parameterize initial binding; timeout then success; assert exactly two spawns and one recovery notification. |
| AC3 | Recovery failure is terminal and preserves both causes. | Initial watchdog timeout then timeout/task error; assert two spawns, no host timeout retry flag, and both log references. |
| AC4 | Missing ID and unknown/unsafe CLI continuation prevent recovery. | Parameterized eligibility failures; assert one spawn and distinct actionable reasons. |
| AC5 | Cancellation never causes an additional recovery spawn. | Abort before spawn, between attempts, during recovery, and concurrently with timeout/exit; assert cancellation outcome and single settlement. |
| AC6 | Failure causes remain distinguishable. | Independently inject cap expiry, silence expiry, exit 124, recognized CLI timeout, signal exit, and plain `interrupted`; do not promote interruption alone to timeout. |
| AC7 | Recovery cannot overlap an unconfirmed child or exceed the call budget. | Delay/omit child exit; advance cleanup clock; assert no overlapping/third child and bounded completion. |
| AC8 | Recovery payload follows an explicitly verified transport contract. | Assert exact argv/stdin against an approved fixture; reject unsupported semantics rather than replay the prompt. Real CLI evidence is a separate prerequisite. |
| AC9 | Logs survive recovery and concurrent calls. | Interleave two calls sharing one workdir; assert exclusive paths, intact first-attempt output, and stable call summaries. |
| AC10 | `Full log:` remains usable and diagnostic failure is truthful. | Read the named summary and all attempt references; inject write failure and assert original cause plus explicit log unavailability. |
| AC11 | Diagnostics and retention remain bounded and private. | Inject long/sensitive fields, completed/active groups, unrelated files, and symlinks; assert allowlisting, truncation, limits, and protected active/unowned files. |
| AC12 | Compatibility remains intact. | Cover custom `timeoutMs`, defaults, divergence, success/abort persistence, terminal binding policy, and unchanged shared-engine consumers. |

## Rollout, risks, and open decisions

Ship diagnostics and policy separation before expanding automatic recovery. Enable the expanded path only for CLI/transport combinations whose semantics satisfy the safety gate. Rollback must be able to suppress the new recovery path without deleting existing logs or changing their format. No new user-facing configuration flag is required by this PRD.

| Decision required before implementation/release | Risk if left implicit |
| --- | --- |
| Verified CLI versions, continuation semantics, recovery payload, and eligibility rule | Duplicate side effects or concurrent remote execution. |
| Cleanup interval and termination/escalation behavior | Hung calls or overlapping processes. |
| Final binding retention/invalidation policy | Lost continuity or accidental replay on the next call. |
| Log root, numeric retention limits, size truncation, and legacy fixed-path migration | Disk growth, sensitive-data persistence, or broken support workflows. |
| **Revision 2 additions:** grace/final-deadline bounds (fixed engine constants, not public config); busy-failure policy for a second concurrent request on the same conversation; conversation-left-uncertain policy after `termination_unconfirmed` | Unbounded calls, confusing double-request failures, or a silent replay into a conversation whose remote turn may still be active. **Decided (user-confirmed, this session): warn-and-continue is the standing policy** — the next request on a conversation left uncertain behaves as an ordinary continuation, and the previous terminal message carries the partial-effects warning. Quarantine (block resumption until manual release) may be proposed later as a separate change; nothing in Revision 2 depends on it. |

Success means the deterministic criteria pass, the supported recovery semantics have separately authorized evidence, and operators can distinguish timeout, cancellation, and exhausted recovery using one call's preserved diagnostics. It does not mean the original incident's exact trigger has been retroactively proven.

## Small implementation slices

1. **Preserve evidence:** unique call/attempt logs (retiring the shared workdir `run.log`), bounded cause metadata, compatible error paths, and retention behavior; cover AC6 and AC9–AC11.
2. **Separate accounting:** model continuation independently from the per-call recovery budget; preserve abort precedence and existing routing/persistence; cover AC1–AC5 and AC12 without enabling unverified recovery.
3. **Enable verified safe recovery:** document supported CLI semantics — tracked as a separate `sdd-research` lane producing auditable evidence before this slice's tasks are written — implement the approved payload and bounded termination handling, then cover AC7–AC8 and rerun the full acceptance matrix.

Each slice includes its own tests and relevant troubleshooting updates when implementation is separately authorized. This PRD does not initiate those slices.

## Revision 2 work blocks (option A + ten-session concurrency)

1. **A1 — terminal outcome and bounded termination (engine):** `terminationUnconfirmed` on `SpawnRun`/`RunSignal`; SIGTERM → finite grace → SIGKILL → finite final deadline with settle-once, kill-failure handling, timer/listener/fd cleanup, and late-exit protection; new `termination_unconfirmed` outcome with trigger-preserving reasons, ordered before stalled/timeout, non-fallback; optional internal grace/settle test seams. Covers §5 engine requirements.
2. **A2 — safe integration in both adapters:** explicit `termination_unconfirmed` mapping in both `mapClassification`s (non-retryable, honest message, log references, partial-effects warning); recovery/replay gates verified by explicit tests (never a second spawn); cancellation contract preserved with unconfirmed-termination diagnostics; Pi per-attempt log filenames (no truncation of attempt 1); per-conversation exclusion lock reusing the O_EXCL + stale-takeover pattern, released on every settle path. Covers §5 adapter requirements and §6 exclusion.
3. **A3 — isolation proof:** the deterministic ten-session matrix of §6, including the focused multiprocess lock proof. Covers §6 verification criteria.

## Implementation status

**Slice 1 — preserve evidence (closed, prior session):** Per-call/per-attempt
diagnostics with collision-resistant identity (`generateCallId`), the
three-tier retention scheme with owner-restricted permissions (0o700/0o600),
symlink-root guards on prune functions (documented as not closing the
TOCTOU race), and the `Full log:` summary convention now live in
`packages/opencode-adapter/src/diagnostics.ts`. `packages/engine/src/spawn.ts`
opens the attempt log before spawning and closes its fd if `spawnImpl` throws
synchronously. Pre-spawn open/start failures are wrapped as `TurnError`
(never a raw `Error`) in `runTurn` (`packages/opencode-adapter/src/turn.ts`).
This work was implemented and verified (792/792 tests, clean `tsc --noEmit`
in engine/opencode-adapter/pi-adapter) in a prior session; it is referenced
here, not restated as this session's contribution.

**Slice 2 — separate accounting (this session):** `runTurn`
(`packages/opencode-adapter/src/turn.ts`) now tracks two orthogonal facts
that were previously conflated under the single `resumed` flag:
`wasOrdinaryContinuation` (this call's initial attempt continued an existing
conversation — the pre-existing D5/R7 fact, unchanged) and
`recoveryBudgetConsumed` (this call has actually spawned its one recovery
attempt — false until the `canResume` branch runs). An explicit, named
guard, `RECOVERY_RESTRICTED_TO_NEW_CONVERSATIONS` (currently `true`),
gates whether a continuing conversation's timeout may ever reach the
recovery branch; it is independent of the budget counter and is kept ON —
see "Slice 3" below for why. Because the restriction is ON, observable
eligibility (which timeouts get a second spawn) is unchanged from
pre-slice-2 behavior; what changed is that the decision is no longer a
side effect of the `resumed` diagnostics label, and the caller-visible
`onResume` callback firing an abort synchronously is now re-checked
immediately before the recovery spawn (previously it was not, and a
callback-triggered abort could still race a spawn through).
`packages/opencode-adapter/src/errors.ts`'s `mapClassification` now
receives two explicit facts computed once in `turn.ts` —
`recoveryAttempted` and `recoveryBlockedByPolicy` — instead of re-deriving
eligibility itself from `resumed` (the two call sites previously could
disagree in principle, even though in practice `mapClassification`'s own
`resume: true` branch was unreachable from `runTurn`'s call site). Terminal
messages now honestly distinguish: recovery budget exhausted (the one
attempt ran and failed), recovery blocked by the slice-3 policy
restriction, no usable conversation id captured, and the pre-existing
cancellation path (a distinct `AbortError`, never routed through
`mapClassification` at all). Tests: `packages/opencode-adapter/tests/turn.test.ts`
("timeout-recovery PRD slice 2" describe block) and
`packages/opencode-adapter/tests/errors.test.ts` (same). The two
behavior-changing hunks (the message-honesty branches in `errors.ts` and
the onResume abort recheck in `turn.ts`) were each revert-proofed:
reverting the hunk alone made its targeted new test(s) fail, restoring
from a byte-identical backup made them pass again. The recovery-eligibility
gate itself (`canResume` in `turn.ts`) was not independently
revert-proofed this way because, with the slice-3 restriction ON, it is
numerically equivalent to the pre-slice-2 `!result.resumed` check for the
first attempt — its value is architectural (an explicit, testable seam for
slice 3), not a change in today's observable spawn counts.

**Slice 3 — enable verified safe recovery (still blocked, unchanged by
this session):** No concrete, versioned evidence exists in this repository
about what the supported `agy` CLI actually does when `--conversation`
resumes an interrupted turn (continues cleanly, adds a new user turn, or
risks duplicating queued/executed work) for either transport
(`promptViaStdin` true/false). A captured `conversation_id` and a passing
mock test are not such evidence. Producing it is tracked as a separate
`sdd-research` lane, as this PRD already specified. Only after that
evidence exists should `RECOVERY_RESTRICTED_TO_NEW_CONVERSATIONS` in
`packages/opencode-adapter/src/turn.ts` be revisited, together with the
approved recovery payload/transport contract and AC7–AC8.

**Slice 2 addendum — two point fixes (this session, uncommitted):** two
gaps found in the slice-1/slice-2 implementation (independent of the
slice-3 policy question) were closed with minimal, targeted changes:

1. **Cancellation-before-first-spawn race.** `runTurn` awaits
   `deps.store.resolve(...)` and `deps.store.get(...)`
   (`packages/opencode-adapter/src/turn.ts`) before its first
   `attempt()` call; an abort landing during those awaits was not
   re-checked before that first spawn, so the child ran to its own
   natural timeout instead of never starting. `runTurn` now re-checks
   `req.signal?.aborted` synchronously, with no intervening await,
   immediately before the first `attempt()` call. As defense in depth,
   `createTap`'s `spawnImpl` (`packages/opencode-adapter/src/stream-tap.ts`)
   also checks `opts.signal?.aborted` right after spawning — an
   `AbortSignal`'s `"abort"` event never fires retroactively for a
   listener registered on an already-aborted signal — and routes an
   already-stale signal through the same SIGTERM kill path a live abort
   takes, never a synthesized error. This does not change cancellation
   semantics (still `AbortError`), recovery eligibility, or the recovery
   budget.
2. **Diagnostic honesty for missing-id continuations.** `turn.ts`'s
   `recoveryBlockedByPolicy` used to report the slice-3 policy
   restriction for every timed-out ordinary continuation, even one that
   captured no usable conversation id this attempt — masking the more
   specific "no usable conversation id" cause behind the policy wording.
   It now also requires `result.conversationId !== undefined` (the same
   "usable id" test `mapClassification` already applies in
   `packages/opencode-adapter/src/errors.ts`), so the missing-id cause
   wins when there is no id to be restricted from resuming with. This is
   diagnostic-only: it does not change `canResume`, spawn counts, or
   `recoveryBudgetConsumed`.

Neither fix touches `RECOVERY_RESTRICTED_TO_NEW_CONVERSATIONS`, enables
any new automatic recovery path, or changes slice 3's blocked status
above. Tests: `packages/opencode-adapter/tests/turn.test.ts` ("Fix 1" and
"Fix 2" describe blocks) and
`packages/opencode-adapter/tests/stream-tap.test.ts` ("Fix 1" test).

**Revision 2 — option A + ten-session concurrency (this session,
uncommitted):** implemented as work blocks A1–A3 on top of slices 1–2.

- **A1 (engine):** `runAgyStream` now runs a bounded termination chain —
  SIGTERM on any trigger (total cap, stall watchdog, or an external abort
  via the new `signal` option) → finite grace → `SIGKILL` escalation →
  finite final settle deadline → forced settlement flagged
  `SpawnRun.terminationUnconfirmed` with the first trigger, the requested
  signal, the escalation signal, and the observed close signal. Every kill
  is try/catch-wrapped into the attempt log; all four timers plus the abort
  listener are cleared on the settle-once path; late exit/close after
  settlement is ignored. Bounds are internal constants
  (`TERMINATION_GRACE_MS`/`TERMINATION_FINAL_DEADLINE_MS`, 5s each; ~10s
  worst-case added latency per attempt) overridable only by internal test
  seams — no new public configuration. `classifyRun` gained rule 2
  (`termination_unconfirmed`, reasons `termination_unconfirmed_timeout`
  /`_stall`/`_abort`), ordered before stalled/timeout and non-fallback.
- **A2 (adapters + shared lock):** both adapters pass their abort signal
  and the internal seams into `runAgyStream`; both `mapClassification`s
  branch explicitly on `termination_unconfirmed` BEFORE the timeout family
  (retryable false, trigger named, unconfirmed-termination + partial-side-
  effects warning, `Full log:`); explicit tests pin that the replay/recovery
  gates (still `=== "timeout"`) never fire for the new outcome — exactly one
  spawn per call. Pi's shared per-turn `run.log` became per-attempt
  `attempt-N.log` (attempt 2 no longer truncates attempt 1). OpenCode
  diagnostics report escalation honestly (SIGKILL, never a plain SIGTERM).
  A shared `acquireConversationLock` (engine, sha256-keyed O_EXCL lockfile,
  takeover on dead pid or 1h staleness, bounded 3s wait → `ConversationBusyError`)
  is wired into both `runTurn`s when resuming a known conversation,
  released on every exit path; fresh conversations take no lock (each
  request creates its own conversation, so the invariant holds by
  construction). Busy maps to a non-retryable TurnError, zero spawns.
- **A3 (proof):** `tests/ten-session-concurrency.test.ts` (root-level;
  covered by root `bun test`, not by the three package tsconfigs —
  documented limitation): barrier-proven 10 simultaneous executions
  (5 OpenCode + 5 Pi, one shared tmp project dir; arrivals=10, peak=10,
  closes-before-full=0), cancellation/timeout/unconfirmed isolation,
  exclusive untruncated logs, retention protecting active groups, no lost
  store updates, same-process and cross-process (two real child processes,
  stdout-handshake) same-conversation exclusion. Lock revert-proof: a
  no-op hunk makes both busy tests fail; removal restores green.

Session verification (executed on this tree): 851 tests pass / 0 fail
(baseline at session start: 805/0), engine + pi `tsc --noEmit` clean,
opencode `bun x tsc --noEmit` clean. Not yet done: dist rebuild (by
constraint), and the slice-3 CLI resume-safety evidence lane remains
blocked. Post-`termination_unconfirmed` conversation policy: the user
confirmed **warn-and-continue** as the standing behavior — the next
request continues the conversation ordinarily and the terminal message
carries the partial-effects warning; quarantine is a possible separate
future change, not part of Revision 2.
