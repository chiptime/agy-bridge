/**
 * Unit tests for the model registry (spec R8.s1–s3): agy/default first with
 * no --model, live-verified IDs, unknown passthrough, config merge, default
 * limits 128000/8192, and the gemini-pool routing hint via the engine.
 * Plus the dynamic-discovery registry (resolveRegistry), the host-facing
 * ModelV2 record builder consumed by the plugin's provider.models hook, and
 * the effort-variant collapse (suffixed agy ids → one base entry with
 * per-effort variant payloads).
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
	// DELIBERATE CHANGE (effort-variant collapse): the static fallback list
	// now routes through the same collapse as live discovery (mirroring the
	// pi-adapter), so the three suffixed Gemini tiers surface as ONE base
	// entry "agy/gemini-3.8-flash" with high/medium/low variants instead of
	// three flat entries.
	test("R8.s1: registry order — agy/default FIRST, suffixed tiers collapsed into the base", () => {
		const ids = listModels().map((m) => m.id);
		expect(ids).toEqual(["agy/default", "agy/gemini-3.8-flash"]);
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
		// DELIBERATE CHANGE: with collapsing, the override key is the collapsed
		// BASE id; a legacy suffixed key extends flat at the end (pinned-config
		// back-compat path), and the extension case is unchanged.
		const merged = listModels({
			"agy/gemini-3.8-flash": { name: "Fast lane", limit: { context: 1000, output: 500 } },
			"agy/gemini-3.8-flash-high": { name: "Legacy pin" },
			"agy/mistral-large": { name: "Mistral" },
		});
		expect(merged.map((m) => m.id)).toEqual([
			"agy/default",
			"agy/gemini-3.8-flash",
			// Extensions append in CONFIG insertion order: the legacy suffixed
			// pin (flat, full-id modelArg) then the unknown extension.
			"agy/gemini-3.8-flash-high",
			"agy/mistral-large",
		]);
		const overridden = merged[1];
		expect(overridden.name).toBe("Fast lane");
		expect(overridden.limit).toEqual({ context: 1000, output: 500 });
		// modelArg of the collapsed base is preserved through the override.
		expect(overridden.modelArg).toBe("gemini-3.8-flash-high");
		expect(overridden.variants).toBeDefined();
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
	// DELIBERATE CHANGE (effort-variant collapse): suffixed discovered ids
	// surface as their BASE model (variants carry the full agy ids), bare ids
	// stay flat.
	test("merge order: agy/default first, suffixed ids collapsed to bases, bare ids flat", () => {
		const reg = resolveRegistry({}, DISCOVERED_SAMPLE);
		expect(reg.map((m) => m.id)).toEqual([
			"agy/default",
			"agy/gemini-3.8-flash",
			"agy/gemini-3.1-pro",
			"agy/claude-sonnet-4-6",
		]);
		expect(reg[0].modelArg).toBeUndefined(); // agy/default → NO --model (R8.s2)
		// DELIBERATE CHANGE (loud base naming): the collapsed base is named
		// after the BARE id, not the first-discovered row's name — that name
		// carries the effort suffix ("... (High)"), which reads wrong for a
		// model whose whole point is selectable effort.
		expect(reg[1].name).toBe("gemini-3.8-flash");
	});

	test("undefined or empty discovery falls back to the static builtin list", () => {
		const staticIds = listModels().map((m) => m.id);
		expect(resolveRegistry({}).map((m) => m.id)).toEqual(staticIds);
		expect(resolveRegistry({}, []).map((m) => m.id)).toEqual(staticIds);
	});

	test("config-fed variants ride into the registry (the runtime channel for collapsed bases)", () => {
		// opencode does not consult the plugin provider.models hook, so the
		// ONLY way a config-declared base resolves its effort at turn time is
		// variants surviving applyConfig (provider.agy.options.models).
		const reg = resolveRegistry(
			{
				"gemini-3.7-flash": {
					name: "Gemini 3.7 Flash",
					variants: {
						high: { agyModelId: "gemini-3.7-flash-high" },
						low: { agyModelId: "gemini-3.7-flash-low" },
					},
				},
			},
			[],
		);
		const entry = reg.find((m) => m.id === "agy/gemini-3.7-flash");
		expect(entry).toBeDefined();
		// DELIBERATE: bare config keys normalize to the full agy/<id> form.
		expect(entry?.variants?.high?.agyModelId).toBe("gemini-3.7-flash-high");
		expect(entry?.variants?.low?.agyModelId).toBe("gemini-3.7-flash-low");
		// Fallback parity with the builtin collapse: highest effort, never the bare id.
		expect(entry?.modelArg).toBe("gemini-3.7-flash-high");
	});

	test("config-fed variants override the payload of an existing builtin base in place", () => {
		const reg = resolveRegistry(
			{
				"gemini-3.8-flash": {
					variants: { high: { agyModelId: "gemini-3.8-flash-high" }, low: { agyModelId: "gemini-3.8-flash-low" } },
				},
			},
			[],
		);
		const flash = reg.find((m) => m.id === "agy/gemini-3.8-flash");
		expect(flash).toBeDefined();
		expect(Object.keys(flash?.variants ?? {}).sort()).toEqual(["high", "low"]);
		expect(flash?.name).toBe("gemini-3.8-flash"); // name/position preserved
	});

	test("config models override discovered entries IN PLACE (wins over discovery) and extend at the end", () => {
		const reg = resolveRegistry(
			{
				"agy/gemini-3.1-pro": { name: "Pro lane", limit: { context: 10_000, output: 1_000 } },
				"agy/mistral-large": { name: "Mistral" },
			},
			DISCOVERED_SAMPLE,
		);
		expect(reg.map((m) => m.id)).toEqual([
			"agy/default",
			"agy/gemini-3.8-flash",
			"agy/gemini-3.1-pro",
			"agy/claude-sonnet-4-6",
			"agy/mistral-large",
		]);
		const pro = reg.find((m) => m.id === "agy/gemini-3.1-pro");
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
		const flash = reg.filter((m) => m.id === "agy/gemini-3.8-flash");
		expect(flash).toHaveLength(1);
		// DELIBERATE CHANGE (loud base naming): bare-id name, not "A" (the
		// first row's effort-suffixed name).
		expect(flash[0].name).toBe("gemini-3.8-flash");
	});

	test("pool hint still routes discovered ids through the engine's poolForModel", () => {
		const reg = resolveRegistry({}, DISCOVERED_SAMPLE);
		// Collapsed base: modelArg fallback is the full (gemini-prefixed) id.
		expect(reg.find((m) => m.id === "agy/gemini-3.8-flash")?.pool).toBe("gemini");
		expect(reg.find((m) => m.id === "agy/claude-sonnet-4-6")?.pool).toBe("3p");
	});
});

describe("unit: models — host model record for the provider.models hook (ModelV2)", () => {
	test("buildModelRecord keys BARE suffixes and fills the full ModelV2 descriptor", () => {
		const record = buildModelRecord(resolveRegistry({}, DISCOVERED_SAMPLE), "agy");
		expect(Object.keys(record)).toEqual([
			"default",
			"gemini-3.8-flash",
			"gemini-3.1-pro",
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
		// Transport self-reference: opencode imports api.npm DIRECTLY when it
		// starts with file:// — the record must point at THIS package's
		// provider entry so unpublished installs resolve their transport.
		expect(m.api.url).toBe("");
		expect(m.api.npm.startsWith("file://")).toBe(true);
		expect(m.api.npm.endsWith("/provider.js")).toBe(true);
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

describe("unit: models — effort-variant collapse (suffixed ids → base entries with variants)", () => {
	/** Mirrors the real 14-model discovery: effort suffixes, bare ids, and a
	 * "-thinking"/"-medium" id that exercises the suffix edge cases. */
	const FULL_DISCOVERY = [
		{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
		{ id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
		{ id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
		{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
		{ id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
		{ id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
	];

	test("suffixed ids collapse into ONE base entry; bare ids and non-effort suffixes stay flat", () => {
		const reg = resolveRegistry({}, FULL_DISCOVERY);
		expect(reg.map((m) => m.id)).toEqual([
			"agy/default",
			"agy/gemini-3.8-flash",
			"agy/claude-sonnet-4-6",
			"agy/claude-opus-4-6-thinking",
			// "-medium" IS an effort suffix: gpt-oss-120b-medium collapses too.
			"agy/gpt-oss-120b",
		]);
	});

	test("variant payloads carry the full agy id as agyModelId (--model channel)", () => {
		const base = resolveRegistry({}, FULL_DISCOVERY).find((m) => m.id === "agy/gemini-3.8-flash");
		expect(base?.variants).toEqual({
			high: { agyModelId: "gemini-3.8-flash-high" },
			medium: { agyModelId: "gemini-3.8-flash-medium" },
			low: { agyModelId: "gemini-3.8-flash-low" },
		});
	});

	test("bare and non-effort-suffix ids are flat: no variants key", () => {
		const reg = resolveRegistry({}, FULL_DISCOVERY);
		expect(reg.find((m) => m.id === "agy/claude-sonnet-4-6")?.variants).toBeUndefined();
		expect(reg.find((m) => m.id === "agy/claude-opus-4-6-thinking")?.variants).toBeUndefined();
	});

	test("agy/default stays first with modelArg undefined and no variants", () => {
		const reg = resolveRegistry({}, FULL_DISCOVERY);
		expect(reg[0].id).toBe("agy/default");
		expect(reg[0].modelArg).toBeUndefined();
		expect(reg[0].variants).toBeUndefined();
	});

	test("collapsed base modelArg falls back to the HIGHEST discovered effort (no bare agy id exists)", () => {
		const reg = resolveRegistry({}, FULL_DISCOVERY);
		expect(reg.find((m) => m.id === "agy/gemini-3.8-flash")?.modelArg).toBe("gemini-3.8-flash-high");
		// Partial efforts: high missing → medium wins; only low → low.
		const partial = resolveRegistry(
			{},
			[
				{ id: "x-low", name: "X (Low)" },
				{ id: "y-medium", name: "Y (Medium)" },
			],
		);
		expect(partial.find((m) => m.id === "agy/x")?.modelArg).toBe("x-low");
		expect(partial.find((m) => m.id === "agy/y")?.modelArg).toBe("y-medium");
	});

	test("backward compat: suffixed ids stay DIRECTLY selectable via resolveModel (passthrough)", () => {
		// The picker no longer lists flat suffixed entries, but a session (or
		// pinned config) holding agy/gemini-3.8-flash-high must keep working.
		const m = resolveModel("agy/gemini-3.8-flash-high");
		expect(m.id).toBe("agy/gemini-3.8-flash-high");
		expect(m.modelArg).toBe("gemini-3.8-flash-high");
		expect(m.pool).toBe("gemini");
		// Bare suffixed id without the agy/ prefix resolves identically.
		expect(resolveModel("gemini-3.8-flash-medium").modelArg).toBe("gemini-3.8-flash-medium");
	});

	test("clean picker: flat suffixed entries do NOT appear in the host record keys", () => {
		const record = buildModelRecord(resolveRegistry({}, FULL_DISCOVERY), "agy");
		const keys = Object.keys(record);
		expect(keys).toEqual(["default", "gemini-3.8-flash", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b"]);
		expect(keys.some((k) => k.endsWith("-high") || k.endsWith("-medium") || k.endsWith("-low"))).toBe(false);
	});

	test("buildModelRecord emits the variants payload on collapsed bases only", () => {
		const record = buildModelRecord(resolveRegistry({}, FULL_DISCOVERY), "agy");
		expect(record["gemini-3.8-flash"].variants).toEqual({
			high: { agyModelId: "gemini-3.8-flash-high" },
			medium: { agyModelId: "gemini-3.8-flash-medium" },
			low: { agyModelId: "gemini-3.8-flash-low" },
		});
		expect(record["gpt-oss-120b"].variants).toEqual({
			medium: { agyModelId: "gpt-oss-120b-medium" },
		});
		expect(record["claude-sonnet-4-6"].variants).toBeUndefined();
	});
});
