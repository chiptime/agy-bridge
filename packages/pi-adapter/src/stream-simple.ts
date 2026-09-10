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
 * Turn orchestration (divergence re-seed, resume-once, abort, session
 * persistence) lives in turn.ts (runTurn); this module maps its TurnResult
 * / TurnError / TurnAborted onto the pi event protocol: failures finalize
 * {type:"error", reason:"error"} terminals with retryability preserved as
 * a visible "(retryable)" marker in errorMessage (pi regex-matches
 * errorMessage for its own retry policy); abort finalizes
 * {type:"error", reason:"aborted"}; the divergence re-seed surfaces as the
 * DIVERGED_NOTICE thinking delta. Run containment: the child's cwd and
 * run.log placement are turn.ts's (deps.workdir ?? options.cwd, scratch
 * dirs under deps.logRoot — never the project).
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
import type { AgyUsage } from "agy-bridge-engine";
import type { spawn } from "node:child_process";
import type { BridgeState } from "./lifecycle";
import { mapAbort, type FinalizeReason } from "./errors";
import { formatStepUpdate } from "./progress";
import type { SessionStore } from "./session-store";
import { DIVERGED_NOTICE, runTurn, TurnAborted, TurnError } from "./turn";

/** Turn budget default (owned by turn.ts); re-exported for API stability. */
export { DEFAULT_TURN_TIMEOUT_MS } from "./turn";

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
	/**
	 * Additive engine seam: the prompt rides the child's stdin, never
	 * argv. Default off = the frozen argv transport (--print <prompt>).
	 */
	promptViaStdin?: boolean;
	/** Lifecycle registry (R6); forwarded to runTurn when present. */
	state?: BridgeState;
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
 * Build the streamSimple closure. Captures the session store and config
 * resolved at extension load; every call runs one turn (turn.ts runTurn)
 * and maps its outcome onto the pi event protocol.
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
				const modelArg = resolveModelArg(model, options?.reasoning);
				const result = await runTurn(
					{
						bin: deps.bin,
						store: deps.store,
						...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
						...(deps.workdir !== undefined ? { workdir: deps.workdir } : {}),
						...(deps.logRoot !== undefined ? { logRoot: deps.logRoot } : {}),
					...(deps.spawnFn !== undefined ? { spawnFn: deps.spawnFn } : {}),
					...(deps.promptViaStdin !== undefined ? { promptViaStdin: deps.promptViaStdin } : {}),
					...(deps.state !== undefined ? { state: deps.state } : {}),
					},
					{
						context,
						options,
						...(modelArg !== undefined ? { modelArg } : {}),
						onStep: (step) => appendThinking(formatStepUpdate(step)),
						onDiverged: () => appendThinking(DIVERGED_NOTICE),
					},
				);
				appendText(normalizeResponseText(result.run.envelope?.response ?? ""));
				toPiUsage(result.run.envelope?.usage, partial.usage);
				finalizeStop();
			} catch (err) {
				if (err instanceof TurnAborted) {
					// turn.ts already persisted the tapped conversation id.
					const abort = mapAbort();
					finalizeError(abort.finalize, abort.message);
				} else if (err instanceof TurnError) {
					finalizeError(
						err.mapping.finalize,
						err.mapping.message + (err.mapping.retryable ? " (retryable)" : ""),
					);
				} else {
					// Defensive: an unexpected bridge bug must still end the stream
					// with a typed terminal instead of hanging pi's consumer.
					finalizeError("error", `agy bridge failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			} finally {
				stream.end();
			}
		})();
		return stream;
	};
}
