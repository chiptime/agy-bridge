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
import { mapMessages, messageHashes, renderSeed, type PromptMessage } from "./messages";
import { AgyAttachmentError, extractAttachments, type ExtractedImage } from "./attachments";
import { resolveModel, type AgyModel } from "./models";

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
	promptViaStdin?: boolean;
}

/** Session context surfaced by the plugin's chat.params hook (D3/OQ1) or host headers. */
export interface AgySessionContext {
	sessionId?: string;
	worktree?: string;
}

/**
 * Read providerOptions.agy (the plugin channel) or host headers; string fields validated.
 * Supports:
 * - direct provider options: providerOptions.agy.sessionId
 * - opencode runtime wrapped: providerOptions.agy.agy.sessionId
 * - host header fallback: headers["x-session-id"], headers["x-session-affinity"]
 */
export function readSessionContext(
	providerOptions?: SharedV3ProviderOptions,
	headers?: Record<string, string | undefined>,
): AgySessionContext {
	const agy = providerOptions?.["agy"];
	const rec = (typeof agy === "object" && agy !== null ? agy : {}) as Record<string, unknown>;
	const nested = (typeof rec["agy"] === "object" && rec["agy"] !== null ? rec["agy"] : {}) as Record<string, unknown>;
	const rawSessionId =
		rec["sessionId"] ??
		nested["sessionId"] ??
		headers?.["x-session-id"] ??
		headers?.["X-Session-Id"] ??
		headers?.["x-session-affinity"];
	const rawWorktree = rec["worktree"] ?? nested["worktree"];
	return {
		sessionId: typeof rawSessionId === "string" && rawSessionId !== "" ? rawSessionId : undefined,
		worktree: typeof rawWorktree === "string" && rawWorktree !== "" ? rawWorktree : undefined,
	};
}

/**
 * Read the effort-variant selection for this call, checking the plausible
 * delivery locations IN ORDER (the exact channel is an OPEN empirical
 * question — the doStream probe records what we resolved per live turn):
 * 1. providerOptions.agy.variant (the plugin channel, mirrors sessionId)
 * 2. providerOptions.agy.agy.variant (the opencode runtime wrapped shape)
 * 3. any top-level field of the call options named "variant"
 * Non-string or empty values degrade to undefined (no variant selected).
 */
export function readVariant(
	options?: Pick<LanguageModelV3CallOptions, "providerOptions"> & Record<string, unknown>,
): string | undefined {
	const rec = (
		typeof options?.providerOptions?.["agy"] === "object" && options.providerOptions?.["agy"] !== null
			? options.providerOptions["agy"]
			: {}
	) as Record<string, unknown>;
	const nested = (typeof rec["agy"] === "object" && rec["agy"] !== null ? rec["agy"] : {}) as Record<string, unknown>;
	const raw = rec["variant"] ?? nested["variant"] ?? options?.["variant"];
	return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/**
 * Direct-payload channel: opencode may merge the SELECTED VARIANT'S PAYLOAD
 * into the call options (the proven antigravity precedent merges
 * thinkingConfig into the request) instead of delivering the variant NAME.
 * A string `agyModelId` arriving this way IS the resolved --model argument;
 * it outranks variant-name resolution because it is one step more concrete.
 */
export function readDirectModelId(
	options?: Pick<LanguageModelV3CallOptions, "providerOptions"> & Record<string, unknown>,
): string | undefined {
	const rec = (
		typeof options?.providerOptions?.["agy"] === "object" && options.providerOptions?.["agy"] !== null
			? options.providerOptions["agy"]
			: {}
	) as Record<string, unknown>;
	const nested = (typeof rec["agy"] === "object" && rec["agy"] !== null ? rec["agy"] : {}) as Record<string, unknown>;
	const raw = rec["agyModelId"] ?? nested["agyModelId"];
	return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/**
 * Map a selected variant onto the --model argument via the registry entry's
 * variants payload ({ agyModelId }). Documented fallbacks, in order:
 * - UNKNOWN variant or no variant → the entry's own modelArg. For a
 *   collapsed base that is the HIGHEST discovered effort, because agy ids
 *   are effort-encoded and a collapsed base has NO exact bare agy id to
 *   spawn (spawning the bare id would target a nonexistent model).
 * - agy/default and flat models keep their modelArg (undefined / full id).
 */
export function resolveVariantModelArg(entry: AgyModel, variant: string | undefined): string | undefined {
	if (variant !== undefined) {
		const payload = entry.variants?.[variant];
		if (typeof payload?.agyModelId === "string" && payload.agyModelId !== "") {
			return payload.agyModelId;
		}
	}
	return entry.modelArg;
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

/**
 * v1.1: CLI responses may carry CRLF line endings; the V3 text contract this
 * adapter emits is LF-only with no trailing whitespace at the very end of
 * the response. Applied once to the FULL response before the text-delta.
 */
export function normalizeResponseText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

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

/** Compact-JSON tail mirroring stepSummary's fallback; guarded so the
 * readable formatter below can never throw, even on hostile payloads. */
function fallbackSummary(step: Record<string, unknown>): string {
	try {
		const compact = JSON.stringify(step);
		return `${compact === "{}" ? "(step update)" : compact}\n`;
	} catch {
		return "(step update)\n";
	}
}

/** Finite duration rendered with exactly one decimal ("0.28" → "0.3s"). */
function duration1s(durationSeconds: number): string {
	return `${durationSeconds.toFixed(1)}s`;
}

/** Collapse newlines/tabs to single spaces, trim, and truncate to maxLen with ellipsis. */
export function sanitizePreview(text: string, maxLen: number = 60): string {
	const collapsed = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
	if (maxLen !== undefined && collapsed.length > maxLen) {
		return `${collapsed.slice(0, maxLen)}…`;
	}
	return collapsed;
}

const CANDIDATE_ENTRIES: ReadonlyArray<{ key: string; label: string }> = [
	{ key: "path", label: "path" },
	{ key: "AbsolutePath", label: "path" },
	{ key: "TargetFile", label: "path" },
	{ key: "file", label: "file" },
	{ key: "command", label: "command" },
	{ key: "CommandLine", label: "command" },
	{ key: "pattern", label: "pattern" },
	{ key: "Pattern", label: "pattern" },
	{ key: "query", label: "query" },
	{ key: "Query", label: "query" },
	{ key: "url", label: "url" },
	{ key: "Url", label: "url" },
];

/** Inspect toolInfo for canonical candidate keys, returning formatted label and sanitized preview. */
export function extractToolParam(toolInfo: unknown): string | undefined {
	if (typeof toolInfo !== "object" || toolInfo === null) return undefined;
	try {
		const rec = toolInfo as Record<string, unknown>;
		// Support real agy tool_info shape: { name: "...", parameters: { ... } }
		const targets: Array<Record<string, unknown>> = [];
		const params = rec["parameters"];
		if (typeof params === "object" && params !== null && !Array.isArray(params)) {
			targets.push(params as Record<string, unknown>);
		}
		const args = rec["args"] ?? rec["arguments"];
		if (typeof args === "object" && args !== null && !Array.isArray(args)) {
			targets.push(args as Record<string, unknown>);
		}
		targets.push(rec);

		for (const target of targets) {
			for (const { key, label } of CANDIDATE_ENTRIES) {
				const val = target[key];
				if (typeof val === "string") {
					const preview = sanitizePreview(val);
					if (preview.length > 0) {
						return `${label}: ${preview}`;
					}
				}
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * One live step_update payload → a human-readable progress line (always
 * \n-terminated): tool start/done/error, response done/progress, prompt.
 * Anything unexpected (unknown step_type or state, missing tool_name,
 * non-numeric duration, hostile getters) degrades to the tolerant
 * compact-JSON summary; this function NEVER throws.
 */
export function formatStepUpdate(step: Record<string, unknown>): string {
	try {
		const stepType = step["step_type"];
		const state = step["state"];
		const toolName = step["tool_name"];
		const rawDuration = step["duration_seconds"];
		const duration = typeof rawDuration === "number" && Number.isFinite(rawDuration) ? rawDuration : undefined;
		if (stepType === "tool") {
			if (typeof toolName !== "string" || toolName === "") return fallbackSummary(step);
			const param = extractToolParam(step["tool_info"]);
			const paramStr = param !== undefined ? ` (${param})` : "";
			if (state === "ACTIVE") return `▸ tool ${toolName}${paramStr}…\n`;
			if (state === "DONE") {
				const durStr = duration !== undefined ? ` (${duration1s(duration)})` : "";
				return `✓ ${toolName}${paramStr}${durStr}\n`;
			}
			if (state === "ERROR") return `✗ ${toolName}${paramStr} failed\n`;
			return fallbackSummary(step);
		}
		if (stepType === "agent_response") {
			if (state === "DONE") return duration !== undefined ? `● response (${duration1s(duration)})\n` : "● response\n";
			const rawDelta = step["text_delta"];
			if (typeof rawDelta === "string") {
				const preview = sanitizePreview(rawDelta);
				if (preview.length > 0) {
					return `▸ response: ${preview}\n`;
				}
			}
			return "▸ response…\n";
		}
		if (stepType === "user_input") {
			return "▸ prompt\n";
		}
		return fallbackSummary(step);
	} catch {
		return fallbackSummary(step);
	}
}

/**
 * Delta text for one tapped line: a real envelope-shaped step_update event
 * ({"step_update":{...}}) renders through the readable formatter; any other
 * shape keeps stepSummary's tolerant mapping (never throws either way).
 */
function lineDelta(line: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return stepSummary(line);
	}
	if (typeof parsed === "object" && parsed !== null) {
		const inner = (parsed as Record<string, unknown>)["step_update"];
		if (typeof inner === "object" && inner !== null) {
			return formatStepUpdate(inner as Record<string, unknown>);
		}
	}
	return stepSummary(line);
}

const REASONING_ID = "agy-progress";
const TEXT_ID = "agy-response";

/**
 * Default-off fail-safe message (spec image-input R1): names the enablement
 * path (the imageInput option, with its opencode config spelling) AND the
 * text alternative, so a rejected image turn is actionable, not mysterious.
 */
export const IMAGE_INPUT_DISABLED_MESSAGE =
	"the agy provider received an image but image input is disabled by default — enable it with the imageInput option (provider.agy.options.imageInput: true in your opencode config), or describe the image in text instead";

/**
 * True when the LAST user turn carries an image part (type "image" or
 * "image-url" — the exact shapes attachments.ts extraction recognizes).
 * Scope is deliberately the last user turn, matching the extraction
 * contract: historical image parts already follow the drop-by-design path.
 */
export function promptHasImage(messages: PromptMessage[]): boolean {
	const lastUser = [...messages].reverse().find((m) => m?.role === "user");
	if (!lastUser || !Array.isArray(lastUser.content)) return false;
	return lastUser.content.some((part) => {
		if (typeof part !== "object" || part === null) return false;
		if (part.type === "image" || part.type === "image-url") return true;
		const mt = part["mediaType"];
		return typeof mt === "string" && mt.toLowerCase().startsWith("image/");
	});
}

/** Terminal attachment-rejection stream: stream-start → error → close. */
function attachmentErrorStream(message: string): LanguageModelV3StreamResult {
	const stream = new ReadableStream<LanguageModelV3StreamPart>({
		start(controller) {
			controller.enqueue({ type: "stream-start", warnings: [] });
			controller.enqueue({
				type: "error",
				error: new APICallError({
					message,
					url: "agy://turn",
					requestBodyValues: {},
					isRetryable: false,
				}),
			});
			controller.close();
		},
	});
	return { stream };
}

/**
 * All-or-nothing rejection text for unsupported parts (spec image-input
 * R4): names every unsupported type and the text alternative.
 */
export function unsupportedAttachmentsMessage(types: string[]): string {
	return `unsupported attachment type(s) in the last user turn: ${types.join(", ")} — the agy image bridge accepts png, jpeg, gif and webp images only; remove the unsupported attachment or describe its content as text`;
}

/** D7: surfaced when attachments existed but the agent never inspected them. */
export const IMAGE_NOT_INSPECTED_NOTICE =
	"⚠ an attached image was not inspected with view_file — the response below may not account for it\n";

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
	/** Full resolved registry entry — its variants payload maps a selected
	 * effort variant to the agy id passed as --model at turn time. */
	private readonly entry: AgyModel;
	private readonly deps: AgyLanguageModelDeps;

	constructor(deps: AgyLanguageModelDeps) {
		this.deps = deps;
		this.provider = deps.provider;
		const resolved = resolveModel(deps.modelId, deps.config.models);
		this.modelId = resolved.id;
		// Constructor-time modelArg is the FALLBACK only: a variant selected
		// per call overrides it at doStream time (see resolveVariantModelArg).
		this.entry = resolved;
	}

	async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
		// R5 wiring: the prompt is reduced to the last user turn; the system
		// text is prepended only when this session has no stored conversation.
		// v1.1 divergence: opencode re-sends the FULL message array every
		// turn, so the per-message hashes of the incoming array are compared
		// against the stored baseline. A stored entry whose hashes are NOT a
		// prefix of the incoming ones means the visible thread was edited,
		// reordered, or truncated — this turn becomes a SEEDED prompt (bounded
		// re-render of the visible thread) for a FRESH agy conversation, and
		// turn.ts stores the new conversation id + hashes as the baseline.
		// turn.ts owns the authoritative resume/fresh decision from the same
		// baseline; this pre-computation only selects prompt building.
		const { deps } = this;
		// Per-call variant resolution: a variant selected in the picker (or
		// delivered via providerOptions) overrides the constructor-time
		// modelArg for THIS turn only; see resolveVariantModelArg for the
		// fallback contract.
		const variant = readVariant(options);
		// Resolution order: direct payload (the merged variant payload, when
		// opencode transports it that way) > variant name > entry fallback.
		const directModelId = readDirectModelId(options);
		const modelArg = directModelId ?? resolveVariantModelArg(this.entry, variant);
		// Loud-fallback policy: for a collapsed base, an unresolved or unknown
		// variant silently spawns the highest-effort agy id. That is a safe
		// default but a silent misfire (the user DID pick an effort; the host
		// may have delivered it somewhere we do not read). Surface every
		// fallback as a V3 warning so the host can show it. Flat models and
		// agy/default never fall back — they have no variants payload.
		const variantFallbackNotice = (() => {
			if (directModelId !== undefined) return undefined;
			if (this.entry.variants === undefined) return undefined;
			if (variant === undefined) {
				return `model "${this.entry.id}" has effort variants but none was selected; using "${modelArg ?? "agy default"}"`;
			}
			if (this.entry.variants[variant] === undefined) {
				return `unknown variant "${variant}" for model "${this.entry.id}"; using "${modelArg ?? "agy default"}"`;
			}
			return undefined;
		})();
		const ctx = readSessionContext(options.providerOptions, options.headers);
		const sessionId = ctx.sessionId ?? randomUUID();
		// Boundary cast (documented in messages.ts): V3 prompt messages are a
		// closed union without index signatures; mapMessages only reads
		// role/content/part.type and validates shapes at runtime.
		const incoming = options.prompt as unknown as PromptMessage[];
		// Default-off fail-safe (spec image-input R1, design D2): advertised
		// capabilities can desync from config, so the flag is re-checked
		// here. A disabled config + image in the last user turn rejects
		// BEFORE the store or the runner is touched — nothing stages, and
		// the error names the enablement path plus the text alternative.
		if (!deps.config.imageInput && promptHasImage(incoming)) {
			return attachmentErrorStream(IMAGE_INPUT_DISABLED_MESSAGE);
		}
		// Bridge activation (spec image-input R2–R4, design D3): when
		// enabled, image parts of the LAST user turn are extracted
		// all-or-nothing — any unsupported part rejects the whole turn
		// BEFORE the store or the runner is touched (nothing stages), with
		// an actionable error naming the type. Extracted images ride the
		// TurnRequest; the parts are stripped from a COPY used for prompt
		// building only — `hashes` below still hash the RAW incoming array
		// so divergence semantics are untouched (same visible thread →
		// same baseline, image or not).
		let attachments: ExtractedImage[] | undefined;
		let promptMessages = incoming;
		if (deps.config.imageInput) {
			const lastUser = [...incoming].reverse().find((m) => m?.role === "user");
			const lastUserContent = lastUser?.content;
			if (lastUser !== undefined && Array.isArray(lastUserContent) && lastUserContent.length > 0) {
				let extracted: Awaited<ReturnType<typeof extractAttachments>>;
				try {
					extracted = await extractAttachments(lastUserContent);
				} catch (err) {
					if (err instanceof AgyAttachmentError) return attachmentErrorStream(err.detail);
					throw err;
				}
				if (extracted.unsupported.length > 0) {
					return attachmentErrorStream(unsupportedAttachmentsMessage(extracted.unsupported));
				}
				if (extracted.images.length > 0) {
					attachments = extracted.images;
					promptMessages = incoming.map((m) =>
						m === lastUser
							? {
									...m,
							content: lastUserContent.filter((part) => {
								if (typeof part !== "object" || part === null) return true;
								if (part.type === "image" || part.type === "image-url") return false;
								if (part.type !== "file") return true;
								const mt = part["mediaType"];
								return !(typeof mt === "string" && mt.toLowerCase().startsWith("image/"));
							}),
								}
							: m,
					);
				}
			}
		}
		const hashes = messageHashes(incoming);
		// v2 prefix routing mirrors turn.ts: resolve() picks the binding this
		// call continues; no match with bindings present means the visible
		// thread diverged → seeded re-render on a FRESH conversation.
		const binding = await deps.store.resolve(sessionId, hashes);
		const diverged =
			binding === undefined && (await deps.store.get(sessionId)) !== undefined;
		const isNewConversation = binding === undefined || diverged;
		// TEMPORARY DIAGNOSTIC PROBE — remove once the session-key question is
		// resolved. Shape only: roles and hashes, never prompt content.
		const seedInfo = diverged ? renderSeed(incoming) : undefined;
		const mapping = mapMessages(promptMessages, { isNewConversation, seed: seedInfo?.seed });
		const warnings: SharedV3Warning[] = [
			...(seedInfo?.warnings ?? []),
			...mapping.warnings,
			...(variantFallbackNotice !== undefined ? [variantFallbackNotice] : []),
		].map((w) => ({
			type: "other",
			message: w,
		}));
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
							promptViaStdin: deps.promptViaStdin,
						},
					{
						prompt: mapping.prompt,
						hashes,
						seedPrompt: diverged ? mapping.prompt : undefined,
						modelArg,
						sessionId,
						attachments,
						signal: options.abortSignal,
							onLine: (line) => {
								// Live progress (D1 tap): every step_update is a
								// reasoning delta in the single status block,
								// rendered as a human-readable line.
								if (!line.includes('"step_update"')) return;
								openReasoning();
								controller.enqueue({ type: "reasoning-delta", id: REASONING_ID, delta: lineDelta(line) });
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
							onDiverged: () => {
								// v1.1: divergence re-seed is invisible downstream except here.
								openReasoning();
								controller.enqueue({
									type: "reasoning-delta",
									id: REASONING_ID,
									delta: "⟲ history diverged — new agy conversation seeded\n",
								});
							},
						},
				);
				// D7 (spec image-input R3): attachments existed but were not
				// inspected → surface the miss as a notice delta, never
				// silently treated as seen. Fires before reasoning-end so it
				// lands inside the (possibly just-opened) status block.
				if (
					attachments !== undefined &&
					attachments.length > 0 &&
					result.stagedAttachments !== undefined &&
					result.stagedAttachments.length > 0 &&
					result.attachmentsInspected !== true
				) {
					openReasoning();
					controller.enqueue({ type: "reasoning-delta", id: REASONING_ID, delta: IMAGE_NOT_INSPECTED_NOTICE });
				}
				if (reasoningOpen) controller.enqueue({ type: "reasoning-end", id: REASONING_ID });
					const text = normalizeResponseText(result.run.envelope?.response ?? "");
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
					// Staging failures (design D3/D4): AgyAttachmentError detail
					// is already actionable user guidance — map it like a
					// terminal TurnError instead of a raw rejection.
					if (err instanceof AgyAttachmentError) {
						if (reasoningOpen) controller.enqueue({ type: "reasoning-end", id: REASONING_ID });
						controller.enqueue({
							type: "error",
							error: new APICallError({
								message: err.detail,
								url: "agy://turn",
								requestBodyValues: {},
								isRetryable: false,
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
