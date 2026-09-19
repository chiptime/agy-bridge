/**
 * Turn orchestration (design D2/D5/D7): one runTurn call = quota gate →
 * workdir preparation → session lookup → at most two runAgyStream attempts
 * (a second attempt only for the timeout family, resuming the captured
 * conversation id exactly once and BEFORE any text part could exist — agy
 * has no token streaming). Success binds the session mapping; a failed
 * resumed attempt rebinds so the next turn runs fresh (R7.s3); every other
 * failure maps onto provider semantics via errors.ts and throws TurnError.
 * Abort kills the child through the stream tap, persists the tapped
 * conversation id, then rejects with an AbortError (D2).
 *
 * Image bridge (spec image-input R2/R3/R6, design D1/D4/D7): decoded
 * attachments from TurnRequest stage under <workdir>/.agy-attachments
 * after prepareWorkdir, a deterministic inspection directive is PREPENDED
 * to the effective prompt (rebuilt every turn — unlike a system prefix,
 * it survives ongoing sessions), the line tap watches for view_file steps
 * referencing staged filenames, and session-mode workdirs prune stale
 * entries with the same 7-day policy as scratch.
 *
 * v1.1 divergence policy — decided BEFORE the timeout-resume machinery:
 * - no stored entry → first turn: fresh agy conversation, last-user-turn
 *   prompt (unchanged behavior);
 * - stored entry WITHOUT hashes (pre-upgrade) → unknown baseline: ADOPT it
 *   and treat the turn as linear (resuming preserves agy's context; one
 *   adoption turn, then the incoming hashes are stored and protection is
 *   active);
 * - stored hashes a PREFIX of the incoming hashes → linear continuation:
 *   resume via --conversation (unchanged behavior);
 * - otherwise (earlier messages edited/deleted/reordered in the client) →
 *   DIVERGED: fresh agy conversation with the caller's seedPrompt (a bounded
 *   re-render of the visible thread, messages.renderSeed), onDiverged fires,
 *   and after success the NEW conversation id + incoming hashes become the
 *   baseline.
 */
import {
	acquireConversationLock,
	attachmentDirective,
	classifyRun,
	ConversationBusyError,
	decidePool,
	DEFAULT_STALL_MS,
	parseSnapshotDir,
	pruneAttachments,
	runAgyStream,
	stageAttachments,
	type Classification,
	type ConversationLock,
	type ExtractedImage,
	type SpawnRun,
} from "agy-bridge-engine";
import type { spawn } from "node:child_process";
import { basename, dirname, join } from "node:path";
import type { AgyAdapterConfig } from "./config";
import { resolveStateDir } from "./paths";
import type { SessionStore } from "./session-store";
import { createTap } from "./stream-tap";
import { prepareWorkdir, pruneScratch } from "./workdir";
import { mapClassification, type ErrorMapping } from "./errors";
import {
	buildAttemptDiagnostic,
	diagnosticsDirFor,
	generateCallId,
	NO_DIAGNOSTICS_LOG,
	pruneDiagnosticsUnder,
	pruneFallbackDiagnostics,
	pruneLooseTier3Logs,
	resolveAttemptLogPath,
	writeCallSummary,
	type AttemptDiagnostic,
	type CallDiagnosticSummary,
	type RecoveryDisposition,
} from "./diagnostics";

/** Matches the plugin-era explore budget documented in the engine (1230s). */
export const DEFAULT_TURN_TIMEOUT_MS = 1_230_000;

export interface TurnResult {
	classification: Classification;
	run: SpawnRun;
	resumed: boolean;
	/** v1.1: the visible thread diverged from agy's history; a fresh, seeded conversation was started. */
	diverged: boolean;
	logPath: string;
	conversationId?: string;
	/** Relative paths (agent-cwd-relative) of staged attachment files; unset when nothing staged. */
	stagedAttachments?: string[];
	/** True when every staged image was inspected via view_file (vacuously true when nothing staged). */
	attachmentsInspected?: boolean;
}

export interface TurnRequest {
	prompt: string;
	/**
	 * v1.1: ordered per-message hashes of the opencode prompt array AS
	 * FORWARDED this turn (messages.messageHashes). Compared against the
	 * stored baseline to pick resume vs fresh re-seed, then stored as the
	 * new baseline after a successful turn.
	 */
	hashes: string[];
	/** v1.1: seeded prompt used INSTEAD of prompt when divergence is detected. */
	seedPrompt?: string;
	/**
	 * Image attachments (design D3/D4, spec image-input R2): decoded images
	 * extracted from the last user turn; staged under
	 * <workdir>/.agy-attachments after prepareWorkdir.
	 */
	attachments?: ExtractedImage[];
	/** Resolved --model value; undefined means agy picks its own default. */
	modelArg?: string;
	sessionId: string;
	signal?: AbortSignal;
	/** Live NDJSON stdout line tap → status parts (D1). */
	onLine?: (line: string) => void;
	/** Announces the single resume attempt (D5 status part). */
	onResume?: () => void;
	/** v1.1: announces the divergence re-seed (status part). */
	onDiverged?: () => void;
}

export interface TurnDeps {
	bin: string;
	config: AgyAdapterConfig;
	store: SessionStore;
	/** Plugin worktree (providerOptions.agy.worktree); session mode requires it. */
	worktree?: string;
	/** Injectable spawn for tests (fed to the stream tap). */
	spawnFn?: typeof spawn;
	/**
	 * Prompt transport seam (default true): when true, prompts ride stdin
	 * as stream-json NDJSON instead of argv --print. Eliminates E2BIG on
	 * large system prompts.
	 */
	promptViaStdin?: boolean;
}

/** Terminal turn failure carrying the mapped provider semantics (R6). */
export class TurnError extends Error {
	constructor(public readonly mapping: ErrorMapping) {
		super(mapping.message);
		this.name = "TurnError";
	}
}

const NO_LOG = "(no run log; the run was rejected before spawn)";

/** Engine promotion (pi-image-input D1): attachmentDirective moved to the
 * engine and is re-exported here so this module's public API stays
 * identical. */
export { attachmentDirective };

function abortError(): Error {
	const err = new Error("agy turn aborted by the caller");
	err.name = "AbortError";
	return err;
}

export async function runTurn(deps: TurnDeps, req: TurnRequest): Promise<TurnResult> {
	if (req.signal?.aborted) throw abortError();
	// D7 quota gate — cheapest rejection first, before any fs or spawn work.
	// An unset or unreadable snapshot fails OPEN (one real attempt refreshes
	// the routing hint), exactly like the engine's stale-snapshot policy.
	if (deps.config.quotaSnapshotDir) {
		const snapshot = parseSnapshotDir(deps.config.quotaSnapshotDir);
		if (snapshot) {
			const decision = decidePool(snapshot, req.modelArg ?? "");
			if (!decision.allowed) {
				throw new TurnError(
					mapClassification({ outcome: "quota_unavailable", reason: "quota_exhausted" }, {
						logPath: NO_LOG,
						resetTime: decision.resetTime,
					}),
				);
			}
		}
	}
	const workdir = prepareWorkdir(deps.config.workdirMode, {
		scratchRoot: deps.config.scratchRoot,
		worktree: deps.worktree,
	});
	// Collision-resistant call identity (timeout-recovery PRD slice 1):
	// generated fresh per call, never derived from a timestamp, the agy
	// conversation id, or req.sessionId — both are reused across many
	// calls over their lifetime (and, in session mode, across every
	// unrelated host session sharing this workdir).
	const callId = generateCallId();
	if (workdir.scratch) {
		pruneScratch(dirname(workdir.dir));
	} else {
		// Session mode: the workdir is the plugin's worktree, reused
		// verbatim across every unrelated host session — bounded age/count
		// retention keeps its accumulated call diagnostics from growing
		// forever. Best-effort: a pruning failure never fails the turn.
		pruneDiagnosticsUnder(diagnosticsDirFor(workdir.dir));
	}
	// Fallback diagnostics location (spec section 3 retention): loose
	// attempt logs that resolveAttemptLogPath could not place under this
	// call's own .agy-diagnostics group land in a dedicated, bridge-owned
	// tmpdir subdirectory instead. Age+count retention there is independent
	// of workdir mode, so it runs unconditionally, next to the two prunes
	// above. Best-effort: a pruning failure never fails the turn.
	pruneFallbackDiagnostics();
	// THIRD, degenerate fallback tier (Fix 3): bare loose files directly
	// under the OS tmpdir, written only when BOTH prior mkdir attempts
	// failed. Pattern-scoped — never a blanket tmpdir sweep — so it is
	// just as safe to run unconditionally alongside the sweep above.
	pruneLooseTier3Logs();
	// D4 staging (spec image-input R2): decoded attachments land under
	// <workdir>/.agy-attachments AFTER prepareWorkdir resolves the turn
	// workdir (the mkdtemp happens above; language-model cannot know it).
	// An empty/absent batch stages nothing — no filesystem trace.
	const staged = req.attachments === undefined ? [] : stageAttachments(workdir.dir, req.attachments);
	// D4 lifecycle (spec image-input R6): session-mode workdirs are the
	// user's worktree, so staged entries join the 7-day prune explicitly;
	// scratch mode is already covered by pruneScratch above.
	if (!workdir.scratch) pruneAttachments(workdir.dir);
	// Fire-and-forget 30-day retention: never blocks or fails a turn.
	void deps.store.prune().catch(() => {});
	// Bounded per-call diagnostics (PRD section 3): every attempt of this
	// call gets its OWN exclusive log file under
	// <workdir>/.agy-diagnostics/<callId>/ — retiring the fixed workdir
	// run.log, which both attempts of one call (and, in session mode,
	// every unrelated call) used to share and truncate. finalizeDiagnostics
	// writes the bounded call summary — the `Full log:` target — exactly
	// once, right before the call's terminal success/failure/abort exit.
	const callStartedAt = new Date();
	const attemptDiagnostics: AttemptDiagnostic[] = [];
	const finalizeDiagnostics = (): string => {
		// Derived honestly from what actually happened, never hardcoded:
		// "not-attempted" unless one of this call's attempts was the
		// canResume-triggered recovery attempt (mode "recovery" below),
		// in which case its own classification outcome decides
		// success/failure. There is at most one such attempt (D5
		// resume-once).
		const recoveryAttempt = attemptDiagnostics.find((a) => a.mode === "recovery");
		const recoveryDisposition: RecoveryDisposition =
			recoveryAttempt === undefined
				? "not-attempted"
				: recoveryAttempt.classificationOutcome === "success"
					? "attempted-success"
					: "attempted-failure";
		const summary: CallDiagnosticSummary = {
			version: 1,
			callId,
			// Not already reliably known without spawning discovery
			// commands for logging (PRD section 3) — literal "unknown".
			bridgeVersion: "unknown",
			recoveryDisposition,
			attempts: attemptDiagnostics,
			createdAt: callStartedAt.toISOString(),
			completedAt: new Date().toISOString(),
		};
		try {
			return writeCallSummary(workdir.dir, callId, summary);
		} catch {
			// A diagnostics write failure must never become (or mask) the
			// turn's real outcome — report unavailability honestly instead
			// of fabricating a path that does not exist.
			return NO_DIAGNOSTICS_LOG;
		}
	};
	// v1.1 divergence decision, v2 multi-conversation edition (see header
	// comment): resolve() picks WHICH stored binding this call continues —
	// prefix baseline → linear resume; hashes-less binding → adopt-once; no
	// match with bindings present → DIVERGED re-seed (a NEW binding is bound
	// after success); no bindings at all → first turn, fresh. The timeout
	// resume-once machinery below is unchanged and composes with all shapes.
	const binding = await deps.store.resolve(req.sessionId, req.hashes);
	const sessionKnown = binding !== undefined ? true : (await deps.store.get(req.sessionId)) !== undefined;
	let diverged = false;
	let resumeId: string | undefined;
	if (binding !== undefined) {
		resumeId = binding.conversationId; // prefix match or adopt-once
	} else if (!sessionKnown) {
		resumeId = undefined; // first turn: fresh, last-user-turn only
	} else {
		diverged = true; // edited/deleted/reordered history → fresh re-seed, NEW binding
		req.onDiverged?.();
	}
	// D1 directive: deterministically prepended to the effective prompt
	// (prompt OR seedPrompt) whenever anything staged.
	const directive = attachmentDirective(staged);
	// D7 inspection tap (spec image-input R3): a step line naming
	// view_file AND a staged filename marks the images inspected. Shape-
	// tolerant on purpose — only step_update lines carry tool names.
	let attachmentsInspected = staged.length === 0;
	const stagedNames = staged.map((rel) => basename(rel));
	const inspectingOnLine = (line: string): void => {
		if (!attachmentsInspected && line.includes("view_file") && stagedNames.some((name) => line.includes(name))) {
			attachmentsInspected = true;
		}
		req.onLine?.(line);
	};
	const prompt =
		(directive !== undefined ? `${directive}\n\n` : "") + (diverged ? (req.seedPrompt ?? req.prompt) : req.prompt);
	const timeoutMsEffective = deps.config.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
	const attempt = async (
		resumeConversationId: string | undefined,
		resumed: boolean,
		turnPrompt: string,
		// Diagnostics-only label (independent of `resumed`, which is the
		// unrelated D5/R7 ordinary-continuation flag): true exactly for the
		// second call() below, triggered by the PRE-EXISTING canResume
		// mechanism — never inferred from `resumed`.
		isRecoveryAttempt: boolean,
	): Promise<TurnResult> => {
		// Exclusive attempt identity: callId + 1-based attempt index. Neither
		// a retry of THIS call nor a concurrent, unrelated call sharing this
		// workdir can ever open the same attempt log path.
		const attemptIndex = attemptDiagnostics.length + 1;
		const attemptLogPath = resolveAttemptLogPath(workdir.dir, callId, attemptIndex);
		const tap = createTap(inspectingOnLine, { signal: req.signal, spawnFn: deps.spawnFn });
		let run: SpawnRun;
		try {
			run = await runAgyStream({
				bin: deps.bin,
				prompt: turnPrompt,
				workdir: workdir.dir,
				timeoutMs: timeoutMsEffective,
				model: req.modelArg,
				resumeConversationId,
				logPath: attemptLogPath,
				spawnImpl: tap.spawnImpl,
				promptViaStdin: deps.promptViaStdin ?? true,
				// Cancellation drives the engine's bounded termination chain
				// directly (terminationTrigger "abort", bounded abort hangs),
				// alongside the tap's own kill path above.
				signal: req.signal,
				// Internal/test seams (config → engine); undefined → engine
				// termination constants.
				...(deps.config.terminationGraceMs !== undefined
					? { terminationGraceMs: deps.config.terminationGraceMs }
					: {}),
				...(deps.config.terminationSettleMs !== undefined
					? { terminationSettleMs: deps.config.terminationSettleMs }
					: {}),
			});
		} catch (err) {
			// Pre-spawn failure: runAgyStream only ever REJECTS synchronously
			// from its own openSync/spawnFn window (near-total fs-unwritable —
			// resolveAttemptLogPath's 3-tier fallback still yielded a path
			// that could not be opened — or the test-only spawnFn injection
			// seam throwing). No child was ever created, so classifyRun's
			// run-based taxonomy does not apply here; ENOENT and every other
			// real process/spawn failure instead RESOLVES normally (via the
			// child's 'error' event) and is classified below like any other
			// run. This must still never surface as a raw, unclassified
			// Error the way every other failure path in this module is
			// wrapped as TurnError — report it honestly instead, reusing the
			// same `Full log:` convention (finalizeDiagnostics degrades to
			// NO_DIAGNOSTICS_LOG when even the summary write fails).
			throw new TurnError({
				retryable: false,
				resume: false,
				message: `agy could not be started for this attempt: ${err instanceof Error ? err.message : String(err)}. Full log: ${finalizeDiagnostics()}`,
			});
		}
		const classification = classifyRun({
			exitCode: run.exitCode,
			log: run.log,
			spawnError: run.spawnError,
			timedOut: run.timedOut,
			stalled: run.stalled,
			// Bounded termination chain settlement: forwarded so the engine
			// can classify the run as termination_unconfirmed (checked BEFORE
			// the timeout family) instead of misreading it as a plain timeout.
			terminationUnconfirmed: run.terminationUnconfirmed,
			terminationTrigger: run.terminationTrigger,
			envelope: run.envelope,
			expectArtifact: false,
		});
		const conversationId = run.conversationId ?? tap.conversationId;
		attemptDiagnostics.push(
			buildAttemptDiagnostic({
				attemptIndex,
				logPath: attemptLogPath,
				mode: isRecoveryAttempt ? "recovery" : "initial",
				resumed,
				conversationId,
				timeoutMsEffective,
				stallMsEffective: DEFAULT_STALL_MS,
				wallElapsedMs: run.elapsedMs,
				exitCode: run.exitCode,
				timedOut: run.timedOut,
				stalled: run.stalled ?? false,
				escalatedSignal: run.escalatedSignal,
				aborted: false, // updated by persistAndThrowAbort when the caller cancels.
				classificationOutcome: classification.outcome,
				classificationReason: classification.reason,
			}),
		);
		return {
			classification,
			run,
			resumed,
			diverged,
			// Placeholder: overridden with the call summary path (the
			// `Full log:` target) at every terminal exit below.
			logPath: attemptLogPath,
			conversationId,
			stagedAttachments: staged.length > 0 ? staged : undefined,
			attachmentsInspected,
		};
	};
	// The initial attempt is NEVER the recovery attempt — whether it starts
	// a fresh conversation or continues a stored one (D5/R7's `resumed`),
	// neither choice is the canResume-triggered second call below.
	//
	// Timeout-recovery PRD slice 2 ("Separate accounting"): `resumed`
	// (passed to `attempt` below and carried on TurnResult/AttemptDiagnostic)
	// keeps its original D5/R7 meaning — ordinary conversation continuation
	// — and is never repurposed. `wasOrdinaryContinuation` names that exact
	// same fact explicitly so the eligibility gate below reads as a policy
	// decision over a named fact, not a reuse of a diagnostics label.
	// `recoveryBudgetConsumed` is a SEPARATE fact, orthogonal to both:
	// true only once this call's one recovery attempt has actually been
	// spawned. Starting fresh or continuing a stored conversation never
	// sets it by itself — only the `attempt(...)` call inside the
	// `canResume` branch below does, exactly once per call.
	const wasOrdinaryContinuation = resumeId !== undefined;
	let recoveryBudgetConsumed = false;
	// Fix 1 (cancellation-before-first-spawn race): req.signal can abort
	// while the awaits above (deps.store.resolve/deps.store.get) are
	// pending. The entry check at the very top of runTurn only catches an
	// abort that already happened before this call started; it cannot see
	// one that raced those awaits. Re-check here, synchronously and with
	// no await between this check and the spawn inside the first
	// `attempt()` call below (attempt()'s own body runs synchronously up
	// to `await runAgyStream(...)`, and runAgyStream's body is itself
	// synchronous up to invoking spawnImpl — see packages/engine/src/spawn.ts),
	// so an abort landing in that window prevents the first child from
	// ever spawning instead of letting it run to its own natural timeout.
	if (req.signal?.aborted) {
		finalizeDiagnostics();
		throw abortError();
	}
	// Per-conversation exclusion lock (timeout-recovery PRD concurrency
	// matrix): ONLY a turn that will RESUME a known conversation id takes
	// the lock — held across the whole attempt loop (success, TurnError,
	// AbortError, and termination_unconfirmed alike) via the finally below.
	// A FRESH conversation takes NO lock: each request creates its own agy
	// conversation, so the same-conversation invariant holds there by
	// construction.
	let conversationLock: ConversationLock | undefined;
	if (resumeId !== undefined) {
		const lockDir = join(resolveStateDir({ override: deps.config.stateDir }), "conversation-locks");
		try {
			conversationLock = await acquireConversationLock(lockDir, resumeId);
		} catch (err) {
			if (err instanceof ConversationBusyError) {
				// Same pattern as the quota gate: a typed, non-retryable
				// TurnError before any spawn. finalizeDiagnostics still runs
				// so the call group gets its summary and stays
				// retention-prunable (a summary-less group never prunes).
				throw new TurnError({
					retryable: false,
					resume: false,
					message: `another agy request is active for this conversation — wait for it to finish and retry. Full log: ${finalizeDiagnostics()}`,
				});
			}
			throw err;
		}
	}
	try {
		let result = await attempt(resumeId, wasOrdinaryContinuation, prompt, false);
		const persistAndThrowAbort = async (): Promise<never> => {
			if (attemptDiagnostics.length > 0) attemptDiagnostics[attemptDiagnostics.length - 1].aborted = true;
			finalizeDiagnostics();
			if (result.conversationId) await deps.store.bind(req.sessionId, result.conversationId, req.hashes);
			throw abortError();
		};
		if (req.signal?.aborted) await persistAndThrowAbort();
		/**
		 * Slice-2/slice-3 boundary (PRD "Rollout, risks, and open decisions"
		 * and "Small implementation slices" #3): there is no concrete,
		 * versioned evidence in this repo about what the agy CLI actually does
		 * when `--conversation` resumes an interrupted turn — a captured
		 * conversation id is not proof that continuing it is safe (PRD
		 * "Recovery safety and termination"). Until that evidence exists,
		 * automatic recovery stays restricted to attempts that did NOT
		 * continue an existing conversation (unchanged from pre-slice-2
		 * behavior). This restriction is temporal and intentionally
		 * independent of `recoveryBudgetConsumed` above: lifting it is slice
		 * 3's job once verified CLI resume-safety evidence exists, not an
		 * accounting fix.
		 */
		const RECOVERY_RESTRICTED_TO_NEW_CONVERSATIONS = true;
		// Fix 2 (diagnostic-only — does NOT touch canResume/eligibility below):
		// the policy restriction is only the ACTUAL reason recovery did not
		// happen when a usable conversation id was available to resume with.
		// Without one, the honest cause is the missing id, not the slice-3
		// restriction — reporting the restriction here would mask the more
		// specific, more actionable cause. `conversationId !== undefined` is
		// the same "usable id" test mapClassification already applies for its
		// own canResume/no-id branches (packages/opencode-adapter/src/errors.ts
		// line ~106), reused here rather than reinvented so the two modules
		// never disagree on what counts as usable.
		const recoveryBlockedByPolicy =
			RECOVERY_RESTRICTED_TO_NEW_CONVERSATIONS && wasOrdinaryContinuation && result.conversationId !== undefined;
		// D5 resume-once: only the timeout family, only with a captured id,
		// only while this call's recovery budget is unspent, and only when the
		// slice-3 safety restriction above does not block it. The pre-slice-2
		// gate used `!result.resumed` here; for the very first attempt that
		// happened to equal `wasOrdinaryContinuation`, but conflating the two
		// left no way to ever grant a continuing conversation the same
		// recovery opportunity once slice 3 lifts the restriction.
		const canResume =
			result.classification.outcome === "timeout" &&
			!recoveryBudgetConsumed &&
			result.conversationId !== undefined &&
			!recoveryBlockedByPolicy;
		let recoveryAttempted = false;
		if (canResume) {
			req.onResume?.();
			// Cancellation never authorizes recovery: re-check right before the
			// second spawn, not only once before this whole block — onResume is
			// a caller-supplied callback that could itself trigger an abort
			// synchronously, and the earlier check above cannot see that.
			if (req.signal?.aborted) await persistAndThrowAbort();
			recoveryBudgetConsumed = true;
			recoveryAttempted = true;
			// THIS is the recovery attempt (mode "recovery" in the diagnostic
			// record) — the pre-existing resume-once mechanic the whole PRD is
			// about, now gated by the explicit facts above instead of reusing
			// `resumed`.
			result = await attempt(result.conversationId, true, prompt, true);
			if (req.signal?.aborted) await persistAndThrowAbort();
		}
		if (result.classification.outcome === "success") {
			if (result.conversationId) await deps.store.bind(req.sessionId, result.conversationId, req.hashes);
			return { ...result, logPath: finalizeDiagnostics() };
		}
		// v2: drop ONLY the failed binding; without a captured id (defensive),
		// rebind falls back to dropping the whole session.
		if (result.resumed) await deps.store.rebind(req.sessionId, result.conversationId);
		throw new TurnError(
			mapClassification(result.classification, {
				logPath: finalizeDiagnostics(),
				conversationId: result.conversationId,
				resumed: result.resumed,
				// Honest, distinct denial facts (timeout-recovery PRD slice 2,
				// "Actionable terminal errors"): errors.ts consumes these
				// instead of re-deriving eligibility itself from `resumed`, so
				// the decision has exactly one source of truth (this function).
				recoveryAttempted,
				recoveryBlockedByPolicy,
				detail: result.run.envelope?.error,
			}),
		);
	} finally {
		// Every exit path releases the conversation lock — never throwing
		// over a TurnError/AbortError, and never leaking a lock across a
		// forced settlement.
		conversationLock?.release();
	}
}
