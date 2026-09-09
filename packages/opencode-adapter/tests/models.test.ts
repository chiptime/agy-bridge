/**
 * Unit tests for the model registry (spec R8.s1–s3): agy/default first with
 * no --model, live-verified IDs, unknown passthrough, config merge, default
 * limits 128000/8192, and the gemini-pool routing hint via the engine.
 * Plus the dynamic-discovery registry (resolveRegistry) and the host-facing
 * ModelV2 record builder consumed by the plugin's provider.models hook.
 */
import { describe, expect, test } from "bun:test";
import { listModels, resolveModel, resolveRegistry, buildModelRecord } from "../src/models";

/** Real-shaped discovery sample from `agy models` (v1.1.28, 2026-09-09). */
const DISCOVERED_SAMPLE = [
	{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
	{ id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
	{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
];

describe("unit: models — registry, merge, passthrough, pool hint", () => {
	test("R8.s1: registry order — agy/default FIRST, then live-verified IDs", () => {
		const ids = listModels().map((m) => m.id);
		expect(ids).toEqual([
			"agy/default",
			"agy/gemini-3.8-flash-high",
			"agy/gemini-3.8-flash-medium",
			"agy/gemini-3.8-flash-low",
		]);
	});

	test("R8.s2: agy/default maps to NO --model argument", () => {
		expect(resolveModel("agy/default").modelArg).toBeUndefined();
	});

	test("R8.s3: unknown ids pass through as --model <suffix>", () => {
		const m = resolveModel("agy/custom");
		expect(m.modelArg).toBe("custom");
		expect(m.id).toBe("agy/custom");
	});

	test("bare ids normalize: 'default' resolves like 'agy/default'", () => {
		expect(resolveModel("default").modelArg).toBeUndefined();
		expect(resolveModel("gemini-3.8-flash-low").modelArg).toBe("gemini-3.8-flash-low");
	});

	test("default limits are 128000 context / 8192 output for every entry incl. passthrough", () => {
		for (const id of ["agy/default", "agy/gemini-3.8-flash-high", "agy/whatever"]) {
			expect(resolveModel(id).limit).toEqual({ context: 128000, output: 8192 });
		}
	});

	test("config merge: overrides keep their registry position, extensions append", () => {
		const merged = listModels({
			"agy/gemini-3.8-flash-high": { name: "Fast lane", limit: { context: 1000, output: 500 } },
			"agy/mistral-large": { name: "Mistral" },
		});
		expect(merged.map((m) => m.id)).toEqual([
			"agy/default",
			"agy/gemini-3.8-flash-high",
			"agy/gemini-3.8-flash-medium",
			"agy/gemini-3.8-flash-low",
			"agy/mistral-large",
		]);
		const overridden = merged[1];
		expect(overridden.name).toBe("Fast lane");
		expect(overridden.limit).toEqual({ context: 1000, output: 500 });
		expect(overridden.modelArg).toBe("gemini-3.8-flash-high");
		expect(resolveModel("agy/mistral-large", { "agy/mistral-large": { name: "Mistral" } }).modelArg).toBe(
			"mistral-large",
		);
	});

	test("pool hint: gemini-prefixed model args route to the gemini pool, others to 3p", () => {
		expect(resolveModel("agy/gemini-3.8-flash-high").pool).toBe("gemini");
		expect(resolveModel("agy/custom").pool).toBe("3p");
		// agy/default sends no --model; the literal R8 rule (no gemini prefix → 3p)
		// routes it to the 3p pool. agy decides the actual backend at run time.
		expect(resolveModel("agy/default").pool).toBe("3p");
	});
});

describe("unit: models — dynamic registry via resolveRegistry (discovery merge)", () => {
	test("merge order: agy/default first, then discovered models with display names and modelArg", () => {
		const reg = resolveRegistry({}, DISCOVERED_SAMPLE);
		expect(reg.map((m) => m.id)).toEqual([
			"agy/default",
			"agy/gemini-3.8-flash-high",
			"agy/gemini-3.1-pro-high",
			"agy/claude-sonnet-4-6",
		]);
		expect(reg[0].modelArg).toBeUndefined(); // agy/default → NO --model (R8.s2)
		expect(reg[1].name).toBe("Gemini 3.8 Flash (High)");
		expect(reg[1].modelArg).toBe("gemini-3.8-flash-high");
	});

	test("undefined or empty discovery falls back to the static builtin list", () => {
		const staticIds = listModels().map((m) => m.id);
		expect(resolveRegistry({}).map((m) => m.id)).toEqual(staticIds);
		expect(resolveRegistry({}, []).map((m) => m.id)).toEqual(staticIds);
	});

	test("config models override discovered entries IN PLACE (wins over discovery) and extend at the end", () => {
		const reg = resolveRegistry(
			{
				"agy/gemini-3.1-pro-high": { name: "Pro lane", limit: { context: 10_000, output: 1_000 } },
				"agy/mistral-large": { name: "Mistral" },
			},
			DISCOVERED_SAMPLE,
		);
		expect(reg.map((m) => m.id)).toEqual([
			"agy/default",
			"agy/gemini-3.8-flash-high",
			"agy/gemini-3.1-pro-high",
			"agy/claude-sonnet-4-6",
			"agy/mistral-large",
		]);
		const pro = reg.find((m) => m.id === "agy/gemini-3.1-pro-high");
		expect(pro?.name).toBe("Pro lane");
		expect(pro?.limit).toEqual({ context: 10_000, output: 1_000 });
		expect(pro?.modelArg).toBe("gemini-3.1-pro-high");
	});

	test("dedupe by id keeps the FIRST occurrence (our agy/default wins, discovery dupes collapse)", () => {
		const reg = resolveRegistry(
			{},
			[
				{ id: "gemini-3.8-flash-high", name: "A" },
				{ id: "default", name: "Default (from agy)" },
				{ id: "gemini-3.8-flash-high", name: "B" },
				{ id: "x-1", name: "X" },
			],
		);
		const ids = reg.map((m) => m.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(reg[0].id).toBe("agy/default");
		expect(reg[0].name).toBe("default");
		const flash = reg.filter((m) => m.id === "agy/gemini-3.8-flash-high");
		expect(flash).toHaveLength(1);
		expect(flash[0].name).toBe("A");
	});

	test("pool hint still routes discovered ids through the engine's poolForModel", () => {
		const reg = resolveRegistry({}, DISCOVERED_SAMPLE);
		expect(reg.find((m) => m.id === "agy/gemini-3.8-flash-high")?.pool).toBe("gemini");
		expect(reg.find((m) => m.id === "agy/claude-sonnet-4-6")?.pool).toBe("3p");
	});
});

describe("unit: models — host model record for the provider.models hook (ModelV2)", () => {
	test("buildModelRecord keys BARE suffixes and fills the full ModelV2 descriptor", () => {
		const record = buildModelRecord(resolveRegistry({}, DISCOVERED_SAMPLE), "agy");
		expect(Object.keys(record)).toEqual([
			"default",
			"gemini-3.8-flash-high",
			"gemini-3.1-pro-high",
			"claude-sonnet-4-6",
		]);
		const m = record["claude-sonnet-4-6"];
		expect(m.id).toBe("claude-sonnet-4-6");
		expect(m.providerID).toBe("agy");
		expect(m.name).toBe("Claude Sonnet 4.6");
		expect(m.limit).toEqual({ context: 128000, output: 8192 });
		expect(m.status).toBe("active");
		expect(m.capabilities.toolcall).toBe(true);
		expect(m.capabilities.attachment).toBe(false);
		expect(m.capabilities.input.text).toBe(true);
		expect(m.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } });
		expect(m.options).toEqual({});
		expect(m.headers).toEqual({});
	});

	test("config limit overrides flow into the host record", () => {
		const reg = resolveRegistry(
			{ "agy/claude-sonnet-4-6": { limit: { context: 50_000, output: 4_096 } } },
			DISCOVERED_SAMPLE,
		);
		const record = buildModelRecord(reg, "agy");
		expect(record["claude-sonnet-4-6"].limit).toEqual({ context: 50_000, output: 4096 });
	});
});
