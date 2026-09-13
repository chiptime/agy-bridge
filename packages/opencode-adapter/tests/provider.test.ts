/**
 * Unit tests for the provider factory (spec R3/R8, design D3): opencode's
 * custom-provider loader (verified against the 1.18.29 binary) imports the
 * package's "./provider" entry, picks the export whose name starts with
 * "create", and calls it with { name: providerID, ...mergedOptions }; model
 * resolution then calls .languageModel(modelId). These tests pin that
 * contract: a ProviderV3-shaped factory whose languageModel(id) returns the
 * V3 model with registry-resolved ids/modelArgs, standard NoSuchModelError
 * for unsupported model kinds, config validation at factory time, and the
 * factory→model→runner glue (config, store path from stateDir, session
 * context) verified through an injected fake runner.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { NoSuchModelError } from "@ai-sdk/provider";
import { createAgyProvider } from "../src/provider";
import { AgyLanguageModel } from "../src/language-model";
import type { TurnDeps, TurnRequest, TurnResult } from "../src/turn";
import { AgyConfigError } from "../src/config";

const OK_RESULT: TurnResult = {
	classification: { outcome: "success", reason: "" },
	run: {
		exitCode: 0,
		timedOut: false,
		log: "",
		elapsedMs: 1,
		envelope: { conversation_id: "c1", status: "SUCCESS", response: "ok" },
		conversationId: "c1",
	},
	resumed: false,
	diverged: false,
	logPath: "/tmp/run.log",
	conversationId: "c1",
};

describe("unit: provider — createAgyProvider factory contract (R3/R8)", () => {
	test("languageModel(id) returns the V3 model with registry-resolved ids", () => {
		const provider = createAgyProvider();
		expect(provider.specificationVersion).toBe("v3");
		const def = provider.languageModel("default");
		expect(def).toBeInstanceOf(AgyLanguageModel);
		expect(def.specificationVersion).toBe("v3");
		expect(def.provider).toBe("agy");
		expect(def.modelId).toBe("agy/default");
		const gemini = provider.languageModel("agy/gemini-3.8-flash-high");
		expect(gemini.modelId).toBe("agy/gemini-3.8-flash-high");
		const custom = provider.languageModel("custom");
		expect(custom.modelId).toBe("agy/custom");
		// The name option (opencode's config key) is honored for provider identity.
		expect(createAgyProvider({ name: "myagy" }).languageModel("default").provider).toBe("myagy");
	});

	test("unsupported model kinds throw NoSuchModelError (standard provider contract)", () => {
		const provider = createAgyProvider();
		expect(() => provider.embeddingModel("default")).toThrow(NoSuchModelError);
		expect(() => provider.imageModel("default")).toThrow(NoSuchModelError);
		let caught: NoSuchModelError | undefined;
		try {
			provider.embeddingModel("x");
		} catch (err) {
			caught = err as NoSuchModelError;
		}
		expect(caught?.modelType).toBe("embeddingModel");
		expect(caught?.modelId).toBe("x");
	});

	test("invalid options fail at factory time (config errors before any wiring)", () => {
		expect(() => createAgyProvider({ workdirMode: "bogus" as never })).toThrow(AgyConfigError);
		expect(() => createAgyProvider({ models: { "agy/x": { limit: { context: 10, output: 20 } } } })).toThrow(
			AgyConfigError,
		);
	});

	test("glue: factory wires config, stateDir-backed store, and session context into the runner", async () => {
		const stateDir = await mkdtemp("/tmp/agy-provider-");
		const seen: Array<{ deps: TurnDeps; req: TurnRequest }> = [];
		const run = async (deps: TurnDeps, req: TurnRequest): Promise<TurnResult> => {
			seen.push({ deps, req });
			return OK_RESULT;
		};
		const provider = createAgyProvider({ stateDir, scratchRoot: "/tmp" }, { run });
		const { stream } = await provider.languageModel("default").doStream({
			prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			providerOptions: { agy: { sessionId: "sess-glue", worktree: "/wt/glue" } },
		});
		const reader = stream.getReader();
		const parts: Array<{ type: string }> = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(value as { type: string });
		}
		// The mapped turn ran end to end through the factory-built model.
		expect(parts.map((p) => p.type)).toEqual(["stream-start", "text-start", "text-delta", "text-end", "finish"]);
		expect(seen).toHaveLength(1);
		expect(seen[0].req.prompt).toBe("hi");
		expect(seen[0].req.sessionId).toBe("sess-glue");
		expect(seen[0].deps.worktree).toBe("/wt/glue");
		expect(seen[0].deps.config.scratchRoot).toBe("/tmp");
		// The store is the REAL session map, rooted at the configured stateDir.
		await seen[0].deps.store.bind("sess-glue", "c1");
		const mapFile = join(stateDir, "agy-bridge", "opencode-sessions.json");
		expect(JSON.parse(readFileSync(mapFile, "utf8")).sessions["sess-glue"][0].conversationId).toBe("c1");
	});

	test("runtime harness: full stack through a REAL spawned fake agy binary", async () => {
		const stateDir = await mkdtemp("/tmp/agy-provider-rt-");
		const scratchRoot = await mkdtemp("/tmp/agy-provider-scratch-");
		// A real executable standing in for agy: streams the NDJSON contract
		// (init → step_update → result) and exits 0. The real spawn, stream
		// tap, turn orchestration, classification, and store all run for real.
		const bin = join(stateDir, "fake-agy.sh");
		writeFileSync(
			bin,
			[
				"#!/bin/sh",
				`echo '{"event":"init","conversation_id":"conv-rt"}'`,
				`echo '{"event":"step_update","step":"real spawn"}'`,
				`echo '{"event":"result","result":{"conversation_id":"conv-rt","status":"SUCCESS","response":"real answer","usage":{"input_tokens":3,"output_tokens":2,"thinking_tokens":1,"cache_read_tokens":0,"total_tokens":6}}}'`,
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		chmodSync(bin, 0o755);
		const provider = createAgyProvider({ stateDir, scratchRoot, timeoutMs: 30_000 }, { bin });
		const { stream } = await provider.languageModel("default").doStream({
			prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
			providerOptions: { agy: { sessionId: "sess-rt" } },
		});
		const reader = stream.getReader();
		const parts: Array<Record<string, unknown>> = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			parts.push(value as Record<string, unknown>);
		}
		expect(parts.map((p) => p["type"])).toEqual([
			"stream-start",
			"reasoning-start",
			"reasoning-delta",
			"reasoning-end",
			"text-start",
			"text-delta",
			"text-end",
			"finish",
		]);
		expect((parts.find((p) => p["type"] === "text-delta") as { delta: string }).delta).toBe("real answer");
		const finish = parts.at(-1) as { usage: { inputTokens: { total: number } } };
		expect(finish.usage.inputTokens.total).toBe(3);
		// The turn bound the conversation in the real session map.
		const mapFile = join(stateDir, "agy-bridge", "opencode-sessions.json");
		expect(JSON.parse(readFileSync(mapFile, "utf8")).sessions["sess-rt"][0].conversationId).toBe("conv-rt");
	});
});
