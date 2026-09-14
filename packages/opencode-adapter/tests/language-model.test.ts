/**
 * Unit tests for the V3 language model (spec R4, design D5/D6, R6 error
 * surface): AgyLanguageModel implements LanguageModelV3 from the pinned
 * @ai-sdk/provider — the empirically confirmed native path of opencode
 * 1.18.x (v2 models run through a compat proxy with a warning). Part
 * order: stream-start → live reasoning parts (reasoning-start/delta/end,
 * one block per run) → text-start/delta(full response)/text-end →
 * finish(stop) with nested V3 usage, which fires even on empty responses.
 * TurnError maps onto an error part carrying APICallError semantics from
 * errors.ts; AbortError escapes the stream untouched. doGenerate drains
 * doStream (D6, one code path). Runs use an injected fake runner so these
 * tests pin the MAPPING, not the orchestration (turn.test.ts owns that).
 */
import { describe, expect, test } from "bun:test";
import { APICallError, type LanguageModelV3, type SharedV3ProviderOptions } from "@ai-sdk/provider";
import type { AgyEnvelope } from "agy-bridge-engine";
import { AgyAttachmentError } from "../src/attachments";
import {
	AgyLanguageModel,
	extractToolParam,
	formatStepUpdate,
	IMAGE_INPUT_DISABLED_MESSAGE,
	normalizeResponseText,
	promptHasImage,
	readSessionContext,
	readVariant,
	sanitizePreview,
} from "../src/language-model";
import { hashesArePrefix, messageHashes, type PromptMessage } from "../src/messages";
import { TurnError, type TurnDeps, type TurnRequest, type TurnResult } from "../src/turn";
import type { SessionEntry, SessionStore } from "../src/session-store";
import { resolveConfig, type AgyAdapterConfig } from "../src/config";

/** Minimal fake store: fixed entries (optionally with the v1.1 hashes
 * baseline) plus a log of binds. */
function fakeStore(entries: Record<string, SessionEntry> = {}): {
	store: SessionStore;
	bound: Array<{ sessionId: string; conversationId: string; hashes?: string[] }>;
} {
	const bound: Array<{ sessionId: string; conversationId: string; hashes?: string[] }> = [];
	return {
		bound,
		store: {
			get: async (id) => entries[id]?.conversationId,
			getEntry: async (id) => entries[id],
			resolve: async (id, incoming) => {
				const entry = entries[id];
				if (!entry) return undefined;
				if (entry.hashes) return hashesArePrefix(entry.hashes, incoming) ? entry : undefined;
				return entry;
			},
			bind: async (id, conversationId, hashes) => {
				bound.push({ sessionId: id, conversationId, hashes });
				entries[id] = hashes ? { conversationId, hashes } : { conversationId };
			},
			rebind: async (id) => {
				delete entries[id];
			},
			prune: async () => 0,
		},
	};
}

interface Seen {
	deps: TurnDeps;
	req: TurnRequest;
}

interface FakeRun {
	lines?: string[];
	envelope?: AgyEnvelope;
	resume?: boolean;
	throw?: Error;
	/** PR 3 (D7): staged-attachment outcome fields mirrored onto TurnResult. */
	stagedAttachments?: string[];
	attachmentsInspected?: boolean;
}

/** Fake runner: records deps+req, replays lines, optionally resumes/throws
 * (the throw lands AFTER the lines so mid-run failure states are testable).
 * Mirrors the runTurn contract it stands in for: onDiverged fires iff the
 * request carries a seedPrompt (turn.ts calls it exactly when it re-seeds). */
function fakeRunner(run: FakeRun): (deps: TurnDeps, req: TurnRequest) => Promise<TurnResult> {
	return async (deps, req) => {
		for (const line of run.lines ?? []) req.onLine?.(line);
		if (run.throw) throw run.throw;
		if (run.resume) req.onResume?.();
		if (req.seedPrompt !== undefined) req.onDiverged?.();
		return {
			classification: { outcome: "success", reason: "" },
			run: {
				exitCode: 0,
				timedOut: false,
				log: "",
				elapsedMs: 1,
				envelope: run.envelope,
				conversationId: run.envelope?.conversation_id,
			},
			resumed: run.resume ?? false,
			diverged: false,
			logPath: "/tmp/agy-run-x/run.log",
			conversationId: run.envelope?.conversation_id,
			stagedAttachments: run.stagedAttachments,
			attachmentsInspected: run.attachmentsInspected,
		};
	};
}

const USAGE = {
	input_tokens: 11,
	output_tokens: 7,
	thinking_tokens: 3,
	cache_read_tokens: 5,
	total_tokens: 26,
};

const OK_ENVELOPE: AgyEnvelope = {
	conversation_id: "conv-1",
	status: "SUCCESS",
	response: "full answer",
	usage: USAGE,
};

const PROMPT = [
	{ role: "system", content: "Be brief." },
	{ role: "user", content: [{ type: "text", text: "first question" }] },
	{ role: "assistant", content: [{ type: "text", text: "old answer" }] },
	{ role: "user", content: [{ type: "text", text: "second question" }] },
] as unknown as Parameters<LanguageModelV3["doStream"]>[0]["prompt"];

function makeModel(run: FakeRun, entries: Record<string, SessionEntry> = {}) {
	const { store, bound } = fakeStore(entries);
	const model = new AgyLanguageModel({
		provider: "agy",
		modelId: "agy/default",
		config: resolveConfig({ scratchRoot: "/tmp" }) as AgyAdapterConfig,
		store,
		run: fakeRunner(run),
	});
	return { model, bound };
}

/** Drain a doStream result into an ordered part list. */
async function drain(
	model: AgyLanguageModel,
	providerOptions?: SharedV3ProviderOptions,
	signal?: AbortSignal,
	headers?: Record<string, string | undefined>,
) {
	const { stream } = await model.doStream({ prompt: PROMPT, providerOptions, abortSignal: signal, headers });
	const reader = stream.getReader();
	const parts: Array<Record<string, unknown>> = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		parts.push(value as Record<string, unknown>);
	}
	return parts;
}

describe("unit: language-model — V3 mapping (R4, D5/D6, R6)", () => {
	test("V3 verdict pinned: specificationVersion 'v3', typed as LanguageModelV3", async () => {
		const { model } = makeModel({ envelope: OK_ENVELOPE });
		// Compile-time proof: the instance satisfies the pinned V3 interface.
		const asV3: LanguageModelV3 = model;
		expect(asV3.specificationVersion).toBe("v3");
		expect(asV3.provider).toBe("agy");
		expect(asV3.modelId).toBe("agy/default");
		expect(asV3.supportedUrls).toEqual({});
	});

	test("R4 order: stream-start → reasoning block (live step_updates) → text(full) → finish(stop)+usage", async () => {
		const { model } = makeModel({
			lines: [
				'{"event":"init","conversation_id":"conv-1"}',
				'{"event":"step_update","step":"exploring repo"}',
				'{"event":"step_update","step":"running tests"}',
			],
			envelope: OK_ENVELOPE,
		});
		const parts = await drain(model, { agy: { sessionId: "sess-1", worktree: "/wt" } });
		expect(parts.map((p) => p["type"])).toEqual([
			"stream-start",
			"reasoning-start",
			"reasoning-delta",
			"reasoning-delta",
			"reasoning-end",
			"text-start",
			"text-delta",
			"text-end",
			"finish",
		]);
		const byType = (t: string) => parts.filter((p) => p["type"] === t);
		// One reasoning block, one delta per step_update (line-terminated).
		const rid = byType("reasoning-start")[0]["id"] as string;
		const deltas = byType("reasoning-delta") as Array<{ id: string; delta: string }>;
		expect(deltas.map((d) => d.id)).toEqual([rid, rid]);
		expect(deltas.map((d) => d.delta)).toEqual(["exploring repo\n", "running tests\n"]);
		expect(byType("reasoning-end")[0]["id"]).toBe(rid);
		// Text arrives as ONE delta with the full response (no token streaming).
		const text = byType("text-delta") as Array<{ id: string; delta: string }>;
		expect(text).toHaveLength(1);
		expect(text[0].delta).toBe("full answer");
		expect(byType("text-start")[0]["id"]).toBe(byType("text-end")[0]["id"]);
		// finish(stop) with nested V3 usage mapped from agy's envelope.
		const finish = byType("finish")[0] as {
			usage: unknown;
			finishReason: { unified: string; raw: string | undefined };
		};
		expect(finish.finishReason).toEqual({ unified: "stop", raw: undefined });
		expect(finish.usage).toEqual({
			inputTokens: { total: 11, noCache: undefined, cacheRead: 5, cacheWrite: undefined },
			outputTokens: { total: 7, text: undefined, reasoning: 3 },
			raw: { total_tokens: 26 },
		});
	});

	test("runner receives the mapped prompt, modelArg, session context, and abort signal", async () => {
		const seen: Seen[] = [];
		const { store } = fakeStore({ "sess-9": { conversationId: "conv-existing" } });
		const controller = new AbortController();
		const model = new AgyLanguageModel({
			provider: "agy",
			modelId: "agy/gemini-3.8-flash-high",
			config: resolveConfig({ scratchRoot: "/tmp" }),
			store,
			run: async (deps, req) => {
				seen.push({ deps, req });
				return fakeRunner({ envelope: OK_ENVELOPE })(deps, req);
			},
		});
		await drain(model, { agy: { sessionId: "sess-9", worktree: "/work/tree" } }, controller.signal);
		expect(seen).toHaveLength(1);
		const { deps, req } = seen[0];
		// R5 wiring: last user turn only (continuing conversation → no system).
		expect(req.prompt).toBe("second question");
		// Registry wiring: gemini tier resolves to its --model argument.
		expect(req.modelArg).toBe("gemini-3.8-flash-high");
		expect(req.sessionId).toBe("sess-9");
		expect(deps.worktree).toBe("/work/tree");
		expect(req.signal).toBe(controller.signal);
		// New-conversation branch: system prepended once when no mapping exists.
		const { model: fresh } = makeModel({ envelope: OK_ENVELOPE });
		const freshSeen: Seen[] = [];
		const freshModel = new AgyLanguageModel({
			provider: "agy",
			modelId: "agy/default",
			config: resolveConfig({ scratchRoot: "/tmp" }),
			store: fakeStore().store,
			run: async (deps, req) => {
				freshSeen.push({ deps, req });
				return fakeRunner({ envelope: OK_ENVELOPE })(deps, req);
			},
		});
		await drain(freshModel);
		expect(freshSeen[0].req.prompt).toBe("Be brief.\n\nsecond question");
		// No providerOptions.agy and no headers → session key falls back to a generated id.
		expect(freshSeen[0].req.sessionId).toMatch(/^[0-9a-f-]{8,}$/);

		// Opencode double-nested providerOptions shape: { agy: { agy: { sessionId, worktree } } }
		const nestedSeen: Seen[] = [];
		const nestedModel = new AgyLanguageModel({
			provider: "agy",
			modelId: "agy/default",
			config: resolveConfig({ scratchRoot: "/tmp" }),
			store: fakeStore().store,
			run: async (deps, req) => {
				nestedSeen.push({ deps, req });
				return fakeRunner({ envelope: OK_ENVELOPE })(deps, req);
			},
		});
		await drain(nestedModel, { agy: { agy: { sessionId: "sess-nested-42", worktree: "/wt/nested" } } });
		expect(nestedSeen[0].req.sessionId).toBe("sess-nested-42");
		expect(nestedSeen[0].deps.worktree).toBe("/wt/nested");

		// Host header fallback: x-session-id without providerOptions
		const headerSeen: Seen[] = [];
		const headerModel = new AgyLanguageModel({
			provider: "agy",
			modelId: "agy/default",
			config: resolveConfig({ scratchRoot: "/tmp" }),
			store: fakeStore().store,
			run: async (deps, req) => {
				headerSeen.push({ deps, req });
				return fakeRunner({ envelope: OK_ENVELOPE })(deps, req);
			},
		});
		await drain(headerModel, undefined, undefined, { "x-session-id": "ses_from_header" });
		expect(headerSeen[0].req.sessionId).toBe("ses_from_header");
	});

	test("R4: empty response still finishes (stop, all-undefined usage), no text parts", async () => {
		const { model } = makeModel({ envelope: { conversation_id: "c", status: "SUCCESS", response: "" } });
		const parts = await drain(model, { agy: { sessionId: "s" } });
		const types = parts.map((p) => p["type"]);
		expect(types).toEqual(["stream-start", "finish"]);
		const finish = parts[1] as {
			usage: { inputTokens: object; outputTokens: object };
			finishReason: { unified: string };
		};
		expect(finish.finishReason.unified).toBe("stop");
		expect(finish.usage.inputTokens).toEqual({
			total: undefined,
			noCache: undefined,
			cacheRead: undefined,
			cacheWrite: undefined,
		});
		expect(finish.usage.outputTokens).toEqual({
			total: undefined,
			text: undefined,
			reasoning: undefined,
		});
	});

	test("R6: TurnError → error part with APICallError semantics (retryable outage / terminal timeout)", async () => {
		const outage = new TurnError({ retryable: true, resume: false, message: "agy provider is temporarily unavailable" });
		const { model } = makeModel({ throw: outage });
		const parts = await drain(model, { agy: { sessionId: "s" } });
		expect(parts.map((p) => p["type"])).toEqual(["stream-start", "error"]);
		const err = (parts[1] as { error: APICallError }).error;
		expect(APICallError.isInstance(err)).toBe(true);
		expect(err.isRetryable).toBe(true);
		expect(err.message).toBe("agy provider is temporarily unavailable");

		const terminal = new TurnError({
			retryable: false,
			resume: false,
			message: "agy timed out and could not be resumed. Full log: /tmp/agy-run-x/run.log",
		});
		const { model: dead } = makeModel({ throw: terminal });
		const deadParts = await drain(dead, { agy: { sessionId: "s" } });
		const deadErr = (deadParts[1] as { error: APICallError }).error;
		expect(APICallError.isInstance(deadErr)).toBe(true);
		expect(deadErr.isRetryable).toBe(false);
		expect(deadErr.message).toContain("/run.log");
	});

	test("D2: AbortError escapes the stream (read rejects), never an error part", async () => {
		const abort = new Error("agy turn aborted by the caller");
		abort.name = "AbortError";
		const { model } = makeModel({
			lines: ['{"event":"step_update","step":"thinking"}'],
			throw: abort,
		});
		const { stream } = await model.doStream({ prompt: PROMPT, providerOptions: { agy: { sessionId: "s" } } });
		const reader = stream.getReader();
		// The decisive signal is the REJECTION: a TurnError would have been
		// converted to an error part and the stream would end normally instead.
		let rejected: Error | undefined;
		let errorPartSeen = false;
		for (;;) {
			try {
				const { done, value } = await reader.read();
				if (done) break;
				if ((value as Record<string, unknown>)["type"] === "error") errorPartSeen = true;
			} catch (err) {
				rejected = err as Error;
				break;
			}
		}
		expect(rejected?.name).toBe("AbortError");
		expect(rejected?.message).toBe("agy turn aborted by the caller");
		expect(errorPartSeen).toBe(false);
	});

	test("R5: dropped non-text parts surface as stream-start warnings", async () => {
		const toolPrompt = [
			{ role: "user", content: [{ type: "text", text: "q" }, { type: "tool-call", toolCallId: "t1" }] },
		] as unknown as Parameters<LanguageModelV3["doStream"]>[0]["prompt"];
		const { model } = makeModel({ envelope: OK_ENVELOPE });
		const { stream } = await model.doStream({ prompt: toolPrompt });
		const first = await stream.getReader().read();
		expect(first.done).toBe(false);
		const start = first.value as { type: string; warnings: Array<{ type: string; message: string }> };
		expect(start.type).toBe("stream-start");
		expect(start.warnings).toHaveLength(1);
		expect(start.warnings[0].type).toBe("other");
		expect(start.warnings[0].message).toContain("non-text part");
	});

	test("D5: the resume announcement lands in the live reasoning block", async () => {
		const { model } = makeModel({
			lines: ['{"event":"step_update","step":"first attempt"}', '{"step_update":{"step_index":1,"detail":{"tool":"bash"}}}'],
			envelope: OK_ENVELOPE,
			resume: true,
		});
		const parts = await drain(model, { agy: { sessionId: "s" } });
		const deltas = (
			parts.filter((p) => p["type"] === "reasoning-delta") as Array<{
				delta: string;
			}>
		).map((d) => d.delta);
		expect(deltas).toHaveLength(3);
		expect(deltas[2]).toMatch(/resum/i);
		// Unknown step payloads degrade to compact JSON (tolerant mapping).
		expect(deltas[1]).toBe('{"step_index":1,"detail":{"tool":"bash"}}\n');
	});

	test("D6: doGenerate drains doStream — text/usage/warnings, empty → no content", async () => {
		const { model } = makeModel({
			lines: ['{"event":"step_update","step":"working"}'],
			envelope: OK_ENVELOPE,
		});
		const result = await model.doGenerate({ prompt: PROMPT });
		expect(result.content).toEqual([{ type: "text", text: "full answer" }]);
		expect(result.finishReason).toEqual({ unified: "stop", raw: undefined });
		expect(result.usage.outputTokens).toEqual({ total: 7, text: undefined, reasoning: 3 });
		expect(result.warnings).toEqual([]);

		const { model: empty } = makeModel({ envelope: { status: "SUCCESS", response: "" } });
		const emptyResult = await empty.doGenerate({ prompt: PROMPT });
		expect(emptyResult.content).toEqual([]);
		expect(emptyResult.finishReason.unified).toBe("stop");
	});

	test("readable progress: real step_update envelopes become human lines in the reasoning block", async () => {
		const { model } = makeModel({
			lines: [
				'{"step_update":{"conversation_id":"c","step_index":0,"state":"DONE","step_type":"user_input"}}',
				'{"step_update":{"conversation_id":"c","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"path":"a.ts"}}}',
				'{"step_update":{"conversation_id":"c","step_index":2,"state":"DONE","step_type":"tool","tool_name":"view_file","duration_seconds":0.28}}',
				'{"step_update":{"conversation_id":"c","step_index":2,"state":"ERROR","step_type":"tool","tool_name":"bash"}}',
				'{"step_update":{"conversation_id":"c","step_index":3,"state":"DONE","step_type":"agent_response","duration_seconds":3.17}}',
				'{"step_update":{"conversation_id":"c","step_index":4,"state":"ACTIVE","step_type":"mystery"}}',
			],
			envelope: OK_ENVELOPE,
		});
		const parts = await drain(model, { agy: { sessionId: "s" } });
		const deltas = (parts.filter((p) => p["type"] === "reasoning-delta") as Array<{ delta: string }>).map((d) => d.delta);
		expect(deltas).toEqual([
			"▸ prompt\n",
			"▸ tool view_file (path: a.ts)…\n",
			"✓ view_file (0.3s)\n",
			"✗ bash failed\n",
			"● response (3.2s)\n",
			// Unknown step types keep the tolerant compact-JSON fallback.
			'{"conversation_id":"c","step_index":4,"state":"ACTIVE","step_type":"mystery"}\n',
		]);
	});
});

/** Table rows pin the full output contract of formatStepUpdate. */
const FORMAT_CASES: Array<{ name: string; step: Record<string, unknown>; want: string }> = [
	{ name: "tool ACTIVE without tool_info", step: { step_type: "tool", state: "ACTIVE", tool_name: "view_file" }, want: "▸ tool view_file…\n" },
	{ name: "tool ACTIVE with path parameter", step: { step_type: "tool", state: "ACTIVE", tool_name: "view_file", tool_info: { path: "src/index.ts" } }, want: "▸ tool view_file (path: src/index.ts)…\n" },
	{ name: "tool ACTIVE with command parameter", step: { step_type: "tool", state: "ACTIVE", tool_name: "bash", tool_info: { command: "cargo test" } }, want: "▸ tool bash (command: cargo test)…\n" },
	{ name: "tool ACTIVE with multiline sanitized parameter", step: { step_type: "tool", state: "ACTIVE", tool_name: "bash", tool_info: { command: "npm test\n--watch\n--coverage" } }, want: "▸ tool bash (command: npm test --watch --coverage)…\n" },
	{ name: "tool ACTIVE without parameter in tool_info", step: { step_type: "tool", state: "ACTIVE", tool_name: "ls", tool_info: {} }, want: "▸ tool ls…\n" },
	{ name: "tool DONE rounds duration to 1 decimal", step: { step_type: "tool", state: "DONE", tool_name: "view_file", duration_seconds: 0.28 }, want: "✓ view_file (0.3s)\n" },
	{ name: "tool DONE with parameter and duration", step: { step_type: "tool", state: "DONE", tool_name: "view_file", tool_info: { path: "a.ts" }, duration_seconds: 0.28 }, want: "✓ view_file (path: a.ts) (0.3s)\n" },
	{ name: "tool DONE without duration", step: { step_type: "tool", state: "DONE", tool_name: "bash" }, want: "✓ bash\n" },
	{ name: "tool DONE with parameter without duration", step: { step_type: "tool", state: "DONE", tool_name: "view_file", tool_info: { path: "a.ts" } }, want: "✓ view_file (path: a.ts)\n" },
	{ name: "tool DONE with whole-number duration", step: { step_type: "tool", state: "DONE", tool_name: "bash", duration_seconds: 4 }, want: "✓ bash (4.0s)\n" },
	{ name: "tool ERROR without parameter", step: { step_type: "tool", state: "ERROR", tool_name: "bash" }, want: "✗ bash failed\n" },
	{ name: "tool ERROR with parameter", step: { step_type: "tool", state: "ERROR", tool_name: "bash", tool_info: { command: "cargo test" } }, want: "✗ bash (command: cargo test) failed\n" },
	{ name: "tool ACTIVE without tool_name falls back", step: { step_type: "tool", state: "ACTIVE", step_index: 2 }, want: '{"step_type":"tool","state":"ACTIVE","step_index":2}\n' },
	{ name: "tool with unknown state falls back", step: { step_type: "tool", state: "WEIRD", tool_name: "bash" }, want: '{"step_type":"tool","state":"WEIRD","tool_name":"bash"}\n' },
	{ name: "agent_response DONE with duration", step: { step_type: "agent_response", state: "DONE", duration_seconds: 3.17 }, want: "● response (3.2s)\n" },
	{ name: "agent_response DONE without duration", step: { step_type: "agent_response", state: "DONE" }, want: "● response\n" },
	{ name: "agent_response ACTIVE with text_delta", step: { step_type: "agent_response", state: "ACTIVE", text_delta: "Thinking about the problem" }, want: "▸ response: Thinking about the problem\n" },
	{ name: "agent_response ACTIVE with multiline text_delta", step: { step_type: "agent_response", state: "ACTIVE", text_delta: "Line 1\r\nLine 2" }, want: "▸ response: Line 1 Line 2\n" },
	{ name: "agent_response ACTIVE with empty text_delta", step: { step_type: "agent_response", state: "ACTIVE", text_delta: "" }, want: "▸ response…\n" },
	{ name: "agent_response ACTIVE with whitespace-only text_delta", step: { step_type: "agent_response", state: "ACTIVE", text_delta: "   \n\t  " }, want: "▸ response…\n" },
	{ name: "agent_response other states show progress without text_delta", step: { step_type: "agent_response", state: "ACTIVE" }, want: "▸ response…\n" },
	{ name: "user_input is a prompt line regardless of state", step: { step_type: "user_input", state: "DONE" }, want: "▸ prompt\n" },
	{ name: "unknown step_type falls back", step: { step_type: "mystery", step_index: 9 }, want: '{"step_type":"mystery","step_index":9}\n' },
	{ name: "missing step_type falls back", step: { state: "ACTIVE" }, want: '{"state":"ACTIVE"}\n' },
	{ name: "non-numeric duration treated as missing", step: { step_type: "tool", state: "DONE", tool_name: "x", duration_seconds: "0.5" }, want: "✓ x\n" },
	{ name: "tool DONE with NaN duration", step: { step_type: "tool", state: "DONE", tool_name: "grep", duration_seconds: NaN }, want: "✓ grep\n" },
	{ name: "tool DONE with Infinity duration", step: { step_type: "tool", state: "DONE", tool_name: "grep", duration_seconds: Infinity }, want: "✓ grep\n" },
	{ name: "agent_response DONE with NaN duration", step: { step_type: "agent_response", state: "DONE", duration_seconds: NaN }, want: "● response\n" },
	{ name: "agent_response DONE with Infinity duration", step: { step_type: "agent_response", state: "DONE", duration_seconds: Infinity }, want: "● response\n" },
	{ name: "empty record falls back to the placeholder", step: {}, want: "(step update)\n" },
];

describe("unit: sanitizePreview — single-line whitespace collapse and truncation", () => {
	test("normalizes multiple spaces, tabs, and CRLF/LF linebreaks into single spaces", () => {
		expect(sanitizePreview("hello   world")).toBe("hello world");
		expect(sanitizePreview("hello\tworld")).toBe("hello world");
		expect(sanitizePreview("hello\r\nworld\nagain")).toBe("hello world again");
		expect(sanitizePreview("\t  a \r\n b \t c  ")).toBe("a b c");
	});

	test("trims leading and trailing whitespace", () => {
		expect(sanitizePreview("   trimmed   ")).toBe("trimmed");
		expect(sanitizePreview("\n\t  trimmed  \r\n ")).toBe("trimmed");
	});

	test("returns empty string for empty or whitespace-only input", () => {
		expect(sanitizePreview("")).toBe("");
		expect(sanitizePreview("   ")).toBe("");
		expect(sanitizePreview("\r\n\t  ")).toBe("");
	});

	test("truncates with ellipsis when exceeding custom maxLen", () => {
		expect(sanitizePreview("1234567890", 5)).toBe("12345…");
		expect(sanitizePreview("12345", 5)).toBe("12345");
		expect(sanitizePreview("1234", 5)).toBe("1234");
	});

	test("truncates with ellipsis when exceeding default maxLen (60)", () => {
		const longText = "a".repeat(70);
		expect(sanitizePreview(longText)).toBe(`${"a".repeat(60)}…`);
		const exactText = "a".repeat(60);
		expect(sanitizePreview(exactText)).toBe(exactText);
	});
});

describe("unit: extractToolParam — priority-ordered tool parameter extraction", () => {
	test("asserts candidate priority: path > command > pattern > query > url", () => {
		expect(extractToolParam({ path: "src/index.ts", command: "cat file" })).toBe("path: src/index.ts");
		expect(extractToolParam({ command: "grep foo", pattern: "foo" })).toBe("command: grep foo");
		expect(extractToolParam({ pattern: "regex.*", query: "sql query" })).toBe("pattern: regex.*");
		expect(extractToolParam({ query: "find all", url: "https://example.com" })).toBe("query: find all");
		expect(extractToolParam({ url: "https://example.com/api" })).toBe("url: https://example.com/api");
	});

	test("sanitizes whitespace and collapses linebreaks in extracted value", () => {
		expect(extractToolParam({ command: "cargo test\n--all\n--release" })).toBe("command: cargo test --all --release");
	});

	test("truncates overly long parameter strings with ellipsis", () => {
		const longCmd = "a".repeat(100);
		expect(extractToolParam({ command: longCmd })).toBe(`command: ${"a".repeat(60)}…`);
	});

	test("skips empty or whitespace-only values and falls through to next candidate key", () => {
		expect(extractToolParam({ path: "", command: "cargo test" })).toBe("command: cargo test");
		expect(extractToolParam({ path: "   ", command: "cargo test" })).toBe("command: cargo test");
		expect(extractToolParam({ path: "\t\r\n", pattern: "needle" })).toBe("pattern: needle");
	});

	test("defensively returns undefined for non-candidate keys, non-objects, and primitives", () => {
		expect(extractToolParam({})).toBeUndefined();
		expect(extractToolParam({ other: "value" })).toBeUndefined();
		expect(extractToolParam({ path: 123 })).toBeUndefined();
		expect(extractToolParam({ path: null })).toBeUndefined();
		expect(extractToolParam(null)).toBeUndefined();
		expect(extractToolParam(undefined)).toBeUndefined();
		expect(extractToolParam("string")).toBeUndefined();
		expect(extractToolParam(42)).toBeUndefined();
	});

	test("defensively returns undefined on throwing getters", () => {
		const hostile = {
			get path(): string {
				throw new Error("getter exploded");
			},
		};
		expect(() => extractToolParam(hostile)).not.toThrow();
		expect(extractToolParam(hostile)).toBeUndefined();
	});

	test("extracts parameters from real agy tool_info shapes (nested parameters with PascalCase keys)", () => {
		expect(
			extractToolParam({
				name: "view_file",
				parameters: { AbsolutePath: "/tmp/test.txt" },
			}),
		).toBe("path: /tmp/test.txt");
		expect(
			extractToolParam({
				name: "run_command",
				parameters: { CommandLine: "bun test" },
			}),
		).toBe("command: bun test");
		expect(
			extractToolParam({
				name: "replace_file_content",
				parameters: { TargetFile: "/src/app.ts" },
			}),
		).toBe("path: /src/app.ts");
		expect(
			extractToolParam({
				name: "find_by_name",
				parameters: { Pattern: "*.ts" },
			}),
		).toBe("pattern: *.ts");
	});
});

describe("unit: formatStepUpdate — readable progress lines", () => {
	test("table: every contract row renders exactly one \\n-terminated line", () => {
		for (const c of FORMAT_CASES) {
			expect(c.want.endsWith("\n"), `${c.name}: fixture must be line-oriented`).toBe(true);
			expect(formatStepUpdate(c.step), `${c.name}`).toBe(c.want);
		}
	});

	test("never throws: a hostile payload (throwing getter) degrades to the placeholder", () => {
		const hostile = {
			get step_type(): string {
				throw new Error("boom");
			},
		} as unknown as Record<string, unknown>;
		expect(() => formatStepUpdate(hostile)).not.toThrow();
		expect(formatStepUpdate(hostile)).toBe("(step update)\n");
	});

	test("never throws: throwing getter on tool_info degrades to the placeholder", () => {
		const hostile = {
			step_type: "tool",
			state: "ACTIVE",
			tool_name: "bash",
			get tool_info(): unknown {
				throw new Error("tool_info boom");
			},
		} as unknown as Record<string, unknown>;
		expect(() => formatStepUpdate(hostile)).not.toThrow();
		expect(formatStepUpdate(hostile)).toBe("(step update)\n");
	});

	test("never throws: throwing getter on text_delta degrades to the placeholder", () => {
		const hostile = {
			step_type: "agent_response",
			state: "ACTIVE",
			get text_delta(): unknown {
				throw new Error("text_delta boom");
			},
		} as unknown as Record<string, unknown>;
		expect(() => formatStepUpdate(hostile)).not.toThrow();
		expect(formatStepUpdate(hostile)).toBe("(step update)\n");
	});

	test("never throws: circular references in step degrade to the placeholder", () => {
		const circular: Record<string, unknown> = { step_type: "mystery" };
		circular.self = circular;
		expect(() => formatStepUpdate(circular)).not.toThrow();
		expect(formatStepUpdate(circular)).toBe("(step update)\n");
	});

	test("never throws: circular references in tool_info degrade gracefully without throwing", () => {
		const circularInfo: Record<string, unknown> = {};
		circularInfo.self = circularInfo;
		const step = { step_type: "tool", state: "ACTIVE", tool_name: "bash", tool_info: circularInfo };
		expect(() => formatStepUpdate(step)).not.toThrow();
		expect(formatStepUpdate(step)).toBe("▸ tool bash…\n");
	});
});

describe("unit: language-model — v1.1 divergence re-seeding", () => {
	// Note: binding of the new baseline (conversationId + hashes) happens
	// inside runTurn; turn.test.ts owns that against the real store. These
	// tests pin the language-model MAPPING: seeded prompt, hashes on the
	// request, and the ⟲ status line.
	test("divergence: seeded prompt (system + prior thread + new turn), hashes forwarded, ⟲ status line", async () => {
		const seen: Seen[] = [];
		const { store } = fakeStore({
			"sess-div": { conversationId: "conv-old", hashes: ["stale-0", "stale-1", "stale-2", "stale-3"] },
		});
		const model = new AgyLanguageModel({
			provider: "agy",
			modelId: "agy/default",
			config: resolveConfig({ scratchRoot: "/tmp" }),
			store,
			run: async (deps, req) => {
				seen.push({ deps, req });
				return fakeRunner({ envelope: OK_ENVELOPE })(deps, req);
			},
		});
		const parts = await drain(model, { agy: { sessionId: "sess-div" } });
		const req = seen[0].req;
		// Seeded prompt: the fresh-conversation system text, then the guarded
		// prior thread, then the actual last user turn.
		expect(req.prompt.startsWith("Be brief.\n\n--- Previous conversation")).toBe(true);
		expect(req.prompt).toContain("--- Previous conversation (context restored after edits in the client) ---");
		expect(req.prompt).toContain("User: first question");
		expect(req.prompt).toContain("Assistant: old answer");
		expect(req.prompt).toContain("--- End of previous conversation ---\n\nsecond question");
		// The incoming hashes ride along for the store baseline.
		expect(req.hashes).toEqual(messageHashes(PROMPT as unknown as PromptMessage[]));
		// The divergence announcement lands in the live reasoning block.
		const deltas = (parts.filter((p) => p["type"] === "reasoning-delta") as Array<{ delta: string }>).map(
			(d) => d.delta,
		);
		expect(deltas.some((d) => d.includes("⟲ history diverged — new agy conversation seeded"))).toBe(true);
	});

	test("linear continuation: stored prefix → NO seed, plain last-turn prompt, incoming hashes forwarded", async () => {
		const seen: Seen[] = [];
		const { store } = fakeStore({
			"sess-lin": { conversationId: "conv-old", hashes: messageHashes(PROMPT.slice(0, 3) as unknown as PromptMessage[]) },
		});
		const model = new AgyLanguageModel({
			provider: "agy",
			modelId: "agy/default",
			config: resolveConfig({ scratchRoot: "/tmp" }),
			store,
			run: async (deps, req) => {
				seen.push({ deps, req });
				return fakeRunner({ envelope: OK_ENVELOPE })(deps, req);
			},
		});
		const parts = await drain(model, { agy: { sessionId: "sess-lin" } });
		expect(seen[0].req.prompt).toBe("second question");
		expect(seen[0].req.seedPrompt).toBeUndefined();
		expect(seen[0].req.hashes).toEqual(messageHashes(PROMPT as unknown as PromptMessage[]));
		const deltas = (parts.filter((p) => p["type"] === "reasoning-delta") as Array<{ delta: string }>).map(
			(d) => d.delta,
		);
		expect(deltas.some((d) => d.includes("⟲ history diverged"))).toBe(false);
	});

	test("unknown baseline: pre-upgrade entry (no hashes) is ADOPTED — resume semantics, no seed, hashes computed", async () => {
		const seen: Seen[] = [];
		const { store } = fakeStore({ "sess-adopt": { conversationId: "conv-old" } });
		const model = new AgyLanguageModel({
			provider: "agy",
			modelId: "agy/default",
			config: resolveConfig({ scratchRoot: "/tmp" }),
			store,
			run: async (deps, req) => {
				seen.push({ deps, req });
				return fakeRunner({ envelope: OK_ENVELOPE })(deps, req);
			},
		});
		const parts = await drain(model, { agy: { sessionId: "sess-adopt" } });
		// No system prepend, no seed: the turn behaves as a linear continuation.
		expect(seen[0].req.prompt).toBe("second question");
		expect(seen[0].req.seedPrompt).toBeUndefined();
		expect(seen[0].req.hashes).toEqual(messageHashes(PROMPT as unknown as PromptMessage[]));
		const deltas = (parts.filter((p) => p["type"] === "reasoning-delta") as Array<{ delta: string }>).map(
			(d) => d.delta,
		);
		expect(deltas.some((d) => d.includes("⟲ history diverged"))).toBe(false);
	});
});

const NORMALIZE_CASES: Array<{ name: string; input: string; want: string }> = [
	{ name: "plain text untouched", input: "full answer", want: "full answer" },
	{ name: "CRLF becomes LF", input: "line one\r\nline two", want: "line one\nline two" },
	{ name: "multiple CRLFs all normalized", input: "a\r\n\r\nb", want: "a\n\nb" },
	{ name: "trailing whitespace stripped at the very end", input: "answer\n\n  \n", want: "answer" },
	{ name: "CRLF then trailing blank lines fully stripped", input: "a\r\nb\r\n\r\n", want: "a\nb" },
	{ name: "empty string stays empty", input: "", want: "" },
	{ name: "whitespace-only collapses to empty", input: " \r\n\t", want: "" },
	{ name: "internal spaces kept, only the very end stripped", input: "a \nb ", want: "a \nb" },
];

describe("unit: normalizeResponseText — v1.1 CRLF + trailing-whitespace normalization", () => {
	test("table: every contract row normalizes as specified", () => {
		for (const c of NORMALIZE_CASES) expect(normalizeResponseText(c.input), c.name).toBe(c.want);
	});

	test("text-delta carries the normalized response; a whitespace-only response emits no text parts", async () => {
		const { model } = makeModel({ envelope: { ...OK_ENVELOPE, response: "line one\r\nline two\r\n" } });
		const parts = await drain(model, { agy: { sessionId: "s" } });
		const delta = (parts.find((p) => p["type"] === "text-delta") as { delta: string }).delta;
		expect(delta).toBe("line one\nline two");

		const { model: blank } = makeModel({
			envelope: { conversation_id: "c", status: "SUCCESS", response: "\r\n \r\n" },
		});
		const blankParts = await drain(blank, { agy: { sessionId: "s" } });
		expect(blankParts.map((p) => p["type"])).toEqual(["stream-start", "finish"]);
	});
});

describe("unit: readSessionContext — session & worktree resolution (plugin + host shapes)", () => {
	test("reads direct providerOptions.agy { sessionId, worktree }", () => {
		expect(readSessionContext({ agy: { sessionId: "ses-1", worktree: "/wt/1" } })).toEqual({
			sessionId: "ses-1",
			worktree: "/wt/1",
		});
	});

	test("reads opencode runtime double-nested providerOptions.agy.agy { sessionId, worktree }", () => {
		expect(readSessionContext({ agy: { agy: { sessionId: "ses-2", worktree: "/wt/2" } } })).toEqual({
			sessionId: "ses-2",
			worktree: "/wt/2",
		});
	});

	test("falls back to host headers when providerOptions has no session", () => {
		expect(readSessionContext(undefined, { "x-session-id": "ses-hdr" })).toEqual({
			sessionId: "ses-hdr",
			worktree: undefined,
		});
		expect(readSessionContext(undefined, { "X-Session-Id": "ses-hdr-caps" })).toEqual({
			sessionId: "ses-hdr-caps",
			worktree: undefined,
		});
		expect(readSessionContext(undefined, { "x-session-affinity": "ses-affinity" })).toEqual({
			sessionId: "ses-affinity",
			worktree: undefined,
		});
	});

	test("direct provider options takes priority over headers", () => {
		expect(
			readSessionContext(
				{ agy: { sessionId: "ses-opts" } },
				{ "x-session-id": "ses-hdr" },
			),
		).toEqual({
			sessionId: "ses-opts",
			worktree: undefined,
		});
	});

	test("empty strings and non-string types degrade to undefined", () => {
		expect(readSessionContext({ agy: { sessionId: "", worktree: 123 as unknown as string } })).toEqual({
			sessionId: undefined,
			worktree: undefined,
		});
		expect(readSessionContext({ agy: null } as unknown as Parameters<typeof readSessionContext>[0])).toEqual({
			sessionId: undefined,
			worktree: undefined,
		});
		expect(readSessionContext(undefined, { "x-session-id": "" })).toEqual({
			sessionId: undefined,
			worktree: undefined,
		});
	});
});

describe("unit: readVariant — effort-variant selection channel", () => {
	test("reads providerOptions.agy.variant (direct plugin channel)", () => {
		expect(readVariant({ providerOptions: { agy: { variant: "low" } } })).toBe("low");
	});

	test("reads nested providerOptions.agy.agy.variant (opencode runtime wrap)", () => {
		expect(readVariant({ providerOptions: { agy: { agy: { variant: "medium" } } } })).toBe("medium");
	});

	test("reads a top-level options field named variant", () => {
		expect(readVariant({ variant: "high" } as Parameters<typeof readVariant>[0])).toBe("high");
	});

	test("precedence: direct providerOptions > nested wrap > top-level field", () => {
		expect(
			readVariant({
				providerOptions: { agy: { variant: "low", agy: { variant: "medium" } } },
				variant: "high",
			} as Parameters<typeof readVariant>[0]),
		).toBe("low");
		expect(
			readVariant({ providerOptions: { agy: { agy: { variant: "medium" } } }, variant: "high" } as Parameters<
				typeof readVariant
			>[0]),
		).toBe("medium");
	});

	test("non-string and empty values degrade to undefined", () => {
		expect(readVariant({ providerOptions: { agy: { variant: 3 } } } as unknown as Parameters<
			typeof readVariant
		>[0])).toBeUndefined();
		expect(readVariant({ providerOptions: { agy: { variant: "" } } })).toBeUndefined();
		expect(readVariant({ providerOptions: { agy: null } } as unknown as Parameters<typeof readVariant>[0])).toBeUndefined();
		expect(readVariant({ providerOptions: { agy: { variant: null } } } as unknown as Parameters<
			typeof readVariant
		>[0])).toBeUndefined();
	});

	test("undefined options degrade to undefined (never throws)", () => {
		expect(readVariant(undefined)).toBeUndefined();
		expect(readVariant({})).toBeUndefined();
	});
});

describe("unit: language-model — per-call variant → modelArg resolution", () => {
	/** Model on a collapsed base: registry modelArg fallback = highest effort. */
	function makeVariantModel(
		modelId: string,
		run: FakeRun,
	): { model: AgyLanguageModel; seen: Seen[] } {
		const seen: Seen[] = [];
		const model = new AgyLanguageModel({
			provider: "agy",
			modelId,
			config: resolveConfig({ scratchRoot: "/tmp" }),
			store: fakeStore().store,
			run: async (deps, req) => {
				seen.push({ deps, req });
				return fakeRunner(run)(deps, req);
			},
		});
		return { model, seen };
	}

	test("selected variant overrides the fallback modelArg at doStream time", async () => {
		// agy/gemini-3.8-flash collapses; constructor fallback = "gemini-3.8-flash-high".
		const { model, seen } = makeVariantModel("agy/gemini-3.8-flash", { envelope: OK_ENVELOPE });
		await drain(model, { agy: { sessionId: "s", variant: "low" } });
		expect(seen[0].req.modelArg).toBe("gemini-3.8-flash-low");
	});

	test("nested providerOptions.agy.agy.variant is honored end-to-end", async () => {
		const { model, seen } = makeVariantModel("agy/gemini-3.8-flash", { envelope: OK_ENVELOPE });
		await drain(model, { agy: { agy: { sessionId: "s", variant: "medium" } } });
		expect(seen[0].req.modelArg).toBe("gemini-3.8-flash-medium");
	});

	test("top-level options.variant is honored end-to-end", async () => {
		const { model, seen } = makeVariantModel("agy/gemini-3.8-flash", { envelope: OK_ENVELOPE });
		const { stream } = await model.doStream({
			prompt: PROMPT,
			variant: "low",
		} as Parameters<AgyLanguageModel["doStream"]>[0]);
		const reader = stream.getReader();
		for (;;) {
			const { done } = await reader.read();
			if (done) break;
		}
		expect(seen[0].req.modelArg).toBe("gemini-3.8-flash-low");
	});

	test("UNKNOWN variant falls back to the documented default: highest discovered effort", async () => {
		const { model, seen } = makeVariantModel("agy/gemini-3.8-flash", { envelope: OK_ENVELOPE });
		await drain(model, { agy: { sessionId: "s", variant: "turbo" } });
		expect(seen[0].req.modelArg).toBe("gemini-3.8-flash-high");
	});

	test("NO variant → collapsed base keeps its highest-effort fallback modelArg", async () => {
		const { model, seen } = makeVariantModel("agy/gemini-3.8-flash", { envelope: OK_ENVELOPE });
		await drain(model, { agy: { sessionId: "s" } });
		expect(seen[0].req.modelArg).toBe("gemini-3.8-flash-high");
	});

	test("variant on a FLAT model never changes its modelArg", async () => {
		const { model, seen } = makeVariantModel("agy/claude-sonnet-4-6", { envelope: OK_ENVELOPE });
		await drain(model, { agy: { sessionId: "s", variant: "high" } });
		expect(seen[0].req.modelArg).toBe("claude-sonnet-4-6");
	});

	test("variant on agy/default stays modelArg undefined (spawn WITHOUT --model)", async () => {
		const { model, seen } = makeVariantModel("agy/default", { envelope: OK_ENVELOPE });
		await drain(model, { agy: { sessionId: "s", variant: "high" } });
		expect(seen[0].req.modelArg).toBeUndefined();
	});

	test("empty-string variant degrades to the fallback, not an override", async () => {
		const { model, seen } = makeVariantModel("agy/gemini-3.8-flash", { envelope: OK_ENVELOPE });
		await drain(model, { agy: { sessionId: "s", variant: "" } });
		expect(seen[0].req.modelArg).toBe("gemini-3.8-flash-high");
	});

	test("legacy suffixed modelId keeps its direct modelArg with and without a variant", async () => {
		// Backward compat: agy/gemini-3.8-flash-low selected directly still
		// passes the FULL suffixed id; a variant cannot remap it (no variants
		// on the passthrough entry).
		const { model, seen } = makeVariantModel("agy/gemini-3.8-flash-low", { envelope: OK_ENVELOPE });
		await drain(model, { agy: { sessionId: "s" } });
		expect(seen[0].req.modelArg).toBe("gemini-3.8-flash-low");
		await drain(model, { agy: { sessionId: "s", variant: "high" } });
		expect(seen[1].req.modelArg).toBe("gemini-3.8-flash-low");
	});

	test("loud fallback: collapsed base with NO selected variant warns on stream-start", async () => {
		const { model } = makeVariantModel("agy/gemini-3.8-flash", { envelope: OK_ENVELOPE });
		const parts = await drain(model, { agy: { sessionId: "s" } });
		const start = parts.find((p) => p["type"] === "stream-start") as {
			warnings?: Array<{ message: string }>;
		};
		const messages = (start.warnings ?? []).map((w) => w.message);
		expect(messages.some((m) => m.includes("effort variants but none was selected"))).toBe(true);
		expect(messages.some((m) => m.includes("gemini-3.8-flash-high"))).toBe(true);
	});

	test("loud fallback: UNKNOWN variant warns instead of silently falling back", async () => {
		const { model } = makeVariantModel("agy/gemini-3.8-flash", { envelope: OK_ENVELOPE });
		const parts = await drain(model, { agy: { sessionId: "s", variant: "banana" } });
		const start = parts.find((p) => p["type"] === "stream-start") as {
			warnings?: Array<{ message: string }>;
		};
		const messages = (start.warnings ?? []).map((w) => w.message);
		expect(messages.some((m) => m.includes('unknown variant "banana"'))).toBe(true);
	});

	test("resolved variant emits no fallback warning (silent success)", async () => {
		const { model } = makeVariantModel("agy/gemini-3.8-flash", { envelope: OK_ENVELOPE });
		const parts = await drain(model, { agy: { sessionId: "s", variant: "medium" } });
		const start = parts.find((p) => p["type"] === "stream-start") as {
			warnings?: Array<{ message: string }>;
		};
		const messages = (start.warnings ?? []).map((w) => w.message);
		expect(messages.some((m) => m.includes("variant"))).toBe(false);
	});

	test("direct payload channel: agyModelId in providerOptions wins over the variant name", async () => {
		const { model, seen } = makeVariantModel("agy/gemini-3.8-flash", { envelope: OK_ENVELOPE });
		await drain(model, {
			agy: { sessionId: "s", variant: "low", agyModelId: "gemini-3.8-flash-high" },
		});
		// The direct payload is one step more concrete; it outranks names.
		expect(seen[0].req.modelArg).toBe("gemini-3.8-flash-high");
	});

	test("direct payload channel: works alone, without any variant name", async () => {
		const { model, seen } = makeVariantModel("agy/gemini-3.8-flash", { envelope: OK_ENVELOPE });
		const parts = await drain(model, { agy: { sessionId: "s", agyModelId: "gemini-3.8-flash-low" } });
		expect(seen[0].req.modelArg).toBe("gemini-3.8-flash-low");
		// A delivered payload is a resolved choice: no fallback warning.
		const start = parts.find((p) => p["type"] === "stream-start") as {
			warnings?: Array<{ message: string }>;
		};
		const messages = (start.warnings ?? []).map((w) => w.message);
		expect(messages.some((m) => m.includes("variant"))).toBe(false);
	});
});

describe("unit: language-model — imageInput disabled fail-safe (spec image-input R1, design D2)", () => {
	/** Prompt whose LAST user turn carries an inline image part. */
	const IMAGE_PROMPT = [
		{ role: "user", content: [{ type: "text", text: "what is in this picture" }, { type: "image", image: "aGVsbG8=", mediaType: "image/png" }] },
	] as unknown as Parameters<LanguageModelV3["doStream"]>[0]["prompt"];

	/** Prompt whose last user turn carries a remote image-url part. */
	const IMAGE_URL_PROMPT = [
		{ role: "user", content: [{ type: "image-url", image_url: { url: "https://example.com/cat.png" } }] },
	] as unknown as Parameters<LanguageModelV3["doStream"]>[0]["prompt"];

	/** Prompt with an image in an EARLIER user turn; last turn is text-only. */
	const EARLIER_IMAGE_PROMPT = [
		{ role: "user", content: [{ type: "text", text: "first" }, { type: "image", image: "aGVsbG8=", mediaType: "image/png" }] },
		{ role: "assistant", content: [{ type: "text", text: "old answer" }] },
		{ role: "user", content: [{ type: "text", text: "follow-up" }] },
	] as unknown as Parameters<LanguageModelV3["doStream"]>[0]["prompt"];

	function makeDisabledModel(run: FakeRun): { model: AgyLanguageModel; seen: Seen[] } {
		const seen: Seen[] = [];
		const model = new AgyLanguageModel({
			provider: "agy",
			modelId: "agy/default",
			// resolveConfig() default: imageInput false — the contract under test.
			config: resolveConfig({ scratchRoot: "/tmp" }),
			store: fakeStore().store,
			run: async (deps, req) => {
				seen.push({ deps, req });
				return fakeRunner(run)(deps, req);
			},
		});
		return { model, seen };
	}

	/** Drain a doStream run with an explicit prompt into ordered parts. */
	async function drainPrompt(
		model: AgyLanguageModel,
		prompt: Parameters<LanguageModelV3["doStream"]>[0]["prompt"],
	): Promise<Array<Record<string, unknown>>> {
		const { stream } = await model.doStream({ prompt, providerOptions: { agy: { sessionId: "s" } } });
		const reader = stream.getReader();
		const parts: Array<Record<string, unknown>> = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(value as Record<string, unknown>);
		}
		return parts;
	}

	test("disabled + inline image in the LAST user turn → actionable error part, runner never invoked", async () => {
		const { model, seen } = makeDisabledModel({ envelope: OK_ENVELOPE });
		const parts = await drainPrompt(model, IMAGE_PROMPT);
		// stream-start then a terminal error part — no run, no text, no finish.
		expect(parts.map((p) => p["type"])).toEqual(["stream-start", "error"]);
		const err = (parts[1] as { error: APICallError }).error;
		expect(APICallError.isInstance(err)).toBe(true);
		// Enabling the flag is a config action, not a transient fault.
		expect(err.isRetryable).toBe(false);
		// Actionable: names the enablement path AND the text alternative.
		expect(err.message).toBe(IMAGE_INPUT_DISABLED_MESSAGE);
		expect(err.message).toContain("imageInput");
		expect(err.message).toContain("provider.agy.options.imageInput: true");
		expect(err.message).toContain("describe the image in text");
		// Fail-safe fires BEFORE dispatch: nothing was staged or run.
		expect(seen).toHaveLength(0);
	});

	test("disabled + image-url part in the LAST user turn → same actionable rejection", async () => {
		const { model, seen } = makeDisabledModel({ envelope: OK_ENVELOPE });
		const parts = await drainPrompt(model, IMAGE_URL_PROMPT);
		expect(parts.map((p) => p["type"])).toEqual(["stream-start", "error"]);
		expect((parts[1] as { error: APICallError }).error.message).toBe(IMAGE_INPUT_DISABLED_MESSAGE);
		expect(seen).toHaveLength(0);
	});

	test("disabled + image in an EARLIER turn only → NO fail-safe: normal flow, runner runs", async () => {
		const { model, seen } = makeDisabledModel({ envelope: OK_ENVELOPE });
		// The fail-safe scopes to the LAST user turn (the current request);
		// historical image parts keep the existing drop-by-design behavior.
		const parts = await drainPrompt(model, EARLIER_IMAGE_PROMPT);
		expect(parts.some((p) => p["type"] === "error")).toBe(false);
		expect(parts.some((p) => p["type"] === "finish")).toBe(true);
		expect(seen).toHaveLength(1);
	});

	test("imageInput ENABLED + image in the last turn → no fail-safe error (bridge activation is a later unit)", async () => {
		const seen: Seen[] = [];
		const model = new AgyLanguageModel({
			provider: "agy",
			modelId: "agy/default",
			config: resolveConfig({ scratchRoot: "/tmp", imageInput: true }),
			store: fakeStore().store,
			run: async (deps, req) => {
				seen.push({ deps, req });
				return fakeRunner({ envelope: OK_ENVELOPE })(deps, req);
			},
		});
		const parts = await drainPrompt(model, IMAGE_PROMPT);
		expect(parts.some((p) => p["type"] === "error")).toBe(false);
		expect(parts.some((p) => p["type"] === "finish")).toBe(true);
		expect(seen).toHaveLength(1);
	});
});

describe("unit: promptHasImage — last-user-turn image detection", () => {
	test("detects image and image-url parts in the last user turn", () => {
		expect(
			promptHasImage([
				{ role: "user", content: [{ type: "text", text: "q" }, { type: "image", image: "aGk=", mediaType: "image/png" }] },
			]),
		).toBe(true);
		expect(
			promptHasImage([{ role: "user", content: [{ type: "image-url", url: "https://x/y.png" }] }]),
		).toBe(true);
	});

	test("text-only turns, string content, and empty arrays are NOT images", () => {
		expect(promptHasImage([{ role: "user", content: [{ type: "text", text: "q" }] }])).toBe(false);
		expect(promptHasImage([{ role: "user", content: "plain question" }])).toBe(false);
		expect(promptHasImage([])).toBe(false);
		expect(promptHasImage([{ role: "assistant", content: [{ type: "image", image: "aGk=" }] }])).toBe(false);
	});
});

describe("unit: language-model — image bridge activation (spec image-input R2–R4, design D3/D7)", () => {
	// PR 3: with imageInput ENABLED the last user turn's image parts are
	// extracted (all-or-nothing), stripped BEFORE mapMessages (no drop
	// warning on the enabled path), and ride the TurnRequest as decoded
	// attachments. Unsupported parts reject the whole turn before the
	// runner is invoked; uninspected staging surfaces as a notice delta.

	/** Last user turn: text + inline png. */
	const BRIDGE_PROMPT = [
		{ role: "system", content: "Be brief." },
		{ role: "user", content: [{ type: "text", text: "what is in this picture" }, { type: "image", image: "aGVsbG8=", mediaType: "image/png" }] },
	] as unknown as Parameters<LanguageModelV3["doStream"]>[0]["prompt"];

	const PNG_BYTES = new Uint8Array(Buffer.from("aGVsbG8=", "base64"));

	function makeEnabledModel(run: FakeRun): { model: AgyLanguageModel; seen: Seen[] } {
		const seen: Seen[] = [];
		const model = new AgyLanguageModel({
			provider: "agy",
			modelId: "agy/default",
			config: resolveConfig({ scratchRoot: "/tmp", imageInput: true }),
			store: fakeStore().store,
			run: async (deps, req) => {
				seen.push({ deps, req });
				return fakeRunner(run)(deps, req);
			},
		});
		return { model, seen };
	}

	async function drainWithPrompt(
		model: AgyLanguageModel,
		prompt: Parameters<LanguageModelV3["doStream"]>[0]["prompt"],
	): Promise<Array<Record<string, unknown>>> {
		const { stream } = await model.doStream({ prompt, providerOptions: { agy: { sessionId: "s" } } });
		const reader = stream.getReader();
		const parts: Array<Record<string, unknown>> = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(value as Record<string, unknown>);
		}
		return parts;
	}

	test("enabled + inline image: attachments ride the TurnRequest; prompt is text-only; no drop warning", async () => {
		const { model, seen } = makeEnabledModel({ envelope: OK_ENVELOPE });
		const parts = await drainWithPrompt(model, BRIDGE_PROMPT);
		expect(seen).toHaveLength(1);
		const req = seen[0].req;
		// Decoded bytes + media type pass through untouched.
		expect(req.attachments).toEqual([{ data: PNG_BYTES, mediaType: "image/png" }]);
		// The image part is stripped BEFORE mapMessages: the mapped prompt is
		// the new-conversation system text plus the last user turn's text —
		// and nothing else (no image residue, no drop warning).
		expect(req.prompt).toBe("Be brief.\n\nwhat is in this picture");
		// …and the drop-by-design warning never fires on the enabled path.
		const start = parts.find((p) => p["type"] === "stream-start") as {
			warnings?: Array<{ message: string }>;
		};
		const messages = (start.warnings ?? []).map((w) => w.message);
		expect(messages.some((m) => m.includes("dropped non-text part"))).toBe(false);
		expect(parts.some((p) => p["type"] === "finish")).toBe(true);
	});

	test("enabled + three images: all extracted in order, prompt stays text-only", async () => {
		const prompt = [
			{
				role: "user",
				content: [
					{ type: "text", text: "compare these" },
					{ type: "image", image: Buffer.from("one").toString("base64"), mediaType: "image/png" },
					{ type: "image", image: Buffer.from("two").toString("base64"), mediaType: "image/jpeg" },
					{ type: "image", image: Buffer.from("three").toString("base64"), mediaType: "image/gif" },
				],
			},
		] as unknown as Parameters<LanguageModelV3["doStream"]>[0]["prompt"];
		const { model, seen } = makeEnabledModel({ envelope: OK_ENVELOPE });
		await drainWithPrompt(model, prompt);
		expect(seen[0].req.attachments).toHaveLength(3);
		expect(seen[0].req.attachments?.map((a) => a.mediaType)).toEqual(["image/png", "image/jpeg", "image/gif"]);
		expect(seen[0].req.attachments?.[0].data).toEqual(new Uint8Array(Buffer.from("one")));
		expect(seen[0].req.prompt).toBe("compare these");
	});

	test("enabled + image in an EARLIER turn only: no extraction, attachments undefined, normal flow", async () => {
		const earlier = [
			{ role: "user", content: [{ type: "text", text: "first" }, { type: "image", image: "aGVsbG8=", mediaType: "image/png" }] },
			{ role: "assistant", content: [{ type: "text", text: "old answer" }] },
			{ role: "user", content: [{ type: "text", text: "follow-up" }] },
		] as unknown as Parameters<LanguageModelV3["doStream"]>[0]["prompt"];
		const { model, seen } = makeEnabledModel({ envelope: OK_ENVELOPE });
		const parts = await drainWithPrompt(model, earlier);
		expect(seen[0].req.attachments).toBeUndefined();
		expect(seen[0].req.prompt).toBe("follow-up");
		expect(parts.some((p) => p["type"] === "error")).toBe(false);
	});

	test("all-or-nothing: enabled + image AND a PDF part → actionable error naming the type; runner never invoked", async () => {
		const mixed = [
			{
				role: "user",
				content: [
					{ type: "text", text: "see these" },
					{ type: "image", image: "aGVsbG8=", mediaType: "image/png" },
					{ type: "file", mediaType: "application/pdf", data: "bb" },
				],
			},
		] as unknown as Parameters<LanguageModelV3["doStream"]>[0]["prompt"];
		const { model, seen } = makeEnabledModel({ envelope: OK_ENVELOPE });
		const parts = await drainWithPrompt(model, mixed);
		expect(parts.map((p) => p["type"])).toEqual(["stream-start", "error"]);
		const err = (parts[1] as { error: APICallError }).error;
		expect(APICallError.isInstance(err)).toBe(true);
		expect(err.isRetryable).toBe(false);
		// Actionable: names the unsupported type and the text alternative.
		expect(err.message).toContain("application/pdf");
		expect(err.message).toContain("text");
		// Nothing staged, nothing run.
		expect(seen).toHaveLength(0);
	});

	test("enabled + unreachable image-url → fetch failure surfaces as an actionable error part", async () => {
		const remote = [
			{ role: "user", content: [{ type: "image-url", image_url: { url: "http://127.0.0.1:1/x.png" } }] },
		] as unknown as Parameters<LanguageModelV3["doStream"]>[0]["prompt"];
		const { model, seen } = makeEnabledModel({ envelope: OK_ENVELOPE });
		const parts = await drainWithPrompt(model, remote);
		expect(parts.map((p) => p["type"])).toEqual(["stream-start", "error"]);
		const err = (parts[1] as { error: APICallError }).error;
		expect(APICallError.isInstance(err)).toBe(true);
		expect(err.isRetryable).toBe(false);
		expect(err.message).toContain("failed to fetch");
		expect(seen).toHaveLength(0);
	});

	test("D7 notice: staged attachments NOT inspected → reasoning-delta says so (never silently seen)", async () => {
		const { model } = makeEnabledModel({
			envelope: OK_ENVELOPE,
			stagedAttachments: [".agy-attachments/aaaaaaaaaaaaaaaa.png"],
			attachmentsInspected: false,
		});
		const parts = await drainWithPrompt(model, BRIDGE_PROMPT);
		const deltas = (parts.filter((p) => p["type"] === "reasoning-delta") as Array<{ delta: string }>).map(
			(d) => d.delta,
		);
		expect(deltas.some((d) => d.includes("not inspected"))).toBe(true);
		expect(deltas.some((d) => d.includes("view_file"))).toBe(true);
	});

	test("D7 notice: attachments inspected via view_file → NO notice delta", async () => {
		const { model } = makeEnabledModel({
			envelope: OK_ENVELOPE,
			stagedAttachments: [".agy-attachments/aaaaaaaaaaaaaaaa.png"],
			attachmentsInspected: true,
		});
		const parts = await drainWithPrompt(model, BRIDGE_PROMPT);
		const deltas = (parts.filter((p) => p["type"] === "reasoning-delta") as Array<{ delta: string }>).map(
			(d) => d.delta,
		);
		expect(deltas.some((d) => d.includes("not inspected"))).toBe(false);
	});

	test("D7 notice: turns without attachments never emit the notice", async () => {
		const { model } = makeEnabledModel({ envelope: OK_ENVELOPE });
		const parts = await drainWithPrompt(model, BRIDGE_PROMPT);
		const deltas = (parts.filter((p) => p["type"] === "reasoning-delta") as Array<{ delta: string }>).map(
			(d) => d.delta,
		);
		expect(deltas.some((d) => d.includes("not inspected"))).toBe(false);
	});

	test("staging failure (AgyAttachmentError from the runner) → non-retryable error part with the actionable detail", async () => {
		const { model } = makeEnabledModel({
			throw: new AgyAttachmentError("refusing to stage .agy-attachments/x.png: the path already exists as a symlink"),
		});
		const parts = await drainWithPrompt(model, BRIDGE_PROMPT);
		expect(parts.map((p) => p["type"])).toEqual(["stream-start", "error"]);
		const err = (parts[1] as { error: APICallError }).error;
		expect(APICallError.isInstance(err)).toBe(true);
		expect(err.isRetryable).toBe(false);
		expect(err.message).toContain("refusing to stage");
	});
});

