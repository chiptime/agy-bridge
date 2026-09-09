/**
 * Engine error taxonomy for agy runs (host-agnostic). Raw agy exit codes are
 * NOT trusted alone; classification combines spawn error, timeout and stall
 * flags, the typed JSON envelope (--output-format json), run.log markers,
 * exit code, and artifact presence. Host adapters map these outcomes onto
 * their own resume/fallback policies — the engine only decides WHAT
 * happened, never what to do next.
 *
 * classifyRun precedence (first match wins):
 * 1. spawnError ENOENT            → transient_unavailable (agy_absent)
 * 2. stalled                      → timeout (stall_detected) — the stream
 *    runner's stall watchdog killed the child after a stall window with no
 *    output line at all; recoverable like any other timeout
 * 3. timedOut OR exitCode 124     → timeout (timeout)
 * 4. exitCode 0 AND artifactBytes → success (ok) — a non-empty artifact on a
 *    clean exit is the authoritative success signal; log-pattern regexes gate
 *    only runs that miss this rule (failed runs)
 * 5. AUTH_RE matches log          → auth_captcha (auth_or_captcha)
 * 6. failed run AND envelope.status === 'ERROR' with the print-wait timeout
 *    signature in envelope.error → timeout (agy_print_wait_timeout) — the
 *    typed JSON envelope is the FIRST failed-run signal, ahead of the
 *    plain-text regex; any other envelope ERROR falls through to 7–10
 * 7. exitCode !== 0 (or null) AND PRINT_WAIT_TIMEOUT_RE matches log
 *                                → timeout (agy_print_wait_timeout) — kept as
 *    the plain-text fallback for runs without a parseable envelope
 * 8. exitCode !== 0 (or null) AND QUOTA_RE matches log
 *                                → quota_unavailable (quota_exhausted)
 * 9. exitCode !== 0 (or null) AND TRANSIENT_RE matches log
 *                                → transient_unavailable (provider_outage)
 *    Exit-code corroboration: the log is agy's COMBINED stdout+stderr, so
 *    quota/transient words can appear as noise on clean runs. They only
 *    count as unavailability (fallback) when the process exit code agrees.
 * 10. exitCode !== 0              → task_failure (nonzero_exit)
 * 11. artifactBytes missing/0      → artifact_validation_failure (artifact_missing_or_empty)
 */
import { type AgyEnvelope } from './spawn';

export type Outcome =
	| 'success'
	| 'quota_unavailable'
	| 'transient_unavailable'
	| 'auth_captcha'
	| 'timeout'
	| 'task_failure'
	| 'artifact_validation_failure';
/** Stream progress surfaced to the orchestrator: NDJSON event count, last event type, and agy's turn count when known. */
export interface RunProgress {
	events: number;
	lastEvent?: string;
	numTurns?: number;
}
/** What the runner observed about one agy invocation. */
export interface RunSignal {
	exitCode: number | null;
	log?: string;
	/** e.g. ENOENT when the binary could not even start. */
	spawnError?: string;
	timedOut?: boolean;
	/** True when the stream runner's stall watchdog killed the run after stallMs of silence. */
	stalled?: boolean;
	/** Size in bytes of the expected artifact; 0/undefined means missing. */
	artifactBytes?: number;
	/** Parsed `--output-format json` envelope, when agy printed one. */
	envelope?: AgyEnvelope;
	/** Stream progress observed by the async runner; present only after real streamed output. */
	progress?: RunProgress;
}
export interface Classification {
	outcome: Outcome;
	reason: string;
}
const AUTH_RE = /captcha|sign.?in|log.?in required|unauthenticated|forbidden|\b401\b|invalid credentials|authentication/i;
const QUOTA_RE = /quota|rate.?limit|\b429\b|resource.?exhausted|too many requests/i;
const TRANSIENT_RE = /unavailable|outage|overloaded|connection\s+(?:refused|reset|failed)|network\s+error|\b5\d\d\b|internal error|server error/i;
const PRINT_WAIT_TIMEOUT_RE = /timeout waiting for response/i;
/** Fallback to the native executor is allowed ONLY for approved unavailability. */
export function isFallbackAllowed(outcome: Outcome): boolean {
	return outcome === 'quota_unavailable' || outcome === 'transient_unavailable' || outcome === 'timeout';
}

/**
 * Deterministic exit/log/envelope → Outcome mapping. First match wins across
 * the 11 rules documented on this module: ENOENT, stall-watchdog kill
 * (stall_detected), plain timeout, artifact-backed success (exit 0 + artifact
 * present — immune to log patterns), AUTH gate, then, within FAILED runs, the
 * typed JSON envelope's ERROR status gates first (its print-wait timeout
 * signature maps to timeout, not task_failure), followed by the plain-text
 * print-wait regex fallback, the QUOTA/TRANSIENT regex gates for FAILED runs
 * only (nonzero/null exit — combined-output log noise on a clean exit is not
 * unavailability), nonzero exit, and empty artifact.
 */
export function classifyRun(signal: RunSignal): Classification {
	const log = signal.log ?? '';
	if (signal.spawnError === 'ENOENT') return { outcome: 'transient_unavailable', reason: 'agy_absent' };
	// Stall watchdog kill: no output line for the whole stall window. Checked
	// before the plain-timeout rule so a stalled run reports stall_detected;
	// either way the outcome is the recoverable timeout family.
	if (signal.stalled) return { outcome: 'timeout', reason: 'stall_detected' };
	if (signal.timedOut || signal.exitCode === 124) return { outcome: 'timeout', reason: 'timeout' };
	if (signal.exitCode === 0 && signal.artifactBytes) return { outcome: 'success', reason: 'ok' };
	// Mid-turn print-wait cut (live 2026-09-09): agy exits 0, reports status
	// SUCCESS with an EMPTY response, and marks stderr with this line while
	// the artifact never lands. The marker is the deadline signature — a
	// recoverable timeout for both exit codes, checked only after the
	// artifact-backed success rule so a delivered artifact always wins.
	if (/\[agy\] print timeout after \S+ with turn in progress/i.test(log)) {
		return { outcome: 'timeout', reason: 'agy_print_wait_timeout' };
	}
	if (AUTH_RE.test(log)) return { outcome: 'auth_captcha', reason: 'auth_or_captcha' };
	if (signal.exitCode !== 0) {
		// The typed JSON envelope (--output-format json) is the first failed-run
		// signal: its ERROR status with agy's own print-wait deadline signature is
		// a timeout, not a task failure — treat it as recoverable. Any other
		// envelope ERROR falls through to the regex gates below, which still run
		// against the log.
		if (signal.envelope?.status === 'ERROR' && /timeout waiting for response/i.test(signal.envelope.error ?? '')) {
			return { outcome: 'timeout', reason: 'agy_print_wait_timeout' };
		}
		// Plain-text fallback for runs without a parseable envelope: agy's print
		// client exits nonzero with this exact line when its own wait deadline fires.
		if (PRINT_WAIT_TIMEOUT_RE.test(log)) return { outcome: 'timeout', reason: 'agy_print_wait_timeout' };
		if (QUOTA_RE.test(log)) return { outcome: 'quota_unavailable', reason: 'quota_exhausted' };
		if (TRANSIENT_RE.test(log)) return { outcome: 'transient_unavailable', reason: 'provider_outage' };
		return { outcome: 'task_failure', reason: 'nonzero_exit' };
	}
	// agy sometimes exits 0 even when its own print-wait deadline fired
	// mid-turn (observed live: exit 0 + ERROR envelope + no artifact, while
	// pre-turn timeouts exit nonzero). The typed envelope is authoritative:
	// that is a recoverable timeout, not a task failure, so it must reach
	// the resume/fallback path instead of artifact_validation_failure.
	if (signal.envelope?.status === 'ERROR' && PRINT_WAIT_TIMEOUT_RE.test(signal.envelope.error ?? '')) {
		return { outcome: 'timeout', reason: 'agy_print_wait_timeout' };
	}
	if (!signal.artifactBytes) return { outcome: 'artifact_validation_failure', reason: 'artifact_missing_or_empty' };
	return { outcome: 'success', reason: 'ok' };
}
