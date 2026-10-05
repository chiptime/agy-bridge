# Evidence: §2.4 two-process same-conversation experiment

**Date:** 2026-10-01 · **agy version:** 1.2.14 (installed; the PRD's original
investigation referenced 1.2.6 — this evidence applies to 1.2.14) ·
**Protocol:** PRD §2.4 verbatim (`docs/conversation-continuity-detached-cancel-prd.md`),
throwaway dir, no repository code, no bridge imports.

**Conversation id:** `6a919d3f-9573-4a14-92d0-cf575044e479` (fresh for this run).

## Result: PASS on all criteria

| # | Criterion (PRD §2.4) | Result | Evidence |
| --- | --- | --- | --- |
| 1 | A and B both exit 0 with SUCCESS envelopes | **PASS** | `A_EXIT=0`, `B_EXIT=0`; `result.status: "SUCCESS"` in `runA.ndjson` / `runB.ndjson` |
| 2 | B's response contains the codeword (conversation state not corrupted) | **PASS** | `runB.ndjson` result: `"response":"MARBLE-VII\n"` |
| 3 | Timing shows B queued behind A **or** a safe interleaving with no lost turn | **PASS — safe interleaving** | Wall clock: A.start 1790871012.20 → B.start 1790871014.21 (2.0 s later) → B.end 1790871026.96 → A.end 1790871033.44. B completed ~6.5 s **before** A's process exited; A's response is the full `1…30\ndone` with nothing lost |
| 4 | C's answer reflects both turns in submission order | **PASS** | `runC.ndjson` result lists (1) "Count slowly from 1 to 30…" then (2) "Reply with exactly the codeword and nothing else." |
| 5 | Any warning on stderr recorded verbatim | **NONE OBSERVED** | All four stderr captures are empty (0 bytes) — see `run*.stderr` |

## Notable observations

- **agy is explicitly aware of the interleaving.** C's response carries this
  verbatim note: *"the codeword retrieval query was received and completed
  concurrently in the session transcript"* — the server-side history recorded
  the concurrent second writer and still answered C coherently and in order.
- **No headless warning.** V5's same-conversation warning (recommending
  `/fork`) did not appear on stderr in headless mode — consistent with the
  PRD's limit note that the TUI warning is a different code path.
- **Server-side `duration_seconds` exceeds wall clock** (B: 100.31 s reported
  vs ~12.7 s wall; A: 106.75 s vs ~21.2 s wall). Cause unknown; not
  interpreted. Recorded because it shows local process lifetime ≠ agy's
  accounting of turn time.

## What this does NOT demonstrate (PRD limits, unchanged)

Single sample; one agy version (1.2.14); no proof of internal race freedom in
agy's conversation storage; ordering is a single observation; the
interactive-TUI warning path remains untested.

## Implications (per PRD)

- The §2.3 pending assumption is **resolved for the installed version**: two
  simultaneous headless processes on one conversation interleaved safely with
  no lost turn and no corruption.
- Per D3: relaxing bridge-side serialization **may** be enabled by explicit
  config; the recommended default remains "keep serialization". A pass never
  authorizes automatic resends.

## Raw files (this directory)

`run0.ndjson` (conversation setup, codeword stored) · `runA.ndjson` (long turn,
1–30 + done) · `runB.ndjson` (short turn, codeword recall) · `runC.ndjson`
(order probe) · `run*.stderr` (all empty) · `tA/tB/tC.{start,end}` wall-clock
timestamps (epoch seconds).
