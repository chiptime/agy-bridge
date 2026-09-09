/**
 * LanguageModelV3 implementation (spec R4, design D5/D6) — the empirically
 * confirmed native model path of opencode 1.18.x, which passes
 * specificationVersion "v3" models through untouched (v2 models run behind
 * a compat proxy with a warning). This class stays a PURE MAPPER onto the
 * V3 stream-part union: turn.ts owns run/resume orchestration; here each
 * live NDJSON step_update becomes a reasoning-delta inside ONE reasoning
 * block (no text — agy has no token streaming), the final envelope becomes
 * text-start/delta(full response)/end + finish(stop) with nested V3 usage,
 * and finish fires even on empty responses. Terminal failures mapped by
 * errors.ts arrive as an error part carrying APICallError retryability;
 * AbortError escapes the stream so the AI SDK's cancellation contract
 * holds. doGenerate drains doStream (D6) — one code path.
 */
import {
	APICallError,
	type LanguageModelV3,
	type LanguageModelV3CallOptions,
	type LanguageModelV3Content,
	type LanguageModelV3FinishReason,
	type LanguageModelV3GenerateResult,
	type LanguageModelV3StreamPart,
	type LanguageModelV3StreamResult,
	type LanguageModelV3Usage,
	type SharedV3ProviderOptions,
	type SharedV3Warning,
} from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import type { spawn } from "node:child_process";
import type { AgyUsage } from "agy-bridge-engine";
import { runTurn, TurnError, type TurnDeps, type TurnRequest, type TurnResult } from "./turn";
import type { AgyAdapterConfig } from "./config";
import type { SessionStore } from "./session-store";
import { mapMessages, type PromptMessage } from "./messages";
import { resolveModel } from "./models";

/** Injectable turn runner — tests fake this to pin the mapping in isolation. */
export type TurnRunner = (deps: TurnDeps, req: TurnRequest) => Promise<TurnResult>;

export interface AgyLanguageModelDeps {
	/** Provider id; opencode passes the config key, the reserved default is "agy". */
	provider: string;
	/** Model id as handed to languageModel(id); resolved through the registry. */
	modelId: string;
	config: AgyAdapterConfig;
	store: SessionStore;
	/** agy binary; defaults to "agy" (resolved from PATH by the runner). */
	bin?: string;
	/** Test seam; defaults to the real runTurn wired with the deps below. */
	run?: TurnRunner;
	spawnFn?: TurnDeps["spawnFn"];
}

/** Session context surfaced by the plugin's chat.params hook (D3/OQ1). */
interface AgySessionContext {
	sessionId?: string;
	worktree?: string;
}

/** Read providerOptions.agy (the plugin channel); string fields validated. */
function readSessionContext(providerOptions?: SharedV3ProviderOptions): AgySessionContext {
	const agy = providerOptions?.["agy"];
	if (typeof agy !== "object" || agy === null) return {};
	const sessionId = (agy as Record<string, unknown>)["sessionId"];
	const worktree = (agy as Record<string, unknown>)["worktree"];
	return {
		sessionId: typeof sessionId === "string" && sessionId !== "" ? sessionId : undefined,
		worktree: typeof worktree === "string" && worktree !== "" ? worktree : undefined,
	};
}

const EMPTY_USAGE: LanguageModelV3Usage = {
	inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
	outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

/** Map agy's flat token accounting onto the nested V3 usage shape. */
function toV3Usage(usage: AgyUsage | undefined): LanguageModelV3Usage {
	if (!usage) return EMPTY_USAGE;
	return {
		inputTokens: {
			total: usage.input_tokens,
			noCache: undefined,
			cacheRead: usage.cache_read_tokens || undefined,
			cacheWrite: undefined,
		},
		outputTokens: {
			total: usage.output_tokens,
			text: undefined,
			reasoning: usage.thinking_tokens || undefined,
		},
		raw: { total_tokens: usage.total_tokens },
	};
}

const STOP: LanguageModelV3FinishReason = { unified: "stop", raw: undefined };

/** Known narrating fields first; unknown payloads degrade to compact JSON. */
function stepSummary(line: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return `${line}\n`;
	}
	if (typeof parsed !== "object" || parsed === null) return `${line}\n`;
	const rec = parsed as Record<string, unknown>;
	for (const key of ["step", "message", "description", "title", "status", "detail"]) {
		const v = rec[key];
		if (typeof v === "string" && v !== "") return `${v}\n`;
	}
	const rest = { ...rec };
	delete rest.event;
	const compact = JSON.stringify(rest);
	return `${compact === "{}" ? "(step update)" : compact}\n`;
}

const REASONING_ID = "agy-progress";
const TEXT_ID = "agy-response";

/**
 * The agy LanguageModelV3 (R4). Constructed per model id by the provider
 * factory; every doStream/doGenerate call runs one turn through the
 * injected (default: real) runner.
 */
export class AgyLanguageModel implements LanguageModelV3 {
	readonly specificationVersion = "v3" as const;
	readonly provider: string;
	/** Resolved full registry id (e.g. "agy/default"). */
	readonly modelId: string;
	readonly supportedUrls: Record<string, RegExp[]> = {};
	private readonly modelArg: string | undefined;
	private readonly deps: AgyLanguageModelDeps;

	constructor(deps: AgyLanguageModelDeps) {
		this.deps = deps;
		this.provider = deps.provider;
		const resolved = resolveModel(deps.modelId, deps.config.models);
		this.modelId = resolved.id;
		this.modelArg = resolved.modelArg;
	}

	async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
		// R5 wiring: the prompt is reduced to the last user turn; the system
		// text is prepended only when this session has no stored conversation.
		const { deps, modelArg } = this;
		const ctx = readSessionContext(options.providerOptions);
		const sessionId = ctx.sessionId ?? randomUUID();
		const isNewConversation = (await deps.store.get(sessionId)) === undefined;
		// Boundary cast (documented in messages.ts): V3 prompt messages are a
		// closed union without index signatures; mapMessages only reads
		// role/content/part.type and validates shapes at runtime.
		const mapping = mapMessages(options.prompt as unknown as PromptMessage[], { isNewConversation });
		const warnings: SharedV3Warning[] = mapping.warnings.map((w) => ({ type: "other", message: w }));
		const run = deps.run ?? runTurn;
		const stream = new ReadableStream<LanguageModelV3StreamPart>({
			async start(controller) {
				let reasoningOpen = false;
				const openReasoning = () => {
					if (!reasoningOpen) {
						controller.enqueue({ type: "reasoning-start", id: REASONING_ID });
						reasoningOpen = true;
					}
				};
				try {
					controller.enqueue({ type: "stream-start", warnings });
					const result = await run(
						{
							bin: deps.bin ?? "agy",
							config: deps.config,
							store: deps.store,
							worktree: ctx.worktree,
							spawnFn: deps.spawnFn,
						},
						{
							prompt: mapping.prompt,
							modelArg,
							sessionId,
							signal: options.abortSignal,
							onLine: (line) => {
								// Live progress (D1 tap): every step_update is a
								// reasoning delta in the single status block.
								if (!line.includes('"step_update"')) return;
								openReasoning();
								controller.enqueue({ type: "reasoning-delta", id: REASONING_ID, delta: stepSummary(line) });
							},
							onResume: () => {
								// D5: attempt 2 is invisible downstream except here.
								openReasoning();
								controller.enqueue({
									type: "reasoning-delta",
									id: REASONING_ID,
									delta: "(agy timed out mid-turn; resuming the captured conversation once)\n",
								});
							},
						},
					);
					if (reasoningOpen) controller.enqueue({ type: "reasoning-end", id: REASONING_ID });
					const text = result.run.envelope?.response ?? "";
					if (text !== "") {
						controller.enqueue({ type: "text-start", id: TEXT_ID });
						controller.enqueue({ type: "text-delta", id: TEXT_ID, delta: text });
						controller.enqueue({ type: "text-end", id: TEXT_ID });
					}
					// R4: finish(stop) fires even on an empty response.
					controller.enqueue({
						type: "finish",
						usage: toV3Usage(result.run.envelope?.usage),
						finishReason: STOP,
					});
					controller.close();
				} catch (err) {
					// R6: terminal/quota failures carry the mapped semantics as an
					// error part; aborts (and anything unmapped) propagate raw.
					if (err instanceof TurnError) {
						if (reasoningOpen) controller.enqueue({ type: "reasoning-end", id: REASONING_ID });
						controller.enqueue({
							type: "error",
							error: new APICallError({
								message: err.mapping.message,
								url: "agy://turn",
								requestBodyValues: {},
								isRetryable: err.mapping.retryable,
							}),
						});
						controller.close();
						return;
					}
					controller.error(err);
				}
			},
		});
		return { stream };
	}

	/** D6: drain doStream — one code path for both call shapes. */
	async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
		const { stream } = await this.doStream(options);
		const reader = stream.getReader();
		let text = "";
		let usage = EMPTY_USAGE;
		let finishReason = STOP;
		const warnings: SharedV3Warning[] = [];
		const content: LanguageModelV3Content[] = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			switch (value.type) {
				case "stream-start":
					warnings.push(...value.warnings);
					break;
				case "text-delta":
					text += value.delta;
					break;
				case "finish":
					usage = value.usage;
					finishReason = value.finishReason;
					break;
				case "error":
					throw value.error;
				default:
					break;
			}
		}
		if (text !== "") content.push({ type: "text", text });
		return { content, finishReason, usage, warnings };
	}
}
