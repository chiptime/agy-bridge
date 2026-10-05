# PRD: Session-stable conversation continuity with detached cancellation

**Status:** Draft for execution. Supersedes `docs/timeout-recovery-prd.md` (kept for
traceability; see the superseded note there). Baseline: uncommitted working tree on
top of `7005c6d`, which already carries slices 1–2, Revision 2 (bounded termination,
ten-session concurrency), and — uncommitted on top — quarantine, the durable
execution-state store, and Revision 4 (single-spawn, settle-by-evidence).

**One-line intent:** the bridge stops trying to police agy's remote side. It gives
each host session one stable agy conversation, never resends a prompt, and treats
host cancellation as "stop waiting and stop delivering" — the submitted turn keeps
running and stays part of that conversation. Quarantine, durable execution state,
and any SQLite migration are retired.

## 1. Executive outcome

A user cancels a turn in OpenCode or Pi. Within milliseconds the host is free: the
abort is delivered, the UI responds, nothing hangs. The agy turn they cancelled is
not killed — it runs to completion in the background and lands in the same
conversation, so the *next* message they send continues a conversation that
contains everything they ever submitted, cancelled or not. Ten parallel host
sessions each get the same guarantee without interfering. When something fails,
error text says exactly what stopped, what kept running, and where the evidence is
— never promising remote cancellation, exactly-once effects, or duplicate-free
history.

**Who benefits:**

| Audience | What they get |
| --- | --- |
| Host users (OpenCode/Pi) | Cancel is instant; no zombie "waiting for agy" UI; conversation history stays complete |
| The bridge maintainers | ~3,000 lines of kill chains, quarantine, and durable-gate machinery replaced by one detach operation |
| Diagnostics consumers | Per-execution logs that keep recording a cancelled turn until it finishes, with bounded retention |
| agy itself | No more signals it must survive; the CLI process is left alone to do its work |

**Success is behavioral, not internal:** cancel latency ≈ zero, conversation
continuity across cancel/timeout, ten-session isolation, and honest errors —
measurable with fake child processes (§13).

## 2. Problem, evidence, and knowledge limits

### 2.1 What this PRD replaces

The previous PRD family (`timeout-recovery-prd.md`, revisions 1–4) was built
around a fear: a locally terminated agy process leaves the remote outcome unknown,
so the bridge must never replay, must durably block uncertain conversations, and
must quarantine anything it cannot prove safe. That machinery grew to a durable
execution-state authority (1,552 lines), a quarantine marker system, bounded
SIGTERM→SIGKILL termination chains, and evidence-based settle policy.

The user has now decided the trade-off in the opposite direction: **trust agy's
own conversation model.** The turn is submitted exactly once; cancelling the host
side must not kill it; the conversation is the unit of integrity. Under that
contract the quarantine/durable machinery has no job: there is no "unsafe to
continue" state to gate, only "busy" and "free".

### 2.2 Verified facts (do not re-litigate; cite, don't embellish)

| # | Verified observation | Source |
| --- | --- | --- |
| V1 | The original incident ended interrupted, with no response delivered. | Sanitized incident record (prior PRD) |
| V2 | No headless recovery is documented for agy without sending a new prompt: no resume/status/cancel/result retrieval. | User investigation of installed agy 1.2.6 (`--help`, changelog), recorded in project memory |
| V3 | Terminating the local process does not demonstrate the remote work terminated (changelog evidence of turns/background tasks surviving process death). | agy 1.2.4/1.2.6 changelog, user-verified |
| V4 | agy documents a prompt queue inside one interactive session. | agy documentation, user-verified |
| V5 | For the same conversation opened in another instance, agy shows a non-blocking warning and recommends `/fork` to avoid interleaved writes. | agy behavior, user-verified |
| V6 | The stdin stream-json transport (`--input-format stream-json --output-format stream-json`) carries the prompt without any agy-side print-wait deadline; the argv print transport derives `--print-timeout` from the bridge budget and agy's print client defaults to a 5-minute wait when the flag is absent. | Engine `spawn.ts` verified-live annotations; prior PRD evidence table |
| V7 | The `init` stream event yields the conversation id early, before the turn completes. | Engine `spawn.ts`, live-probed 2026-09-09 |

### 2.3 The pending assumption (resolved 2026-10-01 — see below)

The user observed prompt queueing with **one** agy instance. It is **not verified**
that two simultaneous headless processes passing the same `--conversation` queue
safely and in order. V5's warning is about *another instance* touching the same
conversation, which is precisely the two-process shape the bridge would create if
it spawned while a previous detached turn still runs. Until the experiment below
resolves this, the bridge must serialize per conversation (§4.3, §7).

**Resolution (2026-10-01):** the §2.4 experiment ran on the installed agy 1.2.14
and **passed every criterion** — two concurrent headless writers on one
conversation interleaved safely, no lost turn, no corruption, and agy's own
probe answer acknowledged the concurrent completion while keeping ordered
history. Evidence: `docs/agy-queue-experiment/` (summary + raw NDJSON). The
conservative serialization of §4.3/§7 remains the **default** per D3; relaxing
it via explicit config is now evidence-backed for 1.2.14. Single sample —
re-run per version upgrade (§14 risks).

### 2.4 Minimal experiment to resolve the assumption — EXECUTED 2026-10-01: PASS

Authorized and executed 2026-10-01; protocol below retained verbatim for
traceability; results and raw NDJSON in `docs/agy-queue-experiment/`. It was
run without bridge code, no repository files, one throwaway directory.

```sh
# Terminal setup (same machine, same authenticated agy, fresh temp dir)
mkdir -p /tmp/agy-queue-exp && cd /tmp/agy-queue-exp

# Step 1 — create the conversation, capture <ID> from the init event line:
printf '%s\n' '{"event":"user","message":{"role":"user","content":"Remember the codeword MARBLE-VII. Reply with exactly: stored."}}' \
  | agy --input-format stream-json --output-format stream-json \
        --dangerously-skip-permissions --add-dir "$PWD" | tee run0.ndjson

# Step 2 — terminal A: long turn on <ID> (backgrounded):
printf '%s\n' '{"event":"user","message":{"role":"user","content":"Count slowly from 1 to 30, one number per line, then reply done."}}' \
  | agy --input-format stream-json --output-format stream-json \
        --dangerously-skip-permissions --add-dir "$PWD" --conversation <ID> > runA.ndjson &

# Step 3 — terminal B, immediately after A starts: short turn, SAME <ID>:
printf '%s\n' '{"event":"user","message":{"role":"user","content":"Reply with exactly the codeword and nothing else."}}' \
  | agy --input-format stream-json --output-format stream-json \
        --dangerously-skip-permissions --add-dir "$PWD" --conversation <ID> > runB.ndjson

# Step 4 — after both exit, probe conversation state:
printf '%s\n' '{"event":"user","message":{"role":"user","content":"List the last two things I asked you, in order."}}' \
  | agy --input-format stream-json --output-format stream-json \
        --dangerously-skip-permissions --add-dir "$PWD" --conversation <ID> > runC.ndjson
```

**Isolation:** fresh temp dir; prompts demand no file writes and touch no real
repository; a fresh conversation id per experiment run; nothing imports bridge
code.

**Success criteria (all must hold):** A and B both exit 0 with SUCCESS envelopes;
B's response contains the codeword (conversation state not corrupted); timing in
the NDJSON shows either B queued behind A or a safe interleaving with no lost
turn; C's answer reflects both turns in submission order; any warning observed on
stderr is recorded verbatim.

**What this cannot demonstrate:** absence of internal races in agy's conversation
storage (one sample); behavior of other agy versions; cross-machine behavior;
ordering guarantees in general (single observation); the interactive-TUI warning
path (a different code path from headless). A pass authorizes relaxing bridge-side
serialization (§7); it never authorizes automatic resends.

**Cost:** 3–5 agy turns, minutes, zero repo impact.

## 3. Objectives and non-objectives

### 3.1 Objectives (the target contract, user-decided)

1. **Stable session identity.** Each host session (OpenCode session id; Pi
   session key) maps to one durable identity and one agy conversation.
2. **First message** runs agy, captures the `conversation_id` from the `init`
   event, persists the session→conversation link *before* delivering the
   response, and delivers the response.
3. **Subsequent messages** resume the same conversation id via `--conversation`.
4. **Ten independent conversations in parallel** with no cross-interference
   (logs, bindings, cancellation, store writes).
5. **Detached cancellation.** Host cancel stops the waiting and the delivery,
   never the agy work: the submitted turn continues and remains part of that
   conversation.
6. **No automatic resend.** Nothing in the bridge ever re-sends a prompt — not
   after timeout, cancel, or any error.
7. **Retire** quarantine, durable execution state, and the SQLite migration
   idea.

### 3.2 Non-objectives and abandoned guarantees (explicit)

| Abandoned guarantee | Why it is safe to abandon |
| --- | --- |
| Durable blocking of "uncertain" conversations (execution-state store, quarantine markers) | The contract accepts that a cancelled or timed-out turn continues remotely; there is no unsafe-to-continue state to gate, only busy vs free. Blocking added availability cost (wedged records, manual release) with no user-visible benefit under the new contract. |
| Killing the local child on timeout/abort + `termination_unconfirmed` outcome | Killing contradicts contract item 5 and never proved anything remote (V3). The outcome and its chain exist only to make killing safe; remove the killing, remove the chain. |
| Evidence-based durable settle policy (`durableSettleOutcome`) | Existed to decide when a durable record could be freed. No durable records, no policy. |
| SQLite migration | Explicitly out (item 7). State stays JSON-on-disk with atomic rename writes. |
| Exactly-once anything, remote cancel, duplicate-effect prevention | Never existed (V2, V3); the old PRD already refused to promise these. The new contract additionally *accepts* that a user who cancels and manually resends a similar prompt produces two turns in the conversation (§14). |

**Also unchanged (in scope to preserve, not redesign):** divergence detection and
history re-seeding; quota preflight; model discovery; attachment pipeline; the
`Full log: <path>` error convention; per-attempt log exclusivity.

## 4. Host-visible behavior

### 4.1 OpenCode flow

```
User: "fix the bug"            (first message of session S)
  bridge: no stored binding → fresh conversation
  spawn agy (stdin transport) → init event → conversation_id K
  persist S→K (no hashes yet)  ← BEFORE any response delivery
  stream tokens to the panel; result envelope arrives
  persist S→K + baseline hashes; deliver response

User cancels mid-generation (Esc)
  host AbortError returns immediately (≤ one event-loop turn)
  agy child K keeps running; collector keeps writing attempt log
  conversation lock for K held until child exit
  panel shows: "agy turn continues in the background; it will be part of
               the conversation; no response will be delivered for it"

User: "and add tests"          (next message, after the cancelled turn finished)
  resolve S→K; K free → resume with --conversation K
  agy answers with full context of BOTH turns

User: "go on"                  (sent while the cancelled turn STILL runs)
  resolve S→K; K busy → bounded wait (§4.3) → busy error, zero spawns
```

### 4.2 Pi flow

Identical semantics through the pi extension: provider turns cancel to
`TurnAborted` instantly; `AskAgy` thread rows and provider session rows keep the
same conversation binding rules; `/agy status` shows, per session: bound
conversation id, whether a detached turn is still being collected (age, pid, log
path). `/agy clear` unchanged (drops binding; a detached collector finishes
silently — its turn still lands in agy's conversation, which the bridge no longer
references).

### 4.3 Conservative behavior: new message while the conversation is busy

Applies until §2.4's experiment authorizes otherwise (and per decision D3):

1. Resolve the session's conversation id K (first message: no K yet — the
   session key stands in as the lock key until the `init` handover, §7.2).
2. Acquire the turn-hold lock on that key (new wiring over the O_EXCL
   primitive, §7.1; child-aware takeover, §7.3).
3. If a detached/active turn still holds it: wait a bounded interval
   (`CONVERSATION_LOCK_WAIT_MS`, 3s today; no new public config).
4. On expiry: fail fast, zero spawns, non-retryable, honest message:
   *"this agy conversation is still finishing a previous turn (started
   \<age\> ago; log: \<path\>). The bridge never resends prompts automatically.
   Wait and send again, or start a new conversation/session."*
5. Never queue the incoming prompt inside the bridge, never spawn a second
   process on K, never drop the binding.

### 4.4 Transport requirement (real contract tension — stated, not hidden)

Contract item 5 ("the submitted turn continues") holds only while no deadline
cuts the turn on agy's side. In argv print mode, agy's own print client enforces
a response-wait deadline (5m default; today the bridge derives `--print-timeout`
from its budget) and will cut the turn itself (V6). Therefore:

- **Spec:** both adapters use the stdin stream-json transport for provider turns
  by default. OpenCode already defaults to it. Pi's production extension
  **already passes `promptViaStdin: true` in both flows** (provider stream and
  AskAgy, `pi-adapter/extensions/index.ts`); the pending change is the
  pi-adapter **library default** — currently off in `src/turn.ts` and pinned by
  a default-off test — so direct library consumers get the same transport, with
  the pinning test updated. No agy-side print deadline then exists.
- If configuration forces argv mode, the bridge documents and logs that a turn
  may be cut by agy's own print deadline — the "turn continues" clause then holds
  only up to that deadline. This is a documented degradation, not a hidden
  guarantee.

## 5. Minimal state model

**Identity:** the native host key is the identity — OpenCode `sessionId` (plugin
`chat.params` hook or `x-session-id`/`x-session-affinity` headers; stable
per-instance UUID fallback when the host supplies nothing); Pi `sessionId ?? cwd`
(stable per directory; no per-session isolation claimed for a directory key).
The bridge-UUID mapping (`bridgeSessionIds` in both session stores) existed only
to key the engine's durable store and is retired with it (decision D4 covers the
code disposition). The same native key also keys the first-turn lock of §7.2 —
identity, store row, and lock key stay one name.

**Persisted state (all JSON, atomic tmp+rename, owner-only modes):**

| File | Content | Written when |
| --- | --- | --- |
| `~/.local/state/agy-bridge/opencode-sessions.json` | session → {conversationId, hashes?} | init capture; after success |
| `~/.local/state/agy-bridge/pi-sessions.json` | same, pi keys (+ `:ask` thread rows) | same |
| `conversation-locks/<sha256(id)>.lock` | {holderPid, childPid?, acquiredAt, token} — child pid recorded at spawn (§7.3); key = session key until `init`, conversation id after (§7.2) | per in-flight turn |

**Persistence timing and failure semantics:**

- The session→conversation link is persisted **at `init` capture, before any
  response is delivered** (contract item 2). This uses the existing durable-fs
  write (fsync-backed) kept per decision in §11.
- Link-write failure on a **first** message: retry once; on second failure the
  turn fails without delivering — the response text is preserved in the attempt
  log and the error names the log path and says continuity could not be
  recorded. (Delivering anyway would silently break item 3 on the next message.)
- Link-write failure on a **subsequent** message (re-bind after success, hash
  baseline update): deliver the response, warn in diagnostics; the older binding
  still points at the same conversation, so continuity survives with a stale
  hash baseline (divergion detection degrades honestly, one turn).
- Store write failures never spawn a retry of the prompt (item 6) and never
  block other sessions (per-key failure isolation is preserved).

## 6. Detached cancellation semantics

### 6.1 What stops, what continues

| Thing | On host cancel |
| --- | --- |
| Host-visible wait | Stops immediately — `AbortError` (OpenCode) / `TurnAborted` (Pi) within one tick |
| Response delivery | Cancelled; even if the envelope arrives later it is logged, never delivered |
| agy child process | **Continues** — no signal is sent, ever |
| Conversation lock | Held until observed child exit (collector), then released |
| Session→conversation binding | Already persisted at init; unchanged |
| Attempt log | Continues to be written by the collector until child exit |
| Bridge's own wait limit (timeout) | Decision D1 (§14) — recommended: same detach, error says "stopped waiting", turn continues |

### 6.2 Per-turn state machine

```
            spawn (stdin transport)
 idle ─────────────────────────────► running
                                          │
        init event: persist S→K           │ envelope delivered        cancel/timeout-wait-limit
        (before any delivery)             │ (SUCCESS, non-empty)      (D1: detach)
                                          ▼                              │
                                     delivered ◄──────────────┐          ▼
                                          │                   │      detached
                                    persist hashes             │          │
                                          ▼                   │          │ (collector keeps draining;
                                       terminal                          │  no delivery, lock held)
                                                                          │
                                                          child exit ────┘
                                                          (collector observes;
                                                           release lock; log final
                                                           envelope as diagnostic)
```

- `detached` is entered at most once per turn; the host error is emitted at
  entry, not at child exit.
- A `detached` turn's late envelope is recorded in the attempt log and in the
  call summary (`lateResult: delivered-after-detach`) — never delivered to the
  host, never treated as success for hash baselines.
- Failed spawns (ENOENT, pre-work refusals) and typed terminal failures behave
  exactly as today (no kill machinery was involved).
- What is logged at detach: trigger (cancel | wait-limit | stall-wait-limit),
  child pid, conversation id, attempt log path, timestamp. What is shown to the
  user: the honest one-liner from §4.1.

### 6.3 Orphaned processes (host closes while agy lives) — decision D2

While the bridge process lives, the collector keeps the child's stdout pipe
healthy and the log complete. If the host process itself dies, the pipe's read
end closes and the child's fate on its next stdout write is SIGPIPE/EPIPE —
agy's behavior there is **unknown and unverifiable from the bridge** (V2). The
left-behind lock is arbitrated by the child-aware takeover of §7.3 on the next
turn: a recorded, live child keeps the conversation busy (no second writer);
an indeterminate record never authorizes one. Options and recommendation:
§14, D2.

## 7. Concurrency model

- **Unit of isolation: the conversation.** Ten host sessions → ten conversations
  → ten independent spawns, logs, bindings, cancellations. No global lock; the
  only serialized thing is *two requests on the same conversation id* (§4.3).
- Cross-process exclusion is built on the existing O_EXCL lockfile primitive
  (exclusive create, token release) — but the way this contract uses it is
  **new wiring, not reuse** (§7.1), with a child-aware payload and takeover
  rules (§7.2–7.3). This remains the conservative serialization §2.3 requires,
  regardless of the experiment's outcome, for the crashed-bridge case too.
- Lock lifetime: held from just before spawn until **observed child exit**
  (via the collector), not until host-visible settlement. A cancelled turn
  therefore keeps its conversation honestly busy.
- Store writes stay atomic per file (tmp+rename) under the session-store lock;
  ten sessions writing ten distinct keys never lose updates (existing pattern,
  existing tests).
- After §2.4 authorizes relaxing serialization (D3), concurrent same-conversation
  spawns may be *enabled by explicit config*, defaulting off; the busy error
  remains the default behavior otherwise.

### 7.1 Turn serialization is new wiring

Today `conversation-lock.ts` is consumed only by `execution-state.ts`, which
holds locks for short read-modify-write critical sections around record reads
and writes — never across a spawn. No lock held from spawn to child exit exists
anywhere in the bridge. The serialization this contract requires is therefore
new wiring over the same primitive: a lock **acquired before the spawn call and
released when the collector observes child exit**, with a payload and takeover
rules extended for that lifetime (§7.3). Nothing in this PRD assumes that
wiring already exists.

### 7.2 First turn: lock key before the conversation id exists

The problem: the lock must be held *before* spawn, but on a first message the
conversation id K only arrives at the `init` event — after the child is already
running.

**Chosen design — session key first, ordered handover.** The stable session
identity of §5 is resolved *before* any spawn today (OpenCode resolves the
session id in `language-model.ts` before calling `runTurn`; Pi resolves
`sessionKey(sessionId ?? cwd)` at the top of its turn flow), and — once D4
retires `bridgeSessionIds` — it is the same native key that keys the
session-store binding row. That key names the first turn's lock:

1. Acquire `lock(sessionKey)` before spawning.
2. Spawn; write the child pid into the lock payload as soon as the engine
   exposes it (§7.3 — today the `onSpawned` seam passes no child identity, so
   the spawn seam must expose the child pid first; phase 4).
3. At `init` capture (K known): acquire `lock(conversation:K)` **while still
   holding** `lock(sessionKey)`, then release the session lock. Pi `:ask`
   thread rows key their first turns identically, on the thread's store key.

**Invariant — never two possible writers.** From just before spawn until child
exit there is exactly one held lock whose key names the conversation — the
session key while that is the conversation's only name, the conversation key
afterwards — and the handover overlaps the two holds, so no other request can
acquire either name in between. A second request from the same session blocks
on the session lock; no other session can name K before it exists; after the
handover every request blocks on the conversation lock.

**Deadlock-freedom:** session → conversation is the only acquisition order in
the system. Subsequent turns acquire only a conversation lock and never take a
session lock while holding one, so no cycle can form.

**Crash windows** are covered by the payload, not by the key: whichever lock
is held at crash time carries the child pid, and takeover consults the child,
not the holder alone (§7.3). A crash before the handover leaves a
session-keyed lock; a crash after it leaves a conversation-keyed one; both
arbitrate identically.

*Rejected alternative:* keep the session key for the whole turn lifetime (no
handover). Simpler, but it misreports busy-state for the only unit this
contract cares about (the conversation), produces wrong busy naming whenever a
conversation is re-bound or shared across sessions, and diverges from "one
conversation, one active writer" (V5). The handover is one ordered
acquire/release pair; the cost is small.

### 7.3 Child-aware takeover

Today's lock file records `{ pid: process.pid }` — the acquiring bridge's own
pid — and takeover decides on that pid alone: a provably dead holder may be
replaced. That is insufficient for turn-held locks: if the bridge dies, its
agy child can survive (V3), the lock looks stale, and a naive takeover would
launch a second writer onto a live conversation.

**Payload:** `{ holderPid, childPid?, acquiredAt, token }`. `childPid` is
written as soon as the child exists; before that the record has no child pid.

**Takeover rules, checked in order:**

| Recorded state | Decision |
| --- | --- |
| holder alive | Never steal (unchanged) |
| holder dead, `childPid` recorded, child probe says alive | **Refuse takeover** — busy error names the orphan child (pid, age, log path); documented manual escape hatch |
| holder dead, `childPid` recorded, child provably gone (ESRCH) | Take over; diagnostics note the takeover and that the remote outcome is unknown (V3) |
| holder dead, no `childPid` recorded | **Indeterminate** — the holder may have died between acquiring the lock and recording the child. No automatic takeover; honest error says the record predates a verifiable child and points to the documented manual resolution |

**What a pid probe proves — and does not prove:** `kill(pid, 0)` demonstrates
only that a *local* process with that pid exists (or not). It never
demonstrates the state of agy's remote work (V3), and a recycled pid reads as
"alive" — which only makes these rules more conservative. Every takeover
notice and busy message keeps "local process ended" and "remote work ended"
as distinct claims (§8).

## 8. Error taxonomy and honest messages

| Situation | Outcome class | User-facing message must say |
| --- | --- | --- |
| Conversation busy (detached/active turn) | `conversation_busy` (non-retryable) | who holds it (turn started \<age\> ago), that the bridge never auto-resends, the log path, and the two exits: wait and resend manually, or start a new conversation |
| Busy via orphaned child (holder dead, child alive — §7.3) | `conversation_busy` (non-retryable) | the holder died but its agy child (pid) is still running; takeover refused; log path; documented manual escape hatch |
| Lock indeterminate (holder dead, no child pid — §7.3) | `conversation_busy` (non-retryable) | the record predates a verifiable child; the bridge will not guess; documented manual resolution |
| Bridge wait limit reached (D1: detach) | `wait_limit_reached` | the bridge stopped waiting; the turn continues in the conversation; no response will be delivered; log path |
| Cancelled by host | host abort contract (`AbortError`/`TurnAborted`) | cancel acknowledged; turn continues in background; it will be part of the conversation; log path |
| Link persist failed (first message) | `binding_unpersistable` | continuity could not be recorded; response withheld; response text is in the log; retry manually |
| Timeout-family signatures from agy itself (print-wait cut in argv mode) | `timeout` (as today) | agy's own deadline cut the turn (argv mode only; see §4.4); log path |
| Typed failures (auth, quota, transient, task) | unchanged taxonomy | unchanged wording + `Full log:` convention |

**Never claimed, anywhere:** that cancel stops agy; that a delivered cancel means
the turn did not happen; that effects are exactly-once; that a resent prompt will
not duplicate a cancelled turn's work. "The local process ended" and "the remote
work ended" remain distinct sentences in every message and log field.

`termination_unconfirmed` and the five execution-state gate errors
(`ConversationBlockedError`, `ConversationStateUnverifiableError`,
`SessionUnresolvedExecutionError`, `ExecutionStateUnwritableError`, and the
durable flavor of `ConversationBusyError`) are removed with their sources; the
lock's own `ConversationBusyError`/`ConversationLockUnavailableError` survive.

## 9. Logs and diagnostics

Keep the slice-1 diagnostics architecture wholesale; simplify its
recovery-era fields:

- **Keep:** collision-resistant call identity (`generateCallId`) + attempt index;
  exclusive per-attempt logs (0o600); call summary with `Full log:` pointer;
  three-tier bounded retention (age/count/byte limits, active groups protected,
  no symlink following); privacy rules (no prompts, no env, no credentials, no
  raw session content in filenames; conversation/session ids excluded from
  filenames).
- **Simplify:** drop `AttemptMode` (`initial`/`recovery`) and
  `RecoveryDisposition` from the summary schema (single attempt per call now);
  keep parsing tolerance for old summary files that still carry the fields.
- **Add:** detach events (trigger, pid, conversation id, log path), collector
  completion events (child exit code, elapsed, whether a late envelope arrived),
  and the busy-wait expiry event. These ride the existing allowlisted record —
  no new sensitive fields.
- Pi keeps its per-attempt `attempt-N.log` naming; OpenCode keeps call-group
  directories. Retention bounds unchanged; a collector's log is an active group
  until child exit, so pruning cannot delete a running detached turn's log.

## 10. Retirement plan: quarantine and durable execution state

1. **Unwire (phases 1a–2):** remove every `beginExecution`, `confirmSpawned`,
   `bindConversation`, `settleExecution`, and `releaseConversation` call from
   both adapters' sources and tests. `importLegacyQuarantineMarker` has **no
   adapter-source call sites today** — it is defined in `execution-state.ts`
   and called only from engine and adapter *tests*; those test call sites are
   removed here, and the definition dies with its module in phase 3. Adapters
   stop using the `onSpawned` seam (it existed for `confirmSpawned`); the seam
   itself is engine code — phase 4 first exposes the child pid through the
   spawn surface (§7.2) and then removes it. Delete the five gate-error
   mappings (§8); stop minting bridge UUIDs
   (`bridgeSessionId`/`bridgeSessionIds`) in both session stores.
2. **Delete (phase 3):** `packages/engine/src/execution-state.ts`,
   `packages/engine/src/conversation-quarantine.ts`,
   `packages/engine/tests/execution-state.test.ts`,
   `packages/engine/tests/conversation-quarantine.test.ts`, and their
   `index.ts` exports. (The durable-state/quarantine blocks of
   `tests/ten-session-concurrency.test.ts` are already gone by then — removed
   mechanically in phase 1b, §12.) Code disposition (delete vs archive
   branch vs partial keep) is decision D4; the phase executes whichever is
   chosen.
3. **Local state cleanup (one manual step, documented in troubleshooting and the
   changelog):** after all bridge instances run the new build, remove the state
   that development versions wrote:
   - `~/.local/state/agy-bridge/execution-store/` (whole tree: `sessions/`,
     `conversations/`, `locks/`)
   - `~/.local/state/agy-bridge/conversation-quarantine/` (whole tree)
   - `bridgeSessionIds` maps inside `opencode-sessions.json` /
     `pi-sessions.json` (harmless if left; new builds ignore them)
   - `conversation-locks/` is NOT removed — the mechanism survives (§7).
    Cleanup order matters: an older build still running can recreate
    execution-store records; clean up only after every instance has restarted on
    the new build (mirrors the old two-version coexistence note).
    This step is **manual and never automated**: no build, install, or startup
    path deletes state; it is executed by hand once the restart precondition
    holds, outside any PR (§12, phase 7).
4. **Docs:** `docs/troubleshooting.md` quarantine/quarantine-release sections
   are rewritten to the busy/wait guidance of §4.3; CHANGELOG gains a
   **Removed** section; this PRD supersedes `timeout-recovery-prd.md`.

## 11. Code inventory: keep / simplify / retire

Baseline: uncommitted work on `7005c6d`. Every piece named with its
responsibility; no blind deletions.

### Keep (sustains the target contract)

| File | Responsibility kept |
| --- | --- |
| `packages/engine/src/spawn.ts` — spawn/argv/stdin runner, stall watchdog concept, `init` capture | Still the single runner; conversation id capture is contract item 2. The `onSpawned` seam exists today but passes no child identity — phase 4 exposes the child pid (for the §7.3 lock payload), then removes the seam |
| `packages/engine/src/conversation-lock.ts` (288 lines, modified) | The O_EXCL/token-release primitive. Today consumed only by `execution-state.ts` short critical sections; this PRD adds the new turn-hold wiring (spawn → observed child exit, §7.1), the child-pid payload, and child-aware takeover (§7.3) |
| `packages/opencode-adapter/src/diagnostics.ts` + tests | Per-call identity, exclusive attempt logs, summaries, retention, privacy (§9) |
| `packages/opencode-adapter/src/session-store.ts` / `packages/pi-adapter/src/session-store.ts` — binding rows, atomic writes, prune | Contract items 1–3; keep durable-fs writes for the link-before-deliver guarantee (§5) |
| `packages/engine/src/durable-fs.ts` (96 lines) | fsync-backed atomic writes, now used only by the two session stores; small, tested, keeps item 2 crash-safe. (Alternative: retire with the store — folded into D4.) |
| `packages/opencode-adapter/src/language-model.ts` — stable per-instance fallback session id | Honest identity when the host supplies none (Rev 4 fix; keep) |
| `packages/pi-adapter/src/turn.ts` per-attempt logs, both adapters' divergence/re-seed, quota preflight, model discovery, attachments | Untouched by this contract change |
| `tests/ten-session-concurrency.test.ts` (1451 lines) | The ten-session proof (§7) — keep with simplifications below |

### Simplify (useful, but built for the abandoned guarantees)

| File | Today | Becomes |
| --- | --- | --- |
| `packages/engine/src/spawn.ts` — bounded termination chain (SIGTERM→grace→SIGKILL→final settle), `terminationUnconfirmed`/trigger/signal fields, `onSpawned` seam, `terminationGraceMs`/`terminationSettleMs` seams | kill-oriented cancel | Detach: on abort/wait-limit, resolve immediately, hand the child to the collector, send no signal; remove chain + seam + fields; stall watchdog becomes a wait-limit trigger (stops waiting early), never a killer |
| `packages/engine/src/outcomes.ts` — rule 2 `termination_unconfirmed`; `durableSettleOutcome`/`deliveredTerminalResult`/`DurableSettleDecision` (110 lines) | classification + durable settle policy | Keep the 12-rule classification minus rule 2; delete the durable-settle section entirely |
| `packages/opencode-adapter/src/turn.ts` (772 lines) — durable gate wiring (`beginExecution`…`settleOnce`), five gate-error mappings, `bridgeSessionId` plumbing | ~250 lines of gate bookkeeping around one spawn | Orchestration = quota → workdir → session lookup → lock → single spawn → bind/persist → deliver; busy handling per §4.3 |
| `packages/pi-adapter/src/turn.ts` (931 lines) | same wiring | same reduction |
| Both `errors.ts` | gate-error + termination_unconfirmed branches | busy/wait-limit/binding messages of §8 |
| Both `session-store.ts` — `bridgeSessionIds` map + UUID minting/validation | engine key mapping | Retired mapping; rows and durable writes stay |
| `packages/opencode-adapter/src/language-model.ts` — `bridgeSessionId` lookup | feeds gate | Deleted (native key remains the store key) |
| `packages/pi-adapter/src/stream-simple.ts`, `ask-tool.ts` — gate/`bridgeSessionId` pass-through | feeds gate | Removed pass-through; library `promptViaStdin` default flips to true (the production extension already passed it; §4.4), pinning test updated |
| `tests/ten-session-concurrency.test.ts` — durable imports (lines 74–82), execution-store reads (745–767, 1117–1180, 1427–1443), cross-process `beginExecution` probe (1176–1253), `bridgeSessionId` plumbing (396, 932–934, 1131, 1340, 1388, 1424), scenario 13b (1263–1400), scenario 14 (1402–1450) | proves durable gates | Keep the overlap/isolation/log/store matrix (verified inventory below); delete gate assertions mechanically in phase 1b; successor busy/detach suites land in phases 4–5 |

### Retire (existed only for abandoned guarantees)

| File | Why it must go |
| --- | --- |
| `packages/engine/src/execution-state.ts` (1552 lines, untracked) | The durable safety authority itself — contract item 7 |
| `packages/engine/src/conversation-quarantine.ts` (76 lines, untracked) | Legacy-marker compatibility for the quarantine gate |
| `packages/engine/tests/execution-state.test.ts` (1284 lines, 36 tests, untracked) | Tests a deleted module |
| `packages/engine/tests/conversation-quarantine.test.ts` (120 lines, untracked) | Tests a deleted module |
| Engine termination-chain tests inside `agy-engine.test.ts` | Kill-chain behavior no longer exists; replaced by detach tests |
| Adapter turn-test blocks covering gate errors, quarantine, settle-once | Sources deleted; replaced by busy/detach tests |

**Root-test inventory (`tests/ten-session-concurrency.test.ts`, line numbers
verified against the current working tree):**

| Concern | Current lines | Disposition |
| --- | --- | --- |
| Durable imports from the engine index | 74–82 — `beginExecution` (76), `ConversationBlockedError` (78), `inspectConversation` (79), `releaseConversation` (81); `ConversationBusyError` (77) survives via the lock module | Remove durable names in phase 1b; keep `acquireConversationLock`/`ConversationBusyError` where still used |
| `bridgeSessionId` plumbing | 396 (`ocRequest`), 932–934 (scenario 8 pair), 1131, 1340, 1388 (13b), 1424 (14) | Remove; re-key store assertions to native session keys |
| Execution-store reads | 745–767, 1117–1180, 1427–1443 | Delete with the store |
| Cross-process `beginExecution` probe | 1176–1253 | Delete; cross-process exclusion keeps its proof through the conversation-lock suite |
| Scenario 13b — cross-adapter durable exclusion | 1263–1400 | Delete in phase 1b; successor: busy serialization through the turn-hold lock (§7, phases 4–5) |
| Scenario 14 — durable settle of an aborted record | 1402–1450 | Delete in phase 1b; **no successor by design** — durable records no longer exist; host-level cancellation isolation stays (scenario 2) |
| Keep: concurrency peak | 549–556 | Unchanged |
| Keep: cancellation isolation (host-level) | 625–675 | Unchanged |
| Keep: exclusive logs / retention | 566–603 | Unchanged |
| Keep: session-store assertions | 605–620, 1111–1163 | Re-keyed from bridge UUIDs to native keys |

**Tests that must survive (adapted):** conversation-lock tests (11) with
release-on-child-exit updates; ten-session matrix (trimmed); all divergence,
quota, attachment, discovery, diagnostics-retention, and session-store suites;
new detach/collector/busy suites (§13).

## 12. Phase plan (execution-ready)

Each phase is one reviewable PR ≤400 changed lines unless flagged; phases land
in order; every phase ends green (`bun test` at root + `tsc --noEmit` in the
three packages). Phase 0 runs out-of-band whenever authorized and only feeds
decisions D3/D5. Phase 1 splits into **1a** (adapter source) and **1b** (the
root concurrency test) so each unit stays reviewable under the budget; phase 1
is not complete until the root suite is green.

**De-gating grep set (used by phases 1a, 1b, 2, 3; scope per phase below):**
`beginExecution`, `settleExecution`, `confirmSpawned`, `bindConversation`,
`releaseConversation`, `importLegacyQuarantineMarker`, `onSpawned`,
`durableSettleOutcome`, `deliveredTerminalResult`, `DurableSettleDecision`,
`bridgeSessionId`, `termination_unconfirmed`, `ConversationBlockedError`,
`ConversationStateUnverifiableError`, `SessionUnresolvedExecutionError`,
`ExecutionStateUnwritableError`. `ConversationBusyError` is **not** in the set:
it survives as the lock's own error. Absence is only ever required within the
phase's exact directories — never repo-wide — because the engine keeps
exporting most of these until phase 3 and the docs keep historical mentions.

| Phase | Scope | Acceptance criteria (verifiable) | Depends on |
| --- | --- | --- | --- |
| **0. Evidence** (no code) — **DONE 2026-10-01: PASS** | Run §2.4 experiment after explicit authorization; record results + raw NDJSON under `docs/` | Evidence doc exists with pass/fail per criterion and verbatim stderr; decisions D3/D5 updated — satisfied by `docs/agy-queue-experiment/` (§2.3 resolution note) | user authorization only |
| **1a. Unwire OpenCode source** | Remove gate calls + gate-error mappings + bridge-UUID minting from `opencode-adapter` **src**; de-gate its unit tests (incl. the `importLegacyQuarantineMarker` test block) | De-gating grep set clean in `packages/opencode-adapter/src` **and** `packages/opencode-adapter/tests`; adapter unit suite green; spawn counts per call unchanged (1) in all existing tests | — |
| **1b. De-gate root test** | `tests/ten-session-concurrency.test.ts`: drop durable imports (74–82 per §11 inventory), remove `bridgeSessionId` plumbing (396, 932–934, 1131, 1340, 1388, 1424), re-key store assertions to native keys, delete scenarios 13b and 14; keep scenarios 1/2/5/7/12 | Root suite green; de-gating grep set clean under `tests/`; kept scenarios still assert peak=10, isolation, exclusive logs, store writes | 1a |
| **2. Unwire Pi** | Same for `pi-adapter` (turn, errors, session-store, stream-simple, ask-tool) + flip the **library** `promptViaStdin` default to true (production extension already passes it; §4.4) and update the default-pinning test | De-gating grep set clean in `packages/pi-adapter/src` and `packages/pi-adapter/tests`; pi provider turns use stdin transport via the library default (argv assertion updated); suite green | 1a, 1b |
| **3. Delete engine modules** | Delete `execution-state.ts`, `conversation-quarantine.ts`, their tests, index exports; **executes the D4-chosen disposition — D4 blocks this phase only** (phases 1a–2 are mechanical and identical under every D4 option). `durable-fs.ts` is **not** deleted (both session stores import it). *Flag: ~3,000 deleted lines — pure deletion, propose `size:exception` or accept as reviewable deletion PR* | De-gating grep set clean repo-wide excluding `docs/` and the D4 archive location (if any); engine exports compile; ten-session matrix still proves overlap=10, isolation, logs, store | 2 |
| **4. Engine detach + turn-hold lock** | `spawn.ts`: abort signal + wait limits resolve the run immediately (`detached` result), collector option keeps draining to the log until child exit, no signals sent; remove kill chain, `terminationUnconfirmed` fields, `onSpawned`; outcomes: drop rule 2 + durable-settle section; expose the child pid on the spawn surface; **turn-hold lock wiring (§7.1–7.3)**: payload `{holderPid, childPid?}`, session→conversation handover primitive, child-aware takeover rules | New tests: cancel resolves <50ms while fake child still runs; collector completes log at child exit; late envelope logged not delivered; lock held till exit; **handover: no instant in the first-turn window where a second writer can acquire either lock name (§7.2 invariant)**; **takeover with fake processes: holder dead + recorded child alive → refused busy; holder dead + recorded child dead → takeover; no child pid → indeterminate, conservative, honest message (§7.3)**; **no-replay: after detach, zero further spawns for that call**; zero `child.kill` calls anywhere in engine; D1 decided before the wait-limit half lands | 3 |
| **5. Adapter cancel flows** | Map `detached` to host abort contracts with §8 messages; wire §7.2 (session-key lock on first turn, handover at init) and §7.3 busy errors in both adapters; persist link at init (§5 failure semantics); busy bounded-wait behavior (§4.3); diagnostics simplify + detach events | Both adapters: cancel-instant tests; busy fail-fast test (zero spawns, message names age+log; orphan-child and indeterminate variants per §8); **conversation_id persisted before the first response is delivered (ordering assertion)**; **first-message persist failure withholds the response — never presented as confirmed continuity**; **cancel never yields a late delivery to the original host (envelope logged only)**; **cancel-then-reinvoke produces exactly one spawn for the new call; no compatibility path re-introduces an automatic second attempt**; old summary files still parse | 4 |
| **6. Orphan handling** (D2) | Implement the chosen option (recommended: in-bridge collector + documented pipe-break limit + `/agy status` detached-turn display; no helper process) | Simulated host-death test (child harness killed): while the orphaned fake child lives, the next turn gets the honest busy error — **no takeover**; after child exit, the next turn takes over and proceeds; logs document the limit | 4, 5 |
| **7. Activation** | Rebuild `opencode-adapter` dist; version bumps (§15); CHANGELOG Removed/Changed entries; troubleshooting rewrite; local-state cleanup documentation (§10.3) | Active docs (README, troubleshooting, changelog) contain no quarantine/release guidance — only the superseded PRD may retain historical mentions; dist contains detach behavior; versions consistent; changelog complete; **§10.3 documented as a manual, post-restart, post-PR procedure — no automated state deletion exists in any build/install path (verified by inspection), and "local state cleaned" is explicitly NOT an automated acceptance of this phase** | 1a–6 |

**Rollback:** every phase is independently revertible; reverts never delete
already-written logs or change their format.

## 13. Test plan

**With fake child processes (deterministic, no real agy) — proves bridge
behavior only:**

- Detach: cancel resolves immediately while the fake child keeps running; no
  signal is ever sent (assert zero `kill` invocations via the spawn seam);
  collector drains stdout to the attempt log until the fake child exits; late
  envelope recorded, not delivered; hash baseline not updated for a detached
  turn.
- Busy: second request on a conversation whose holder is alive fails within the
  bounded wait with zero spawns and the honest message.
- Turn serialization and handover (§7.2): the first turn locks the session key
  before spawn; at `init` the conversation lock is acquired before the session
  lock is released; a probe request at every instant of that window finds
  exactly one of the two names held — no two-writer window; a second request
  from the same session during its own first turn waits, zero spawns.
- Child-aware takeover (§7.3), with fake holder/child processes: holder dead +
  recorded child alive → takeover refused, busy error names the child; holder
  dead + recorded child dead → takeover proceeds with the honest takeover
  notice; holder dead + no child pid recorded → indeterminate: conservative
  refusal with the manual-resolution message. These prove **local arbitration
  only** — no claim about remote work state (V3).
- No-replay invariants: after a cancel-detach and after a wait-limit detach,
  zero additional spawns occur for that call; a cancel followed by a new
  invocation produces exactly one spawn for the new call; no compatibility
  path re-introduces an automatic second attempt (spawn-count assertions via
  the spawn seam).
- Concurrency: the ten-session matrix (barrier-proven peak=10; per-session
  responses/bindings; one cancellation affects only its session; exclusive
  untruncated logs; retention protects active groups; no lost store updates).
- State model: link persisted at init before delivery (ordering assertion);
  first-message persist failure withholds delivery after one retry; subsequent
  failure warns and delivers; a late envelope after cancel is logged and never
  delivered to the original host.
- Regression: divergence/re-seed, quota, attachments, discovery, retention/
  privacy suites unchanged.

**Requiring real agy (separately authorized, never in CI):** `init` conversation
id arrival on both transports; a cancelled turn demonstrably lands in the
conversation (cancel, wait for collector completion, resume asking "what was the
last thing you did" — the answer must reference the cancelled turn); a
cancel-then-reinvoke sequence adds exactly one new turn to the conversation
(the bridge did not duplicate the submission — the remote half of the no-replay
invariant; fake-child tests above prove only the bridge side); §2.4's
experiment.

**Unprovable by the bridge, stated as limits:** that cancel stops remote work
(it does not — by design); exactly-once effects; absence of duplicate history
when a user manually resends; agy-internal race freedom; behavior of agy
versions other than the installed one; child fate after host-process death
(§6.3).

## 14. Risks, accepted consequences, and open decisions

**Accepted consequences (by contract, not accidents):**

- A user who cancels and manually resends a similar prompt produces two turns in
  the conversation (the cancelled one completes too). The bridge will not hide
  this; the cancel message says the turn continues.
- A detached but forgotten turn consumes one agy slot/lock until it exits;
  diagnostics surface it (`/agy status`, busy errors carry its age and log).
- Retiring durable gates means a bridge crash mid-turn no longer blocks the
  conversation afterwards — the next turn resumes on trust that agy's
  conversation model is consistent (the experiment's subject). The old safety
  net is gone by decision, not by omission.

**Risks:** agy version drift changes queueing/warning behavior (mitigation: §2.4
re-run per upgrade, documented); orphaned children accumulate resource usage
after host crashes (D2 options bound this); argv-mode users unknowingly keep
agy-side turn deadlines (mitigation: §4.4 default switch + log note).

**Open decisions — D1, D2, D4, D5 DECIDED 2026-10-01 (option (a) each, user
decision); D3 default stands. Options retained for traceability:**

- **D1 — Bridge wait-limit expiry** (timeoutMs / stall watchdog fire), now that
  cancel does not kill — **DECIDED 2026-10-01: (a)**:
  - (a) *Detach identically to cancel* (recommended): one code path, contract
    symmetry, no kill machinery; a hung turn is the user's manual problem and
    the docs say so (kill command with the honest "local death ≠ remote end"
    caveat).
  - (b) Keep a much larger last-resort kill cap: bounds runaway children,
    reintroduces the unconfirmed-termination mess we are retiring, needs part of
    the kill chain kept.
  - Consequence of (a): indefinite agy runs are possible; visible in status;
    manual escape hatch documented.
- **D2 — Host closes with an agy child alive** (orphans, consumption, output
  collection, open logs) — **DECIDED 2026-10-01: (a)**:
  - (a) *In-bridge collector while alive; accept and document the pipe-break
    limit on host death* (recommended): no extra processes; logs complete
    whenever the bridge lived; honest unknown afterwards.
  - (b) Detached helper process owning the log fd: survives host death,
    completes logs; adds a second process shape to install, debug, and clean up.
  - (c) stdio-to-file for detached turns: crash-safe logging without helpers,
    but loses live token streaming for those turns and changes the log layout.
- **D3 — Per-conversation serialization** after the §2.4 experiment —
  **default stands (keep); the 2026-10-01 pass makes the config-gated
  relaxation evidence-backed if ever requested**:
  - Keep it (recommended default even on a pass — it matches "one conversation,
    one active writer" and V5's own `/fork` advice); enable concurrent
    same-conversation spawns only by explicit config if the experiment passes;
    drop the wait entirely only with sustained evidence.
- **D4 — Disposition of the written durable-state code** (1,552 + tests ≈ 3,000
  lines of verified work). **D4 blocks phase 3 only.** Phases 1a, 1b, and 2 are
  mechanical unwiring that execute identically under every option, and phase 1
  never waits on this decision. **DECIDED 2026-10-01: (a) archive then
  delete**:
  - (a) *Archive on a branch (`archive/durable-execution-state`), delete from
    main* (recommended): commit the work to that branch, then remove it from
    main — preserves recoverable history for a future that might want durable
    semantics again, and keeps main honest about what ships.
  - (b) *Delete outright, no archive branch*: cleanest tree — and an honest
    loss. The work is uncommitted and largely untracked, so it has never
    entered git's object store: deleted without a commit it is **not reliably
    recoverable** (untracked files have no reflog entry; filesystem-level
    recovery is best-effort and expires). Choosing (b) means accepting that
    loss permanently.
  - (c) *Keep partially compiled-out*: dead code with drift risk; not
    recommended.
  - Sub-decision inside D4: `durable-fs.ts` stays (both session stores import
    it, §11) regardless of the option; only the execution-state/quarantine
    modules are in scope.
- **D5 — Protection for a conversation left in unknown state** (e.g. bridge
  crashed mid-turn) without reintroducing quarantine — **DECIDED 2026-10-01:
  (a)**:
  - (a) *Child-aware lock takeover + honest notice* (recommended, §7.3): the
    next turn takes over only when the recorded holder is dead **and** the
    recorded child is gone; a live orphan child keeps the conversation busy
    with an honest error; an indeterminate record never authorizes a second
    writer. Takeover proceeds on trust in agy's conversation model — the
    notice says the local processes ended, never that the remote work did
    (V3). Bridge death alone proves nothing about the child.
  - (b) Warn-only on takeover with no additional marker (weakest).
  - (c) Fresh-conversation fallback with re-seed on takeover: safest continuity,
    abandons the conversation id silently — contradicts item 3 unless announced.

## 15. Activation

1. **Decisions first:** D1, D2, D4, D5 decided 2026-10-01 (all option (a));
   D3 keeps its recommended default (§14). Phase 0's evidence is in
   (`docs/agy-queue-experiment/`). No decision blocks phases 1a–2; D1 gates
   phase 4's wait-limit half; D2 gates phase 6; D4's chosen disposition gates
   phase 3's shape (archive branch first, then delete from main).
2. **Rebuild** `packages/opencode-adapter` dist (source was ahead of dist since
   the quarantine work; the pi package ships source — nothing to rebuild).
3. **Restart every bridge instance** (OpenCode plugin hosts, pi sessions) onto
   the new build *before* the §10.3 local-state cleanup, so no old build
   recreates retired state.
4. **Versioning:** `agy-bridge-opencode` and `agy-bridge-pi` bump their minor
   (0.x line: minor signals breaking) — behavior changes (cancel no longer
   kills; pi **library** `promptViaStdin` default — the production extension
   already used stdin) and public API removals (engine
   execution-state/quarantine exports) are user-visible.
5. **Changelog:** **Removed** (execution-state, quarantine, termination chain,
   `termination_unconfirmed`, bridge-UUID mapping), **Changed** (cancel/timeout
   detach semantics, busy behavior, pi transport default), **Added** (detach
   diagnostics, §10.3 cleanup guidance). README/troubleshooting updated in the
   same release; `timeout-recovery-prd.md` keeps its superseded note.

## Checklist (definition of done for this PRD's execution)

- [ ] Cancel returns instantly in both hosts while the child demonstrably runs on
- [ ] No code path sends a signal to an agy child (grep `\.kill\(` in engine/adapters)
- [ ] Ten-session matrix green with detached-cancel cases
- [ ] No quarantine/execution-state references remain (de-gating grep set, scoped per §12 phases; `ConversationBusyError` survives as the lock's own error)
- [ ] Local-state cleanup exists as a documented manual post-restart procedure (§10.3), executed outside the PR; no automated deletion in any build/install path
- [ ] First-turn lock handover opens no two-writer window (test, §7.2)
- [ ] Takeover refuses a live orphan child and stays conservative on indeterminate locks (tests, §7.3)
- [ ] Cancel-then-reinvoke spawns exactly once per new call; no path re-sends automatically
- [ ] Conversation link persisted before first delivery, with failure semantics tested
- [ ] Busy error is honest, bounded, spawn-free
- [ ] Docs/changelog/dist/version coherent; old PRD carries the superseded note
