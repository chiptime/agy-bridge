/**
 * Unit tests for the models discovery pipeline: on-disk cache
 * (models-cache.ts) and the cache-first orchestrator (discovery.ts) with
 * TTL, injected clock, and silent fallback semantics.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import {
	MODELS_CACHE_TTL_MS,
	cacheFresh,
	modelsCachePath,
	parseModelsCache,
	readModelsCache,
	writeModelsCache,
} from "../src/models-cache";
import { discoverModels } from "../src/discovery";

const MODELS = [
	{ id: "m-1", name: "Model One" },
	{ id: "m-2", name: "Model Two" },
];
const NOW = new Date("2026-09-09T12:00:00Z");

describe("unit: models-cache — persistence, validation, TTL", () => {
	test("roundtrip: write then read back; schema is {version:1, fetchedAt, models}", async () => {
		const dir = await mkdtemp("/tmp/agy-cache-");
		const path = `${dir}/models-cache.json`;
		writeModelsCache(path, MODELS, NOW);
		expect(readModelsCache(path, NOW)).toEqual({
			version: 1,
			fetchedAt: NOW.toISOString(),
			models: MODELS,
		});
	});

	test("cache path lands under the state dir: <stateDir>/agy-bridge/models-cache.json", () => {
		expect(modelsCachePath({ override: "/state/root" })).toBe(
			"/state/root/agy-bridge/models-cache.json",
		);
	});

	test("parse rejects garbage, wrong version, and malformed model entries", () => {
		expect(parseModelsCache("not json at all")).toBeNull();
		expect(
			parseModelsCache(JSON.stringify({ version: 2, fetchedAt: NOW.toISOString(), models: MODELS })),
		).toBeNull();
		expect(
			parseModelsCache(JSON.stringify({ version: 1, fetchedAt: NOW.toISOString(), models: [{ id: "x" }] })),
		).toBeNull();
		expect(parseModelsCache(JSON.stringify({ version: 1, fetchedAt: "nope", models: MODELS }))).toBeNull();
	});

	test("TTL: fresh within 24h, stale past it (injectable clock)", () => {
		const cache = { version: 1 as const, fetchedAt: NOW.toISOString(), models: MODELS };
		expect(cacheFresh(cache, new Date(NOW.getTime() + MODELS_CACHE_TTL_MS - 1))).toBe(true);
		expect(cacheFresh(cache, new Date(NOW.getTime() + MODELS_CACHE_TTL_MS + 1))).toBe(false);
	});

	test("missing file and unwritable-looking garbage read as null (tolerant)", async () => {
		const dir = await mkdtemp("/tmp/agy-cache-miss-");
		expect(readModelsCache(`${dir}/models-cache.json`, NOW)).toBeNull();
		const bad = `${dir}/bad.json`;
		await Bun.write(bad, "{{{");
		expect(readModelsCache(bad, NOW)).toBeNull();
	});
});

describe("unit: discovery — cache-first with silent refresh fallback", () => {
	const NEW_MODELS = [{ id: "fresh-1", name: "Fresh One" }];

	async function cacheDir(): Promise<string> {
		return mkdtemp("/tmp/agy-disc-");
	}

	test("fresh cache wins: the lister is never called", async () => {
		const dir = await cacheDir();
		writeModelsCache(modelsCachePath({ override: dir }), MODELS, new Date(NOW.getTime() - 3_600_000));
		let called = 0;
		const models = await discoverModels({
			stateDir: dir,
			now: NOW,
			list: async () => {
				called++;
				return NEW_MODELS;
			},
		});
		expect(models).toEqual(MODELS);
		expect(called).toBe(0);
	});

	test("stale cache triggers a refresh that serves AND rewrites the cache", async () => {
		const dir = await cacheDir();
		const path = modelsCachePath({ override: dir });
		writeModelsCache(path, MODELS, new Date(NOW.getTime() - MODELS_CACHE_TTL_MS - 60_000));
		const models = await discoverModels({
			stateDir: dir,
			now: NOW,
			list: async () => NEW_MODELS,
		});
		expect(models).toEqual(NEW_MODELS);
		expect(readModelsCache(path, NOW)?.models).toEqual(NEW_MODELS);
	});

	test("stale cache still beats an EMPTY refresh; the old cache file is left untouched", async () => {
		const dir = await cacheDir();
		const path = modelsCachePath({ override: dir });
		writeModelsCache(path, MODELS, new Date(NOW.getTime() - MODELS_CACHE_TTL_MS - 60_000));
		const models = await discoverModels({ stateDir: dir, now: NOW, list: async () => [] });
		expect(models).toEqual(MODELS);
		expect(readModelsCache(path, NOW)?.models).toEqual(MODELS);
	});

	test("refresh failure (lister throws) falls back silently to the stale cache", async () => {
		const dir = await cacheDir();
		writeModelsCache(
			modelsCachePath({ override: dir }),
			MODELS,
			new Date(NOW.getTime() - MODELS_CACHE_TTL_MS - 60_000),
		);
		const models = await discoverModels({
			stateDir: dir,
			now: NOW,
			list: async () => {
				throw new Error("injected refresh failure");
			},
		});
		expect(models).toEqual(MODELS);
	});

	test("nothing cached and refresh empty/failing → [] (never throws)", async () => {
		const dir = await cacheDir();
		expect(await discoverModels({ stateDir: dir, now: NOW, list: async () => [] })).toEqual([]);
		expect(
			await discoverModels({
				stateDir: dir,
				now: NOW,
				list: async () => {
					throw new Error("boom");
				},
			}),
		).toEqual([]);
	});

	test("bin resolution: env AGY_BIN wins over the 'agy' default and reaches the lister", async () => {
		const dir = await cacheDir();
		const seen: string[] = [];
		await discoverModels({
			stateDir: dir,
			now: NOW,
			env: { AGY_BIN: "/opt/tools/agy" },
			list: async (bin) => {
				seen.push(bin);
				return MODELS;
			},
		});
		expect(seen).toEqual(["/opt/tools/agy"]);
	});
});
