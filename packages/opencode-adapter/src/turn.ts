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
	logPath: string;
	conversationId?: string;
}

export interface TurnRequest {
	prompt: string;
	/** Resolved --model value; undefined means agy picks its own default. */
	modelArg?: string;
	sessionId: string;
	signal?: AbortSignal;
	/** Live NDJSON stdout line tap → status parts (D1). */
	onLine?: (line: string) => void;
	/** Announces the single resume attempt (D5 status part). */
	onResume?: () => void;
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
	const logPath = `${workdir.dir}/run.log`;
	const resumeId = await deps.store.get(req.sessionId);
	const attempt = async (resumeConversationId: string | undefined, resumed: boolean): Promise<TurnResult> => {
		const tap = createTap(req.onLine, { signal: req.signal, spawnFn: deps.spawnFn });
		const run = await runAgyStream({
			bin: deps.bin,
			prompt: req.prompt,
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
			logPath,
			conversationId: run.conversationId ?? tap.conversationId,
		};
	};
	let result = await attempt(resumeId, resumeId !== undefined);
	const persistAndThrowAbort = async (): Promise<never> => {
		if (result.conversationId) await deps.store.bind(req.sessionId, result.conversationId);
		throw abortError();
	};
	if (req.signal?.aborted) await persistAndThrowAbort();
	// D5 resume-once: only the timeout family, only with a captured id, and
	// only when this run was not already the one resume attempt.
	const canResume =
		result.classification.outcome === "timeout" && !result.resumed && result.conversationId !== undefined;
	if (canResume) {
		req.onResume?.();
		result = await attempt(result.conversationId, true);
		if (req.signal?.aborted) await persistAndThrowAbort();
	}
	if (result.classification.outcome === "success") {
		if (result.conversationId) await deps.store.bind(req.sessionId, result.conversationId);
		return result;
	}
	if (result.resumed) await deps.store.rebind(req.sessionId);
	throw new TurnError(
		mapClassification(result.classification, {
			logPath,
			conversationId: result.conversationId,
			resumed: result.resumed,
			detail: result.run.envelope?.error,
		}),
	);
}
