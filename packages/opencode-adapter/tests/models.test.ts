/**
 * Unit tests for the model registry (spec R8.s1–s3): agy/default first with
 * no --model, live-verified IDs, unknown passthrough, config merge, default
 * limits 128000/8192, and the gemini-pool routing hint via the engine.
 */
import { describe, expect, test } from "bun:test";
import { listModels, resolveModel } from "../src/models";

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
