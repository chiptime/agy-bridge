/**
 * Turn orchestration for pi turns (specs R3, R7, R8) — extracted from the
 * C2 streamSimple bridge so stream-simple.ts owns ONLY the pi event
 * protocol. One runTurn call = session lookup → divergence decision →
 * at most two runAgyStream attempts (a second attempt only for the
 * timeout family, resuming the captured conversation id exactly once):
 *
 * Divergence policy (decided BEFORE any spawn):
 * - no stored entry → fresh agy conversation, last-user-turn prompt;
 * - stored entry WITHOUT hashes (pre-upgrade) → adopt once and treat the
 *   turn as linear (resuming preserves agy's context), then baseline;
 * - stored hashes a PREFIX of the incoming hashes → linear continuation
 *   via --conversation;
 * - otherwise (earlier messages edited/deleted/reordered) → DIVERGED:
 *   fresh agy conversation with the engine-rendered bounded seed, the
 *   onDiverged hook fires (the host renders DIVERGED_NOTICE), and the
 *   new conversation id + incoming hashes become the baseline.
 *
 * Success binds the session mapping (R5 key `options.sessionId ?? cwd`);
 * a failed resumed attempt rebinds so the next turn runs fresh; every
 * other failure throws TurnError carrying the mapped pi semantics.
 * Abort SIGTERMs the child through the stream tap, persists the tapped
 * conversation id, then throws TurnAborted.
 *
 * Spawn boundary: the child's cwd is exactly `deps.workdir ??
 * options.cwd ?? process.cwd()`; `--add-dir` only ever carries that same
 * authority value. The prompt travels argv by default (frozen transport)
 * or — with deps.promptViaStdin — on the child's stdin, never argv.
 */
import {
	classifyRun,
	hashesArePrefix,
	messageHashes,
	parseStreamLine,
	renderSeed,
	runAgyStream,
	type Classification,
	type SpawnRun,
} from "agy-bridge-engine";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { mapClassification, type ErrorMapping } from "./errors";
import { mapPiPrompt, toPromptMessages } from "./messages";
import { sessionKey, type SessionStore } from "./session-store";

/** Matches the plugin-era explore budget documented in the engine (1230s). */
export const DEFAULT_TURN_TIMEOUT_MS = 1_230_000;

/** Host status line for the divergence re-seed (R7) — rendered by stream-simple as a thinking delta. */
export const DIVERGED_NOTICE = "⟲ history diverged — new agy conversation seeded\n";

/** One engine attempt: classification + captured run + resume bookkeeping. */
interface AttemptResult {
	classification: Classification;
	run: SpawnRun;
	resumed: boolean;
	conversationId?: string;
}

export interface TurnResult extends AttemptResult {
	/** v1.1: the visible thread diverged from agy's history; a fresh, seeded conversation was started. */
	diverged: boolean;
	/** Absolute path of this turn's run.log (fresh agy-run-* scratch dir under deps.logRoot). */
	logPath: string;
	/** The prompt actually forwarded this turn (post divergence/seed decision). */
	prompt: string;
}

export interface TurnRequest {
	/** pi Context (systemPrompt + the full visible thread); reduced to the last user turn. */
	context: Context;
	/** pi SimpleStreamOptions: sessionId / cwd (session key), signal (abort). */
	options?: SimpleStreamOptions;
	/** Resolved --model value; undefined means agy picks its own default. */
	modelArg?: string;
	/** Live step_update payloads (the host narrates them as progress). */
	onStep?: (step: Record<string, unknown>) => void;
	/** Announces the divergence re-seed (the host renders DIVERGED_NOTICE). */
	onDiverged?: () => void;
}

export interface TurnDeps {
	/** agy binary (config.agyBin). */
	bin: string;
	store: SessionStore;
	/** Per-attempt hard cap; default DEFAULT_TURN_TIMEOUT_MS. */
	timeoutMs?: number;
	/** Child cwd override; default the pi turn's cwd (options.cwd ?? process.cwd()). */
	workdir?: string;
	/** Scratch root for per-turn run.log dirs; default os.tmpdir(). */
	logRoot?: string;
	/** Injectable spawn for tests (fed to the stream tap). */
	spawnFn?: typeof spawn;
	/**
	 * Additive engine seam: the prompt rides the child's stdin, never
	 * argv. Default off = the frozen argv transport (--print <prompt>).
	 */
	promptViaStdin?: boolean;
}

/** Terminal turn failure carrying the mapped pi error semantics (errors.ts). */
export class TurnError extends Error {
	constructor(public readonly mapping: ErrorMapping) {
		super(mapping.message);
		this.name = "TurnError";
	}
}

/** The caller's signal aborted the turn; the tapped conversation id was already persisted. */
export class TurnAborted extends Error {
	constructor() {
		super("agy turn aborted");
		this.name = "TurnAborted";
	}
}

/**
 * stdout tap for live progress and abort control (ported from the proven
 * opencode stream-tap): attaches a second 'data' listener on child.stdout
 * INSIDE the spawnImpl call — the same synchronous tick in which
 * runAgyStream later attaches its readline — so Node broadcasts every
 * chunk to both consumers and no bytes are lost. The wrapper retains the
 * ChildProcess so an abort can SIGTERM it; the engine then resolves
 * SpawnRun normally and the tapped conversationId survives as the resume
 * handle. One tap per run attempt: resume attempts create a fresh tap.
 */
interface StreamTap {
	spawnImpl: typeof spawn;
	abort(): void;
	readonly conversationId: string | undefined;
}

function createTap(opts: {
	signal?: AbortSignal;
	spawnFn?: typeof spawn;
	onStep: (step: Record<string, unknown>) => void;
}): StreamTap {
	const spawnFn = opts.spawnFn ?? spawn;
	let child: ChildProcess | undefined;
	let buffer = "";
	let conversationId: string | undefined;
	// Inner step_update payload of a stream-json line, when present.
	const stepUpdateOf = (line: string): Record<string, unknown> | undefined => {
		try {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed === "object" && parsed !== null) {
				const inner = (parsed as Record<string, unknown>)["step_update"];
				if (typeof inner === "object" && inner !== null) return inner as Record<string, unknown>;
			}
		} catch {
			/* not JSON — nothing to narrate */
		}
		return undefined;
	};
	const consume = (line: string) => {
		if (line === "") return;
		const got = parseStreamLine(line);
		if (got.conversationId !== undefined) conversationId = got.conversationId;
		const step = stepUpdateOf(line);
		if (step !== undefined) opts.onStep(step);
	};
	const tap: StreamTap = {
		// Attach the tap listener synchronously at spawn time, before the
		// engine's readline: chunk broadcast then reaches both consumers.
		spawnImpl: ((...args: Parameters<typeof spawn>) => {
			child = spawnFn(...args);
			child.stdout?.on("data", (chunk: Buffer) => {
				buffer += chunk.toString("utf8");
				let nl: number;
				while ((nl = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 1);
					consume(line);
				}
			});
			// Mirror readline: a final unterminated line still counts on exit.
			child.on("exit", () => {
				if (buffer !== "") {
					const rest = buffer;
					buffer = "";
					consume(rest);
				}
			});
			return child;
		}) as typeof spawn,
		abort: () => {
			if (child && !child.killed) child.kill("SIGTERM");
		},
		get conversationId() {
			return conversationId;
		},
	};
	opts.signal?.addEventListener("abort", () => tap.abort(), { once: true });
	return tap;
}

/**
 * Run one pi turn: divergence decision, at most two engine attempts,
 * session persistence, and the typed terminal (TurnResult on success,
 * TurnError / TurnAborted otherwise — stream-simple maps both onto the
 * AssistantMessageEvent error terminal).
 */
export async function runTurn(deps: TurnDeps, req: TurnRequest): Promise<TurnResult> {
	const signal = req.options?.signal;
	if (signal?.aborted) throw new TurnAborted();
	// Session key (R5): explicit sessionId, else the pi turn's cwd.
	const options = req.options;
	const sid = options?.sessionId !== undefined && options.sessionId !== "" ? options.sessionId : undefined;
	const optionsCwd = (options as { cwd?: string } | undefined)?.cwd;
	const cwd = optionsCwd ?? process.cwd();
	const key = sessionKey(sid, cwd);
	// Workdir authority: only deps/config or the pi turn's own cwd — never
	// anything derived from prompt content (threat row b).
	const workdir = deps.workdir ?? cwd;
	// Prompt reduction + divergence decision (R4/R7): the stored hash
	// baseline picks linear resume vs fresh re-seed; hash-less entries are
	// adopted once.
	const incoming = toPromptMessages(req.context.messages);
	const hashes = messageHashes(incoming);
	const entry = await deps.store.getEntry(key);
	let diverged = false;
	let resumeId: string | undefined;
	if (entry === undefined) {
		resumeId = undefined; // first turn: fresh, last-user-turn only
	} else if (entry.hashes === undefined) {
		resumeId = entry.conversationId; // unknown baseline: adopt once, then protected
	} else if (hashesArePrefix(entry.hashes, hashes)) {
		resumeId = entry.conversationId; // linear continuation
	} else {
		diverged = true; // edited/deleted/reordered history → fresh re-seed
		req.onDiverged?.();
	}
	const isNewConversation = entry === undefined || diverged;
	const seedInfo = diverged ? renderSeed(incoming) : undefined;
	const mapping = mapPiPrompt(req.context, { isNewConversation, seed: seedInfo?.seed });
	// Per-turn scratch dir keeps run.log out of the user's project.
	const logPath = join(mkdtempSync(join(deps.logRoot ?? tmpdir(), "agy-run-")), "run.log");
	const attempt = async (resumeConversationId: string | undefined, resumed: boolean): Promise<AttemptResult> => {
		const tap = createTap({
			signal,
			spawnFn: deps.spawnFn,
			onStep: (step) => req.onStep?.(step),
		});
		const run = await runAgyStream({
			bin: deps.bin,
			prompt: mapping.prompt,
			workdir,
			timeoutMs: deps.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
			model: req.modelArg,
			resumeConversationId,
			logPath,
			spawnImpl: tap.spawnImpl,
			...(deps.promptViaStdin !== undefined ? { promptViaStdin: deps.promptViaStdin } : {}),
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
		return { classification, run, resumed, conversationId: run.conversationId ?? tap.conversationId };
	};
	const resumeAttemptId = diverged ? undefined : entry?.conversationId;
	let result = await attempt(resumeAttemptId, resumeAttemptId !== undefined);
	const persistAndThrowAbort = async (conversationId: string | undefined): Promise<never> => {
		if (conversationId !== undefined) await deps.store.bind(key, conversationId, hashes);
		throw new TurnAborted();
	};
	if (signal?.aborted) await persistAndThrowAbort(result.conversationId);
	// R8 resume-once: only the timeout family, only with a captured id, and
	// only when this run was not already the one resume.
	const canResume =
		result.classification.outcome === "timeout" && !result.resumed && result.conversationId !== undefined;
	if (canResume) {
		result = await attempt(result.conversationId, true);
		if (signal?.aborted) await persistAndThrowAbort(result.conversationId);
	}
	if (result.classification.outcome === "success") {
		if (result.conversationId !== undefined) await deps.store.bind(key, result.conversationId, hashes);
		return { ...result, diverged, logPath, prompt: mapping.prompt };
	}
	// Terminal failure: a failed resumed attempt rebinds so the next turn
	// runs fresh; every family maps onto the pi error terminal.
	if (result.resumed) await deps.store.rebind(key);
	throw new TurnError(
		mapClassification(result.classification, {
			logPath,
			conversationId: result.conversationId,
			resumed: result.resumed,
			detail: result.run.envelope?.error,
		}),
	);
}
