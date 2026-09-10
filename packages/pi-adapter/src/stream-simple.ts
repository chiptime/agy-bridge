/**
 * The streamSimple event bridge (spec R3) — the heart of the pi adapter.
 *
 * pi's StreamFunction contract returns an AssistantMessageEventStream
 * SYNCHRONOUSLY (never a Promise): the stream is built via
 * createAssistantMessageEventStream(), returned immediately, and driven by
 * a detached async IIFE that pushes events and calls stream.end() in a
 * finally. Every event carries ONE shared, mutated-in-place `partial`
 * AssistantMessage: step_update NDJSON lines become thinking deltas
 * (contentIndex 0, rendered through formatStepUpdate), and the final
 * result envelope becomes ONE text block (contentIndex 1) followed by
 * done{reason:"stop"} with the envelope's usage mapped onto pi's Usage
 * (cost stays zero — subscription quota, not billing).
 *
 * Turn integration around the single engine run (runAgyStream):
 * - session store lookup/bind keyed `options.sessionId ?? cwd` (R5);
 * - prompt reduction + divergence re-seed (R4/R7): the stored hash
 *   baseline decides linear resume (--conversation) vs fresh conversation
 *   with the system text once and the engine-rendered seed block between
 *   system and user; hash-less entries are adopted once;
 * - resume-once on the timeout family (R8): a first timeout with a
 *   captured conversation id resumes exactly once; repeat failure (or no
 *   id) is terminal with the run.log path;
 * - abort via options.signal SIGTERMs the tapped child (the engine still
 *   resolves; the tapped conversation id is persisted so the next turn
 *   resumes) and finalizes {type:"error", reason:"aborted"};
 * - failures map through mapClassification into {type:"error",
 *   reason:"error"} terminals; retryability is preserved as a visible
 *   "(retryable)" marker in errorMessage (pi regex-matches errorMessage
 *   for its own retry policy).
 *
 * Run containment: the child runs with cwd = the pi turn's cwd (or an
 * explicit deps.workdir) so agy sees the user's project, while run.log
 * lands in a fresh scratch dir under deps.logRoot — never the project.
 */
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
	type ThinkingLevel,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	classifyRun,
	hashesArePrefix,
	messageHashes,
	parseStreamLine,
	renderSeed,
	runAgyStream,
	type AgyUsage,
	type Classification,
	type SpawnRun,
} from "agy-bridge-engine";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapAbort, mapClassification, type FinalizeReason } from "./errors";
import { mapPiPrompt, toPromptMessages } from "./messages";
import { formatStepUpdate } from "./progress";
import { sessionKey, type SessionStore } from "./session-store";

/** Matches the plugin-era explore budget documented in the engine (1230s). */
export const DEFAULT_TURN_TIMEOUT_MS = 1_230_000;

/** Registry convention (models.ts): the default entry passes no --model. */
const DEFAULT_MODEL_ID = "default";

export interface StreamSimpleDeps {
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
	/** Wall-clock seam for the partial timestamp. */
	now?: () => number;
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Map agy's flat token accounting onto pi's Usage (mutated in place; cost stays zero). */
function toPiUsage(u: AgyUsage | undefined, target: Usage): void {
	if (!u) return;
	target.input = u.input_tokens ?? target.input;
	target.output = u.output_tokens ?? target.output;
	target.cacheRead = u.cache_read_tokens ?? target.cacheRead;
	target.totalTokens = u.total_tokens ?? target.input + target.output;
	if (typeof u.thinking_tokens === "number") target.reasoning = u.thinking_tokens;
}

/**
 * v1.1 parity with the opencode sibling: CLI responses may carry CRLF line
 * endings; the pi text contract is LF-only with no trailing whitespace at
 * the very end of the response.
 */
export function normalizeResponseText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

/**
 * Resolve the --model argument for one turn: a thinkingLevelMap entry for
 * the requested level routes to the FULL agy id (the map value); otherwise
 * the bare model id — except the default entry, which omits --model so agy
 * picks its own.
 */
export function resolveModelArg(model: Model<Api>, reasoning: ThinkingLevel | undefined): string | undefined {
	const mapped = reasoning !== undefined ? model.thinkingLevelMap?.[reasoning] : undefined;
	if (typeof mapped === "string") return mapped;
	return model.id === DEFAULT_MODEL_ID ? undefined : model.id;
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

/** One engine attempt: tap + run + classification. */
interface AttemptResult {
	classification: Classification;
	run: SpawnRun;
	resumed: boolean;
	conversationId?: string;
}

/**
 * Build the streamSimple closure. Captures the session store and config
 * resolved at extension load; every call runs one turn through the engine.
 */
export function createStreamSimple(
	deps: StreamSimpleDeps,
): (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream {
	return function streamSimple(model, context, options) {
		const stream = createAssistantMessageEventStream();
		const partial: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage(),
			stopReason: "pending",
			timestamp: deps.now?.() ?? Date.now(),
		};
		// Fire the async turn; return the stream synchronously per pi's contract.
		void (async () => {
			// Block state: at most one thinking (contentIndex 0) then one text
			// block (contentIndex 1) — thinking always precedes text because
			// step_update lines stream during the run and the envelope lands last.
			let thinkingIdx: number | null = null;
			let textIdx: number | null = null;
			const closeThinking = () => {
				if (thinkingIdx === null) return;
				const idx = thinkingIdx;
				thinkingIdx = null;
				stream.push({
					type: "thinking_end",
					contentIndex: idx,
					content: (partial.content[idx] as { type: "thinking"; thinking: string }).thinking,
					partial,
				});
			};
			const appendThinking = (delta: string) => {
				if (thinkingIdx === null) {
					if (textIdx !== null) return; // text is final; late steps cannot reopen
					partial.content.push({ type: "thinking", thinking: "" });
					thinkingIdx = partial.content.length - 1;
					stream.push({ type: "thinking_start", contentIndex: thinkingIdx, partial });
				}
				const block = partial.content[thinkingIdx] as { type: "thinking"; thinking: string };
				block.thinking += delta;
				stream.push({ type: "thinking_delta", contentIndex: thinkingIdx, delta, partial });
			};
			const appendText = (text: string) => {
				closeThinking();
				if (textIdx === null) {
					partial.content.push({ type: "text", text: "" });
					textIdx = partial.content.length - 1;
					stream.push({ type: "text_start", contentIndex: textIdx, partial });
				}
				const block = partial.content[textIdx] as { type: "text"; text: string };
				block.text += text;
				stream.push({ type: "text_delta", contentIndex: textIdx, delta: text, partial });
			};
			const closeText = () => {
				if (textIdx === null) return;
				const idx = textIdx;
				textIdx = null;
				stream.push({
					type: "text_end",
					contentIndex: idx,
					content: (partial.content[idx] as { type: "text"; text: string }).text,
					partial,
				});
			};
			const finalizeStop = () => {
				closeText();
				partial.stopReason = "stop";
				stream.push({ type: "done", reason: "stop", message: partial });
			};
			const finalizeError = (reason: FinalizeReason, message: string) => {
				closeText();
				partial.stopReason = reason;
				partial.errorMessage = message;
				stream.push({ type: "error", reason, error: partial });
			};
			try {
				stream.push({ type: "start", partial });
				const signal = options?.signal;
				if (signal?.aborted) {
					const abort = mapAbort();
					finalizeError(abort.finalize, abort.message);
					return;
				}
				// Session key (R5): explicit sessionId, else the pi turn's cwd.
				const sid = options?.sessionId !== undefined && options.sessionId !== "" ? options.sessionId : undefined;
				const optionsCwd = (options as { cwd?: string } | undefined)?.cwd;
				const cwd = optionsCwd ?? process.cwd();
				const key = sessionKey(sid, cwd);
				const workdir = deps.workdir ?? cwd;
				// Prompt reduction + divergence decision (R4/R7): the stored
				// hash baseline picks linear resume vs fresh re-seed; hash-less
				// entries are adopted once. The DECISION mirrors turn.ts of the
				// opencode adapter; the D1 slice may lift it into a shared module.
				const incoming = toPromptMessages(context.messages);
				const hashes = messageHashes(incoming);
				const entry = await deps.store.getEntry(key);
				const diverged = entry !== undefined && entry.hashes !== undefined && !hashesArePrefix(entry.hashes, hashes);
				const isNewConversation = entry === undefined || diverged;
				const seedInfo = diverged ? renderSeed(incoming) : undefined;
				const mapping = mapPiPrompt(context, { isNewConversation, seed: seedInfo?.seed });
				const modelArg = resolveModelArg(model, options?.reasoning);
				// Per-turn scratch dir keeps run.log out of the user's project.
				const logPath = join(mkdtempSync(join(deps.logRoot ?? tmpdir(), "agy-run-")), "run.log");
				const attempt = async (resumeConversationId: string | undefined, resumed: boolean): Promise<AttemptResult> => {
					const tap = createTap({
						signal,
						spawnFn: deps.spawnFn,
						onStep: (step) => appendThinking(formatStepUpdate(step)),
					});
					const run = await runAgyStream({
						bin: deps.bin,
						prompt: mapping.prompt,
						workdir,
						timeoutMs: deps.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
						model: modelArg,
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
					return { classification, run, resumed, conversationId: run.conversationId ?? tap.conversationId };
				};
				const resumeId = diverged ? undefined : entry?.conversationId;
				const persistAndFinalizeAbort = async (conversationId: string | undefined): Promise<void> => {
					if (conversationId !== undefined) await deps.store.bind(key, conversationId, hashes);
					finalizeError(mapAbort().finalize, mapAbort().message);
				};
				let result = await attempt(resumeId, resumeId !== undefined);
				if (signal?.aborted) {
					await persistAndFinalizeAbort(result.conversationId);
					return;
				}
				// R8 resume-once: only the timeout family, only with a captured
				// id, and only when this run was not already the one resume.
				const canResume =
					result.classification.outcome === "timeout" && !result.resumed && result.conversationId !== undefined;
				if (canResume) {
					result = await attempt(result.conversationId, true);
					if (signal?.aborted) {
						await persistAndFinalizeAbort(result.conversationId);
						return;
					}
				}
				if (result.classification.outcome === "success") {
					if (result.conversationId !== undefined) await deps.store.bind(key, result.conversationId, hashes);
					appendText(normalizeResponseText(result.run.envelope?.response ?? ""));
					toPiUsage(result.run.envelope?.usage, partial.usage);
					finalizeStop();
					return;
				}
				// Terminal failure: a failed resumed attempt rebinds so the next
				// turn runs fresh; every family maps onto the error terminal.
				if (result.resumed) await deps.store.rebind(key);
				const errorMapping = mapClassification(result.classification, {
					logPath,
					conversationId: result.conversationId,
					resumed: result.resumed,
					detail: result.run.envelope?.error,
				});
				finalizeError(
					errorMapping.finalize,
					errorMapping.message + (errorMapping.retryable ? " (retryable)" : ""),
				);
			} catch (err) {
				// Defensive: an unexpected bridge bug must still end the stream
				// with a typed terminal instead of hanging pi's consumer.
				finalizeError("error", `agy bridge failed: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				stream.end();
			}
		})();
		return stream;
	};
}
