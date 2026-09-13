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
	classifyRun,
	decidePool,
	parseSnapshotDir,
	runAgyStream,
	type Classification,
	type SpawnRun,
} from "agy-bridge-engine";
import type { spawn } from "node:child_process";
import { dirname } from "node:path";
import type { AgyAdapterConfig } from "./config";
import type { SessionStore } from "./session-store";
import { createTap } from "./stream-tap";
import { prepareWorkdir, pruneScratch } from "./workdir";
import { mapClassification, type ErrorMapping } from "./errors";

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
}

/** Terminal turn failure carrying the mapped provider semantics (R6). */
export class TurnError extends Error {
	constructor(public readonly mapping: ErrorMapping) {
		super(mapping.message);
		this.name = "TurnError";
	}
}

const NO_LOG = "(no run log; the run was rejected before spawn)";

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
	if (workdir.scratch) pruneScratch(dirname(workdir.dir));
	// Fire-and-forget 30-day retention: never blocks or fails a turn.
	void deps.store.prune().catch(() => {});
	const logPath = `${workdir.dir}/run.log`;
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
	const prompt = diverged ? (req.seedPrompt ?? req.prompt) : req.prompt;
	const attempt = async (
		resumeConversationId: string | undefined,
		resumed: boolean,
		turnPrompt: string,
	): Promise<TurnResult> => {
		const tap = createTap(req.onLine, { signal: req.signal, spawnFn: deps.spawnFn });
		const run = await runAgyStream({
			bin: deps.bin,
			prompt: turnPrompt,
			workdir: workdir.dir,
			timeoutMs: deps.config.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
			model: req.modelArg,
			resumeConversationId,
			logPath,
			spawnImpl: tap.spawnImpl,
		});
		const classification = classifyRun({
			exitCode: run.exitCode,
			log: run.log,
			spawnError: run.spawnError,
			timedOut: run.timedOut,
			stalled: run.stalled,
			envelope: run.envelope,
			expectArtifact: false,
		});
		return {
			classification,
			run,
			resumed,
			diverged,
			logPath,
			conversationId: run.conversationId ?? tap.conversationId,
		};
	};
	let result = await attempt(resumeId, resumeId !== undefined, prompt);
	const persistAndThrowAbort = async (): Promise<never> => {
		if (result.conversationId) await deps.store.bind(req.sessionId, result.conversationId, req.hashes);
		throw abortError();
	};
	if (req.signal?.aborted) await persistAndThrowAbort();
	// D5 resume-once: only the timeout family, only with a captured id, and
	// only when this run was not already the one resume attempt.
	const canResume =
		result.classification.outcome === "timeout" && !result.resumed && result.conversationId !== undefined;
	if (canResume) {
		req.onResume?.();
		result = await attempt(result.conversationId, true, prompt);
		if (req.signal?.aborted) await persistAndThrowAbort();
	}
	if (result.classification.outcome === "success") {
		if (result.conversationId) await deps.store.bind(req.sessionId, result.conversationId, req.hashes);
		return result;
	}
	// v2: drop ONLY the failed binding; without a captured id (defensive),
	// rebind falls back to dropping the whole session.
	if (result.resumed) await deps.store.rebind(req.sessionId, result.conversationId);
	throw new TurnError(
		mapClassification(result.classification, {
			logPath,
			conversationId: result.conversationId,
			resumed: result.resumed,
			detail: result.run.envelope?.error,
		}),
	);
}
