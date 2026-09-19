/**
 * Bounded, privacy-safe call/attempt diagnostics (timeout-recovery PRD
 * slice 1, spec section 3 / AC6, AC9-AC11). Every `runTurn` call gets a
 * collision-resistant identity (a UUID, never a low-resolution timestamp,
 * the agy conversationId, or the host sessionId) and its own diagnostics
 * directory holding one exclusive log file PER ATTEMPT plus a bounded JSON
 * summary. This retires the fixed workdir `run.log` as the authoritative
 * evidence path: neither retries of one call nor unrelated calls sharing a
 * workdir (session mode's persistent worktree, or the two attempts of one
 * scratch-mode call) can ever truncate another attempt's evidence.
 *
 * The summary is the file named by the `Full log:` convention (errors.ts).
 * It never carries prompts, attachments, env vars, credentials, or the raw
 * agy conversationId / host sessionId — only the allowlisted fields listed
 * on {@link AttemptDiagnostic} and {@link CallDiagnosticSummary}. Writing or
 * pruning diagnostics can fail (disk full, permissions) without ever
 * becoming the turn's failure cause: every filesystem operation here is
 * best-effort and swallows its own errors, and a failed write reports
 * itself honestly via {@link NO_DIAGNOSTICS_LOG} instead of a fabricated
 * path.
 */
import { lstatSync, readdirSync, rmSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCRATCH_MAX_AGE_MS } from "./workdir";

/** Hidden per-workdir directory holding one subdirectory per call. */
const DIAGNOSTICS_DIRNAME = ".agy-diagnostics";
/** Per-call summary filename inside its call group directory. */
const SUMMARY_FILENAME = "summary.json";

/** Bounded summary size (PRD section 3 retention decision). */
export const MAX_SUMMARY_BYTES = 8 * 1024;
/** Max retained completed call groups per workdir; oldest pruned first. */
export const MAX_CALL_GROUPS = 200;
/**
 * Max retained loose per-attempt log FILES in {@link fallbackDiagnosticsDir}
 * (tier 2) and matching tier-3 files directly under the OS tmpdir (see
 * {@link pruneLooseTier3Logs}) — mirrors {@link MAX_CALL_GROUPS}'s
 * age-AND-count retention shape for the primary root (PRD section 3: finite
 * age and byte/count limits, no unbounded exception for any tier).
 */
export const MAX_FALLBACK_ENTRIES = 200;
/** Reuse the scratch age policy verbatim — one retention clock, not two. */
export const DIAGNOSTICS_MAX_AGE_MS = SCRATCH_MAX_AGE_MS;

/** Reported in place of a real path when the summary could not be written. */
export const NO_DIAGNOSTICS_LOG = "(diagnostics unavailable — the call summary could not be written)";

/**
 * Matches exactly what {@link generateCallId}/`randomUUID()` produces
 * (RFC4122-shaped, any version/variant, case-insensitive). A call-group
 * directory name that does not match this pattern is never bridge-owned —
 * it is skipped everywhere ownership is checked (retention listing), even
 * when it contains a `summary.json`, rather than trusting the presence of
 * that one file as proof of ownership.
 */
const CALL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Collision-resistant call identity: a UUID, never a timestamp or session/conversation id. */
export function generateCallId(): string {
	return randomUUID();
}

/**
 * Dedicated, bridge-owned subdirectory under the OS tmpdir for attempt logs
 * that could not be placed under a call's own `.agy-diagnostics` group
 * (workdir unwritable, permissions, a foreign file blocking the path). A
 * bare loose file directly in the OS tmpdir would never be found by
 * {@link pruneDiagnosticsUnder} (which only scans `.agy-diagnostics`
 * directories) and would accumulate unbounded across repeated failures;
 * this subdirectory is instead swept by {@link pruneFallbackDiagnostics}.
 */
export function fallbackDiagnosticsDir(): string {
	return join(tmpdir(), "agy-bridge-diagnostics-fallback");
}

/** Exclusive fallback log path for one attempt, inside {@link fallbackDiagnosticsDir}. */
export function fallbackAttemptLogPathFor(callId: string, attemptIndex: number): string {
	return join(fallbackDiagnosticsDir(), `${callId}-${attemptIndex}.log`);
}

/** `<workdir>/.agy-diagnostics` — parent of every call group for this workdir. */
export function diagnosticsDirFor(workdir: string): string {
	return join(workdir, DIAGNOSTICS_DIRNAME);
}

/** `<workdir>/.agy-diagnostics/<callId>` — one call's exclusive group directory. */
export function callGroupDirFor(workdir: string, callId: string): string {
	return join(diagnosticsDirFor(workdir), callId);
}

/** Exclusive per-attempt log path: never shared across attempts or calls. */
export function attemptLogPathFor(workdir: string, callId: string, attemptIndex: number): string {
	return join(callGroupDirFor(workdir, callId), `attempt-${attemptIndex}.log`);
}

/** The `Full log:` path for a call: a bounded summary naming every attempt log. */
export function summaryPathFor(workdir: string, callId: string): string {
	return join(callGroupDirFor(workdir, callId), SUMMARY_FILENAME);
}

/**
 * Resolve THIS attempt's exclusive log path, creating its call group
 * directory first (runAgyStream opens the path directly and never creates
 * parent directories itself; owner-only 0o700, PRD section 3's
 * owner-restricted access requirement). A directory-creation failure (disk
 * full, permissions, a foreign file blocking `.agy-diagnostics`) must
 * never block the spawn — the turn's real outcome is not a diagnostics
 * concern — so this degrades to the dedicated, still-exclusive, and still
 * pruneable {@link fallbackDiagnosticsDir}; only if THAT also cannot be
 * created does it fall back further to a bare, best-effort path directly
 * under the OS tmpdir — degenerate (needs two prior mkdir failures) but
 * still swept, pattern-scoped, by {@link pruneLooseTier3Logs}.
 */
export function resolveAttemptLogPath(workdir: string, callId: string, attemptIndex: number): string {
	try {
		mkdirSync(callGroupDirFor(workdir, callId), { recursive: true, mode: 0o700 });
		return attemptLogPathFor(workdir, callId, attemptIndex);
	} catch {
		try {
			mkdirSync(fallbackDiagnosticsDir(), { recursive: true, mode: 0o700 });
			return fallbackAttemptLogPathFor(callId, attemptIndex);
		} catch {
			return join(tmpdir(), `agy-attempt-${callId}-${attemptIndex}.log`);
		}
	}
}

/**
 * Continuation-vs-recovery mode (spec section 3): "recovery" marks the
 * attempt triggered by turn.ts's PRE-EXISTING resume-once mechanism
 * (`canResume` — it already runs today, independent of this diagnostics
 * slice); every other attempt, including ordinary multi-turn continuation
 * (D5/R7, the `resumed` flag), records "initial". This field only LABELS
 * what already happened — it does not decide eligibility. The known
 * accounting bug where `resumed` conflates recovery eligibility with
 * ordinary continuation is unchanged here and is tracked as a separate,
 * not-yet-implemented slice.
 */
export type AttemptMode = "initial" | "recovery";

/** One child invocation's bounded, allowlisted diagnostic facts. */
export interface AttemptDiagnostic {
	attemptIndex: number;
	/** Absolute path of this attempt's exclusive log file. */
	logPath: string;
	mode: AttemptMode;
	/** True when this attempt resumed a stored conversation (ordinary continuation, D5/R7 — unrelated to recovery accounting). */
	resumed: boolean;
	/** Whether a conversation id was captured; never the id itself. */
	idAvailable: boolean;
	timeoutMsEffective: number;
	stallMsEffective: number;
	/** Bridge-measured wall elapsed time for this attempt (ms). */
	wallElapsedMs: number;
	exitCode: number | null;
	/**
	 * Strongest termination signal the child was asked to die with, as a
	 * closed allowlisted set (PRD section 3): "SIGTERM" when a watchdog
	 * killed the run, "SIGKILL" when the bounded termination chain
	 * escalated past the grace window (never misreported as a plain
	 * SIGTERM), "unknown" for a signal-killed child with no exit code, and
	 * "none" for a clean exit. Whether death was ever CONFIRMED is not
	 * this field's job — a forced settlement reports
	 * classificationOutcome "termination_unconfirmed".
	 */
	signal: "SIGTERM" | "SIGKILL" | "unknown" | "none";
	timedOut: boolean;
	stalled: boolean;
	/** True when the caller's abort signal was observed during/after this attempt. */
	aborted: boolean;
	classificationOutcome: string;
	classificationReason: string;
}

/**
 * Recovery disposition, derived honestly from the attempts array (never
 * hardcoded): "not-attempted" when no attempt has `mode: "recovery"`;
 * otherwise "attempted-success"/"attempted-failure" reflecting that
 * recovery attempt's own classification outcome.
 */
export type RecoveryDisposition = "not-attempted" | "attempted-success" | "attempted-failure";

/** The bounded record written to {@link summaryPathFor}; the `Full log:` target. */
export interface CallDiagnosticSummary {
	version: 1;
	callId: string;
	/** Loaded bridge/CLI version; "unknown" unless already reliably known without spawning discovery commands. */
	bridgeVersion: string;
	recoveryDisposition: RecoveryDisposition;
	attempts: AttemptDiagnostic[];
	createdAt: string;
	completedAt: string;
	truncated?: boolean;
	truncationNote?: string;
}

/** Derive the `signal` field purely from already-known watchdog facts — never a discovery spawn. */
function observedSignal(
	timedOut: boolean,
	stalled: boolean,
	exitCode: number | null,
	escalatedSignal?: string,
): AttemptDiagnostic["signal"] {
	// Escalation honesty: once the bounded termination chain escalated, the
	// strongest signal actually delivered is reported — a forced-settlement
	// run must never read as a plain SIGTERM report.
	if (escalatedSignal === "SIGKILL") return "SIGKILL";
	if (timedOut || stalled) return "SIGTERM"; // both watchdogs always SIGTERM the child.
	if (exitCode === null) return "unknown";
	return "none";
}

/** Build one attempt's bounded diagnostic record from already-known facts (pure, no I/O). */
export function buildAttemptDiagnostic(input: {
	attemptIndex: number;
	logPath: string;
	mode: AttemptMode;
	resumed: boolean;
	conversationId: string | undefined;
	timeoutMsEffective: number;
	stallMsEffective: number;
	wallElapsedMs: number;
	exitCode: number | null;
	timedOut: boolean;
	stalled: boolean;
	/** Signal the bounded termination chain escalated to ("SIGKILL"), when escalation fired. */
	escalatedSignal?: string;
	aborted: boolean;
	classificationOutcome: string;
	classificationReason: string;
}): AttemptDiagnostic {
	return {
		attemptIndex: input.attemptIndex,
		logPath: input.logPath,
		mode: input.mode,
		resumed: input.resumed,
		idAvailable: input.conversationId !== undefined,
		timeoutMsEffective: input.timeoutMsEffective,
		stallMsEffective: input.stallMsEffective,
		wallElapsedMs: input.wallElapsedMs,
		exitCode: input.exitCode,
		signal: observedSignal(input.timedOut, input.stalled, input.exitCode, input.escalatedSignal),
		timedOut: input.timedOut,
		stalled: input.stalled,
		aborted: input.aborted,
		classificationOutcome: input.classificationOutcome,
		classificationReason: input.classificationReason,
	};
}

/**
 * Serialize a summary within {@link MAX_SUMMARY_BYTES}, truncating
 * deterministically and explicitly when it does not fit. Truncation drops
 * the OLDEST attempt entries first (kept: the first attempt — the initial
 * failure evidence — and the most recent one) before falling back to a
 * minimal, always-tiny placeholder object. The result is always valid JSON.
 */
export function boundedSummaryJson(summary: CallDiagnosticSummary): { json: string; truncated: boolean } {
	const fits = (obj: unknown): string | undefined => {
		const json = JSON.stringify(obj, null, 2);
		return Buffer.byteLength(json, "utf8") <= MAX_SUMMARY_BYTES ? json : undefined;
	};
	const plain = fits({ ...summary, truncated: false });
	if (plain !== undefined) return { json: plain, truncated: false };

	// Drop the middle attempts first, keeping the first (initial failure
	// evidence) and the last (most recent outcome) — a minimal but still
	// informative shrink before falling back to the placeholder below.
	if (summary.attempts.length > 2) {
		const omitted = summary.attempts.length - 2;
		const shrunk: CallDiagnosticSummary = {
			...summary,
			attempts: [summary.attempts[0], summary.attempts[summary.attempts.length - 1]],
			truncated: true,
			truncationNote: `${omitted} attempt entr${omitted === 1 ? "y" : "ies"} omitted to satisfy the ${MAX_SUMMARY_BYTES}-byte bound...[truncated]`,
		};
		const shrunkJson = fits(shrunk);
		if (shrunkJson !== undefined) return { json: shrunkJson, truncated: true };
	}

	// Still over budget (pathological): a minimal, guaranteed-small placeholder.
	const placeholder: CallDiagnosticSummary = {
		version: summary.version,
		callId: summary.callId,
		bridgeVersion: summary.bridgeVersion,
		recoveryDisposition: summary.recoveryDisposition,
		attempts: [],
		createdAt: summary.createdAt,
		completedAt: summary.completedAt,
		truncated: true,
		truncationNote: `record exceeded the ${MAX_SUMMARY_BYTES}-byte bound and was replaced with this placeholder; ${summary.attempts.length} attempt entries omitted...[truncated]`,
	};
	return { json: JSON.stringify(placeholder, null, 2), truncated: true };
}

/**
 * Write the call summary to its exclusive path (atomic rename, mirroring
 * session-store.ts's write pattern). Throws on any filesystem failure —
 * callers must catch and fall back to {@link NO_DIAGNOSTICS_LOG}; a
 * diagnostics write failure must never surface as (or replace) the turn's
 * real outcome.
 */
export function writeCallSummary(workdir: string, callId: string, summary: CallDiagnosticSummary): string {
	const dir = callGroupDirFor(workdir, callId);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const { json } = boundedSummaryJson(summary);
	const path = summaryPathFor(workdir, callId);
	const tmp = join(dir, `.${SUMMARY_FILENAME}.${process.pid}.tmp`);
	writeFileSync(tmp, json, { mode: 0o600 });
	renameSync(tmp, path);
	return path;
}

/** One completed call group discovered on disk, for retention purposes. */
interface CallGroup {
	dir: string;
	mtimeMs: number;
}

/**
 * List completed call groups directly under a `.agy-diagnostics` directory:
 * only entries that are real directories (never a followed symlink), whose
 * NAME is a syntactically valid UUID (see {@link CALL_ID_PATTERN} — the
 * only ownership proof this module trusts; a `summary.json` alone is not
 * enough), AND that have a `summary.json` are "completed" — an in-progress
 * call has no summary yet and is never a pruning candidate. Never throws;
 * an unreadable or absent root yields an empty list.
 */
export function listCompletedCallGroups(diagnosticsDir: string): CallGroup[] {
	let entries;
	try {
		entries = readdirSync(diagnosticsDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const groups: CallGroup[] = [];
	for (const entry of entries) {
		if (entry.isSymbolicLink() || !entry.isDirectory()) continue; // never follow symlinks.
		if (!CALL_ID_PATTERN.test(entry.name)) continue; // not a bridge-generated call id — never bridge-owned.
		const dir = join(diagnosticsDir, entry.name);
		const summary = join(dir, SUMMARY_FILENAME);
		try {
			const st = lstatSync(summary);
			if (!st.isFile()) continue; // a symlinked/odd summary is never trusted.
			groups.push({ dir, mtimeMs: st.mtimeMs });
		} catch {
			continue; // no summary yet → in-progress/active → never a candidate.
		}
	}
	return groups;
}

/**
 * Delete a completed call group (summary + all its attempt logs together —
 * they live in one directory, so a single recursive removal never leaves
 * orphans). Best-effort: swallows its own errors so one bad delete never
 * blocks the rest of a pruning pass.
 */
function removeCallGroup(dir: string): boolean {
	try {
		rmSync(dir, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * Apply age + count retention to an already-listed set of completed call
 * groups: delete everything older than maxAgeMs, then — among what
 * survives — delete the oldest excess beyond maxGroups. Returns the number
 * of groups removed. Pure orchestration over already-discovered groups;
 * {@link pruneDiagnosticsUnder} is the safe, self-contained entry point.
 */
export function pruneCallGroups(
	groups: CallGroup[],
	opts: { now: Date; maxAgeMs: number; maxGroups: number },
): number {
	const nowMs = opts.now.getTime();
	let pruned = 0;
	const survivors: CallGroup[] = [];
	for (const g of groups) {
		if (nowMs - g.mtimeMs > opts.maxAgeMs) {
			if (removeCallGroup(g.dir)) pruned++;
		} else {
			survivors.push(g);
		}
	}
	if (survivors.length > opts.maxGroups) {
		survivors.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first.
		const excess = survivors.length - opts.maxGroups;
		for (let i = 0; i < excess; i++) {
			if (removeCallGroup(survivors[i].dir)) pruned++;
		}
	}
	return pruned;
}

/**
 * Self-contained retention pass for one workdir's `.agy-diagnostics`
 * directory (session mode's natural call site: the worktree persists
 * across every unrelated host session sharing it). Never throws — a
 * pruning failure must never become a turn failure cause.
 *
 * Guards `diagnosticsDir` ITSELF, not just its children: `lstatSync` (never
 * `stat`/`existsSync`, which follow symlinks) reports the link itself when
 * `.agy-diagnostics` is a symlink, so `isDirectory()` is false and pruning
 * is skipped entirely — the same "never follow" posture
 * {@link listCompletedCallGroups} already applies to child entries. Without
 * this, a symlinked `.agy-diagnostics` would let pruning walk into and
 * delete unrelated directories elsewhere on disk.
 *
 * Honesty note: this `lstatSync` guard only rejects a root that is ALREADY
 * a symlink at check time. It does NOT close a check-then-use (TOCTOU) race
 * where the root is replaced by a symlink between this `lstatSync` and the
 * `readdirSync`/`rmSync` calls that follow — closing that race would need
 * fd-relative operations this module does not use. {@link
 * pruneFallbackDiagnostics} carries the identical residual limitation.
 */
export function pruneDiagnosticsUnder(
	diagnosticsDir: string,
	opts: { now?: Date; maxAgeMs?: number; maxGroups?: number } = {},
): number {
	try {
		let rootStat;
		try {
			rootStat = lstatSync(diagnosticsDir);
		} catch {
			return 0; // missing — nothing to prune.
		}
		if (!rootStat.isDirectory()) return 0; // symlink (or anything else) — never follow.
		const groups = listCompletedCallGroups(diagnosticsDir);
		return pruneCallGroups(groups, {
			now: opts.now ?? new Date(),
			maxAgeMs: opts.maxAgeMs ?? DIAGNOSTICS_MAX_AGE_MS,
			maxGroups: opts.maxGroups ?? MAX_CALL_GROUPS,
		});
	} catch {
		return 0;
	}
}

/**
 * Shared age+count sweep over a flat directory of loose log FILES (never
 * call-group subdirectories — {@link pruneCallGroups} owns that shape):
 * delete everything older than maxAgeMs, then — among what survives —
 * delete the oldest excess beyond maxEntries. Only entries matching
 * `isOwned` are ever considered, so callers can pattern-scope which files
 * in a shared directory (e.g. the OS tmpdir) this module is allowed to
 * touch. Never follows symlinks. Never throws; a missing/unreadable
 * directory or a root that fails the `lstatSync` guard prunes nothing.
 *
 * Honesty note (same residual limitation as {@link pruneDiagnosticsUnder}):
 * the `lstatSync` root guard only rejects a root that is ALREADY a symlink
 * at check time — it does not close a TOCTOU race where the root is
 * replaced between this check and the `readdirSync`/`rmSync` calls below.
 */
function pruneLooseLogFiles(
	rootDir: string,
	isOwned: (name: string) => boolean,
	opts: { now?: Date; maxAgeMs?: number; maxEntries?: number },
): number {
	let rootStat;
	try {
		rootStat = lstatSync(rootDir);
	} catch {
		return 0; // missing — nothing to prune.
	}
	if (!rootStat.isDirectory()) return 0; // symlink (or anything else) — never follow.
	let entries;
	try {
		entries = readdirSync(rootDir, { withFileTypes: true });
	} catch {
		return 0;
	}
	const nowMs = (opts.now ?? new Date()).getTime();
	const maxAgeMs = opts.maxAgeMs ?? DIAGNOSTICS_MAX_AGE_MS;
	const maxEntries = opts.maxEntries ?? MAX_FALLBACK_ENTRIES;
	let pruned = 0;
	const survivors: { path: string; mtimeMs: number }[] = [];
	for (const entry of entries) {
		if (entry.isSymbolicLink() || !entry.isFile()) continue; // never follow symlinks.
		if (!isOwned(entry.name)) continue; // pattern-scoped: never touch a file this module didn't write.
		const path = join(rootDir, entry.name);
		let st;
		try {
			st = lstatSync(path);
		} catch {
			continue; // one bad stat never blocks the rest of the pass.
		}
		if (nowMs - st.mtimeMs > maxAgeMs) {
			try {
				rmSync(path, { force: true });
				pruned++;
			} catch {
				continue;
			}
		} else {
			survivors.push({ path, mtimeMs: st.mtimeMs });
		}
	}
	if (survivors.length > maxEntries) {
		survivors.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first.
		const excess = survivors.length - maxEntries;
		for (let i = 0; i < excess; i++) {
			try {
				rmSync(survivors[i].path, { force: true });
				pruned++;
			} catch {
				continue;
			}
		}
	}
	return pruned;
}

/**
 * Age+count retention for {@link fallbackDiagnosticsDir} (tier 2): this
 * location holds loose per-attempt log FILES, not summary-bearing call
 * groups, so the flat {@link pruneLooseLogFiles} sweep is sufficient —
 * there is no count-based grouping logic to reinvent here. Every file
 * directly under this bridge-owned directory is ours (no foreign-file
 * risk the way a shared root like the OS tmpdir has), so `isOwned` accepts
 * everything.
 *
 * `rootDir` defaults to the real {@link fallbackDiagnosticsDir} (production
 * call sites keep calling this with zero arguments) but is overridable so
 * tests can exercise THIS exported function — never a copy of its
 * algorithm — against an isolated sandbox tree, including a symlinked
 * root (see the guard in {@link pruneLooseLogFiles}).
 */
export function pruneFallbackDiagnostics(
	rootDir: string = fallbackDiagnosticsDir(),
	opts: { now?: Date; maxAgeMs?: number; maxEntries?: number } = {},
): number {
	return pruneLooseLogFiles(rootDir, () => true, opts);
}

/**
 * Matches exactly what {@link resolveAttemptLogPath}'s THIRD, degenerate
 * fallback tier writes: `agy-attempt-<uuid>-<attemptIndex>.log` directly
 * under the OS tmpdir (reached only when BOTH the primary call-group mkdir
 * AND {@link fallbackDiagnosticsDir}'s mkdir have failed).
 */
const LOOSE_TIER3_PATTERN = new RegExp(`^agy-attempt-${CALL_ID_PATTERN.source.slice(1, -1)}-\\d+\\.log$`, "i");

/**
 * Pattern-scoped sweep for {@link resolveAttemptLogPath}'s THIRD tier: bare
 * loose files written directly under the OS tmpdir when even the managed
 * {@link fallbackDiagnosticsDir} could not be created. That tier's own
 * comment self-documents as "unpruneable, best-effort" — but PRD section 3
 * requires finite retention with NO unbounded exception, however rare the
 * path (it needs two prior mkdir failures). The OS tmpdir is shared with
 * unrelated processes and files, so this NEVER does a blanket
 * readdir+delete sweep of the whole root: only filenames matching {@link
 * LOOSE_TIER3_PATTERN} — exactly what this one call site writes — are ever
 * candidates; everything else living in tmpdir is left untouched. Same
 * age+count bound as tier 2 ({@link pruneFallbackDiagnostics}); same
 * `rootDir` injection seam for sandboxed testing, defaulting to the real
 * OS tmpdir for production call sites.
 */
export function pruneLooseTier3Logs(
	rootDir: string = tmpdir(),
	opts: { now?: Date; maxAgeMs?: number; maxEntries?: number } = {},
): number {
	return pruneLooseLogFiles(rootDir, (name) => LOOSE_TIER3_PATTERN.test(name), opts);
}
