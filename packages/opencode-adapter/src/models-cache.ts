/**
 * On-disk cache for discovered agy models (dynamic discovery WU): one JSON
 * file in the adapter state dir so opencode restarts skip the ~1-2s backend
 * round-trip for 24h. Every read is tolerant — a missing, garbage, or
 * wrong-schema file is just "no cache" (null), never a throw.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { DiscoveredEntry } from "./models";
import { resolveStateDir } from "./paths";

/** Cache schema marker; bumped on incompatible changes. */
export const MODELS_CACHE_VERSION = 1;

/** Fresh window: 24h after fetchedAt the cache is stale (but still usable as a fallback). */
export const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface ModelsCacheFile {
	version: typeof MODELS_CACHE_VERSION;
	/** ISO timestamp of the successful refresh. */
	fetchedAt: string;
	models: DiscoveredEntry[];
}

/** Exact cache location: `<stateDir>/agy-bridge/models-cache.json`. */
export function modelsCachePath(opts: { override?: string } = {}): string {
	return join(resolveStateDir({ override: opts.override }), "models-cache.json");
}

/**
 * Validate unknown file bytes as a models cache: JSON object, version 1,
 * parseable fetchedAt, and a models array of {id,name} pairs with non-empty
 * id. Anything else → null (the caller treats it as "no cache").
 */
export function parseModelsCache(raw: string): ModelsCacheFile | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const rec = parsed as Record<string, unknown>;
	if (rec.version !== MODELS_CACHE_VERSION) return null;
	if (typeof rec.fetchedAt !== "string" || Number.isNaN(Date.parse(rec.fetchedAt))) return null;
	if (!Array.isArray(rec.models)) return null;
	const models: DiscoveredEntry[] = [];
	for (const entry of rec.models) {
		if (typeof entry !== "object" || entry === null) return null;
		const e = entry as Record<string, unknown>;
		if (typeof e.id !== "string" || e.id === "" || typeof e.name !== "string") return null;
		models.push({ id: e.id, name: e.name });
	}
	return { version: MODELS_CACHE_VERSION, fetchedAt: rec.fetchedAt, models };
}

/** TTL policy: fresh when `now` is within MODELS_CACHE_TTL_MS of fetchedAt. */
export function cacheFresh(cache: ModelsCacheFile, now: Date, ttlMs = MODELS_CACHE_TTL_MS): boolean {
	const fetched = Date.parse(cache.fetchedAt);
	return now.getTime() - fetched < ttlMs;
}

/**
 * Tolerant read: file miss, garbage bytes, or bad schema all yield null.
 * NOTE: staleness is a CALLER decision (a stale cache still beats an empty
 * refresh), so this function never filters on age.
 */
export function readModelsCache(path: string, now: Date): ModelsCacheFile | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	const cache = parseModelsCache(raw);
	return cache;
}

/** Persist one refresh: creates parent dirs, writes atomically-shaped JSON. */
export function writeModelsCache(path: string, models: DiscoveredEntry[], now: Date): void {
	const cache: ModelsCacheFile = {
		version: MODELS_CACHE_VERSION,
		fetchedAt: now.toISOString(),
		models: models.map((m) => ({ id: m.id, name: m.name })),
	};
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(cache, null, "\t")}\n`);
	} catch {
		/* a full state disk must not break discovery — the in-memory result already won */
	}
}
