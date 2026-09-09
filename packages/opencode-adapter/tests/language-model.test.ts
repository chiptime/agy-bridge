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
import { AgyLanguageModel, formatStepUpdate } from "../src/language-model";
import { TurnError, type TurnDeps, type TurnRequest, type TurnResult } from "../src/turn";
import type { SessionStore } from "../src/session-store";
import { resolveConfig, type AgyAdapterConfig } from "../src/config";

/** Minimal fake store: a fixed mapping (or none) plus a call log. */
function fakeStore(existing?: string): { store: SessionStore; lookedUp: string[] } {
	const lookedUp: string[] = [];
	return {
		lookedUp,
		store: {
			get: async (id) => {
				lookedUp.push(id);
				return existing;
			},
			bind: async () => {},
			rebind: async () => {},
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
}

/** Fake runner: records deps+req, replays lines, optionally resumes/throws
 * (the throw lands AFTER the lines so mid-run failure states are testable). */
function fakeRunner(run: FakeRun): (deps: TurnDeps, req: TurnRequest) => Promise<TurnResult> {
	return async (deps, req) => {
		for (const line of run.lines ?? []) req.onLine?.(line);
		if (run.throw) throw run.throw;
		if (run.resume) req.onResume?.();
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
			logPath: "/tmp/agy-run-x/run.log",
			conversationId: run.envelope?.conversation_id,
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

function makeModel(run: FakeRun, existing?: string) {
	const { store, lookedUp } = fakeStore(existing);
	const model = new AgyLanguageModel({
		provider: "agy",
		modelId: "agy/default",
		config: resolveConfig({ scratchRoot: "/tmp" }) as AgyAdapterConfig,
		store,
		run: fakeRunner(run),
	});
	return { model, lookedUp };
}

/** Drain a doStream result into an ordered part list. */
async function drain(
	model: AgyLanguageModel,
	providerOptions?: SharedV3ProviderOptions,
	signal?: AbortSignal,
) {
	const { stream } = await model.doStream({ prompt: PROMPT, providerOptions, abortSignal: signal });
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
		const { store } = fakeStore("conv-existing");
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
		// No providerOptions.agy → session key falls back to a generated id.
		expect(freshSeen[0].req.sessionId).toMatch(/^[0-9a-f-]{8,}$/);
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
			"▸ tool view_file…\n",
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
	{ name: "tool ACTIVE", step: { step_type: "tool", state: "ACTIVE", tool_name: "view_file" }, want: "▸ tool view_file…\n" },
	{ name: "tool DONE rounds duration to 1 decimal", step: { step_type: "tool", state: "DONE", tool_name: "view_file", duration_seconds: 0.28 }, want: "✓ view_file (0.3s)\n" },
	{ name: "tool DONE without duration", step: { step_type: "tool", state: "DONE", tool_name: "bash" }, want: "✓ bash\n" },
	{ name: "tool DONE with whole-number duration", step: { step_type: "tool", state: "DONE", tool_name: "bash", duration_seconds: 4 }, want: "✓ bash (4.0s)\n" },
	{ name: "tool ERROR", step: { step_type: "tool", state: "ERROR", tool_name: "bash" }, want: "✗ bash failed\n" },
	{ name: "tool ACTIVE without tool_name falls back", step: { step_type: "tool", state: "ACTIVE", step_index: 2 }, want: '{"step_type":"tool","state":"ACTIVE","step_index":2}\n' },
	{ name: "tool with unknown state falls back", step: { step_type: "tool", state: "WEIRD", tool_name: "bash" }, want: '{"step_type":"tool","state":"WEIRD","tool_name":"bash"}\n' },
	{ name: "agent_response DONE with duration", step: { step_type: "agent_response", state: "DONE", duration_seconds: 3.17 }, want: "● response (3.2s)\n" },
	{ name: "agent_response DONE without duration", step: { step_type: "agent_response", state: "DONE" }, want: "● response\n" },
	{ name: "agent_response other states show progress", step: { step_type: "agent_response", state: "ACTIVE" }, want: "▸ response…\n" },
	{ name: "user_input is a prompt line regardless of state", step: { step_type: "user_input", state: "DONE" }, want: "▸ prompt\n" },
	{ name: "unknown step_type falls back", step: { step_type: "mystery", step_index: 9 }, want: '{"step_type":"mystery","step_index":9}\n' },
	{ name: "missing step_type falls back", step: { state: "ACTIVE" }, want: '{"state":"ACTIVE"}\n' },
	{ name: "non-numeric duration treated as missing", step: { step_type: "tool", state: "DONE", tool_name: "x", duration_seconds: "0.5" }, want: "✓ x\n" },
	{ name: "empty record falls back to the placeholder", step: {}, want: "(step update)\n" },
];

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
});
