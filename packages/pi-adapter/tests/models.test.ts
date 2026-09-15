/**
 * Unit tests for the pi model registry (spec R2): discovery merge with the
 * default entry FIRST and no --model, effort-suffix collapse into base
 * models whose thinkingLevelMap routes pi thinking levels to FULL agy ids,
 * flat reasoning:false for ids without a known suffix, the static fallback
 * catalog when discovery is empty or failed (startup never throws), the
 * config override/extend merge, and the provider-facing declarations
 * (text-only, zero cost, 1M context / 65536 output).
 */
import { describe, expect, test } from "bun:test";
import {
	DEFAULT_LIMITS,
	resolveRegistry,
	toProviderModel,
	type DiscoveredEntry,
} from "../src/models";

const FLASH_TIERS: DiscoveredEntry[] = [
	{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash High" },
	{ id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash Medium" },
	{ id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash Low" },
];

describe("unit: models — discovery merge and default entry (R2)", () => {
	test("our default entry is FIRST and spawns WITHOUT --model", () => {
		const registry = resolveRegistry({}, [{ id: "gemini-3-pro", name: "Gemini 3 Pro" }]);
		expect(registry[0]).toMatchObject({ id: "default", name: "default", modelArg: undefined });
		expect(registry[1]).toMatchObject({ id: "gemini-3-pro", modelArg: "gemini-3-pro" });
	});

	test("a discovered 'default' row never displaces ours; duplicate ids dedupe first-wins", () => {
		const registry = resolveRegistry({}, [
			{ id: "default", name: "Hostile Default" },
			{ id: "default", name: "Hostile Default Again" },
		]);
		expect(registry).toHaveLength(1);
		expect(registry[0]).toMatchObject({ id: "default", name: "default" });
	});

	test("agy/-prefixed discovery rows normalize to bare registry ids", () => {
		const registry = resolveRegistry({}, [{ id: "agy/gemini-3.8-flash-high", name: "X" }, ...FLASH_TIERS.slice(1)]);
		expect(registry.map((m) => m.id)).toEqual(["default", "gemini-3.8-flash"]);
	});
});

describe("unit: models — effort-suffix collapse into thinkingLevelMap (R2)", () => {
	test("high/medium/low variants collapse into the base model; map values are FULL agy ids", () => {
		const registry = resolveRegistry({}, FLASH_TIERS);
		expect(registry.map((m) => m.id)).toEqual(["default", "gemini-3.8-flash"]);
		const base = registry[1];
		expect(base.modelArg).toBe("gemini-3.8-flash");
		expect(base.reasoning).toBe(true);
		expect(base.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "gemini-3.8-flash-low",
			medium: "gemini-3.8-flash-medium",
			high: "gemini-3.8-flash-high",
			xhigh: null,
			max: null,
		});
	});

	test("ids without a known effort suffix stay flat with reasoning:false", () => {
		const registry = resolveRegistry({}, [{ id: "claude-opus-4.6", name: "Claude Opus 4.6" }]);
		const flat = registry[1];
		expect(flat).toMatchObject({ id: "claude-opus-4.6", reasoning: false, modelArg: "claude-opus-4.6" });
		expect(flat.thinkingLevelMap).toBeUndefined();
	});

	test("partial tiers: only discovered efforts route, the rest map to null", () => {
		const registry = resolveRegistry({}, [FLASH_TIERS[0]]);
		expect(registry.map((m) => m.id)).toEqual(["default", "gemini-3.8-flash"]);
		expect(registry[1].thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: "gemini-3.8-flash-high",
			xhigh: null,
			max: null,
		});
	});

	test("a variant without a base row synthesizes the base entry with the base id", () => {
		const registry = resolveRegistry({}, [{ id: "gpt-6.2-high", name: "GPT 6.2 High" }]);
		expect(registry.map((m) => m.id)).toEqual(["default", "gpt-6.2"]);
		expect(registry[1]).toMatchObject({ name: "gpt-6.2", modelArg: "gpt-6.2", reasoning: true });
		expect(registry[1].thinkingLevelMap?.high).toBe("gpt-6.2-high");
	});

	test("a discovered base row keeps its own human name while gaining the map", () => {
		const registry = resolveRegistry({}, [
			{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
			...FLASH_TIERS,
		]);
		expect(registry).toHaveLength(2);
		expect(registry[1]).toMatchObject({ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", reasoning: true });
	});

	test("the trailing suffix alone (empty base) is a flat id, not a collapse", () => {
		const registry = resolveRegistry({}, [{ id: "-high", name: "Weird" }]);
		expect(registry[1]).toMatchObject({ id: "-high", reasoning: false });
	});
});

describe("unit: models — fallback catalog when discovery fails (R2)", () => {
	test.each([
		["empty discovery", [] as DiscoveredEntry[]],
		["failed discovery (undefined)", undefined],
	])("startup never throws with %s; the static catalog serves", (_label, discovered) => {
		const registry = resolveRegistry({}, discovered);
		expect(registry.map((m) => m.id)).toEqual(["default", "gemini-3.8-flash"]);
		expect(registry[1].reasoning).toBe(true);
		expect(registry[1].thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "gemini-3.8-flash-low",
			medium: "gemini-3.8-flash-medium",
			high: "gemini-3.8-flash-high",
			xhigh: null,
			max: null,
		});
	});
});

describe("unit: models — config override/extend merge (R2)", () => {
	test("a config key matching an entry overrides name/limits IN PLACE, keeping position and reasoning", () => {
		const registry = resolveRegistry(
			{ "gemini-3.8-flash": { name: "Flash", limit: { context: 2000, output: 100 } } },
			FLASH_TIERS,
		);
		expect(registry.map((m) => m.id)).toEqual(["default", "gemini-3.8-flash"]);
		expect(registry[1]).toMatchObject({
			name: "Flash",
			limit: { context: 2000, output: 100 },
			reasoning: true,
			modelArg: "gemini-3.8-flash",
		});
		expect(registry[1].thinkingLevelMap?.high).toBe("gemini-3.8-flash-high");
		expect(registry[0].limit).toEqual({ ...DEFAULT_LIMITS });
	});

	test("an unknown config key extends the registry flat at the end with default limits", () => {
		const registry = resolveRegistry(
			{ "my-custom": { name: "Custom" } },
			[{ id: "gemini-3-pro", name: "Gemini 3 Pro" }],
		);
		const last = registry[registry.length - 1];
		expect(last).toMatchObject({
			id: "my-custom",
			name: "Custom",
			modelArg: "my-custom",
			reasoning: false,
		});
		expect(last.limit).toEqual({ ...DEFAULT_LIMITS });
		expect(last.thinkingLevelMap).toBeUndefined();
	});
});

describe("unit: models — provider-facing declarations (R2)", () => {
	test("projection is text-only, zero cost, 1M context / 65536 output", () => {
		for (const entry of resolveRegistry({}, FLASH_TIERS)) {
			const declaration = toProviderModel(entry);
			expect(declaration.id).toBe(entry.id);
			expect(declaration.name).toBe(entry.name);
			expect(declaration.reasoning).toBe(entry.reasoning);
			expect(declaration.input).toEqual(["text"]);
			expect(declaration.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
			expect(declaration.contextWindow).toBe(1_000_000);
			expect(declaration.maxTokens).toBe(65_536);
		}
	});

	test("the map travels on reasoning entries and is absent on flat ones", () => {
		const [defaultEntry, flashBase] = resolveRegistry({}, FLASH_TIERS);
		expect(toProviderModel(defaultEntry).thinkingLevelMap).toBeUndefined();
		expect(toProviderModel(flashBase).thinkingLevelMap).toEqual(flashBase.thinkingLevelMap);
	});
});

describe("unit: models — imageInput capability gating (pi-image-input spec, Q2 contract)", () => {
	test("imageInput ENABLED advertises input [text, image] on every registry entry", () => {
		for (const entry of resolveRegistry({}, FLASH_TIERS)) {
			const declaration = toProviderModel(entry, true);
			expect(declaration.input).toEqual(["text", "image"]);
		}
	});

	test("imageInput DISABLED declares text-only; the omitted flag stays text-only (backward compatible)", () => {
		for (const entry of resolveRegistry({}, FLASH_TIERS)) {
			expect(toProviderModel(entry, false).input).toEqual(["text"]);
			expect(toProviderModel(entry).input).toEqual(["text"]);
		}
	});

	test("the flag gates ONLY the input modality — id, name, reasoning, map, cost, and limits are unchanged", () => {
		const [, flashBase] = resolveRegistry({}, FLASH_TIERS);
		const enabled = toProviderModel(flashBase, true);
		expect(enabled.id).toBe(flashBase.id);
		expect(enabled.name).toBe(flashBase.name);
		expect(enabled.reasoning).toBe(flashBase.reasoning);
		expect(enabled.thinkingLevelMap).toEqual(flashBase.thinkingLevelMap);
		expect(enabled.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(enabled.contextWindow).toBe(DEFAULT_LIMITS.context);
		expect(enabled.maxTokens).toBe(DEFAULT_LIMITS.output);
		expect(Object.keys(enabled).sort()).toEqual(Object.keys(toProviderModel(flashBase, false)).sort());
	});
});
