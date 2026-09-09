/**
 * Discovery orchestrator (dynamic discovery WU): cache-first model listing
 * for the plugin. Resolution order —
 *  1. fresh cache (< 24h old) → serve it, no backend round-trip;
 *  2. otherwise refresh via the engine's listAgyModels (`agy models`):
 *     a non-empty result is served AND persisted to models-cache.json;
 *  3. a failed/empty refresh falls back silently: stale cache if present,
 *     otherwise [] (the registry then uses its static builtin list).
 * Never throws; every failure mode below returns a usable array.
 */
import { listAgyModels, DEFAULT_MODELS_TIMEOUT_MS } from "agy-bridge-engine";
import type { DiscoveredEntry } from "./models";
import {
	modelsCachePath,
	readModelsCache,
	writeModelsCache,
	cacheFresh,
} from "./models-cache";

/** Default binary: env AGY_BIN wins over the plain "agy" on PATH. */
export function resolveAgyBin(env: Record<string, string | undefined> = {}): string {
	return env["AGY_BIN"] ?? "agy";
}

export interface DiscoverModelsOptions {
	/** Binary override; default env AGY_BIN ?? "agy". */
	bin?: string;
	/** Environment snapshot (paths.ts house pattern); defaults to process.env. */
	env?: Record<string, string | undefined>;
	/** State dir override for the cache file (validated absolute by config). */
	stateDir?: string;
	/** Injectable clock (tests); defaults to the real time. */
	now?: Date;
	/** TTL override (tests). */
	ttlMs?: number;
	/** Hard cap for the child `agy models` process. */
	timeoutMs?: number;
	/** Test/DI seam: replace the engine lister. */
	list?: (bin: string) => Promise<DiscoveredEntry[]>;
}

/**
 * Resolve the currently offered agy models through the cache pipeline.
 * Injected listers that throw are swallowed like any other refresh failure.
 */
export async function discoverModels(opts: DiscoverModelsOptions = {}): Promise<DiscoveredEntry[]> {
	const now = opts.now ?? new Date();
	const path = modelsCachePath({ override: opts.stateDir });
	const cached = readModelsCache(path, now);
	if (cached && cacheFresh(cached, now, opts.ttlMs)) return cached.models;

	const bin = opts.bin ?? resolveAgyBin(opts.env ?? process.env);
	let fetched: DiscoveredEntry[] = [];
	try {
		fetched = opts.list
			? await opts.list(bin)
			: await listAgyModels({ bin, timeoutMs: opts.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS });
	} catch {
		fetched = [];
	}
	if (fetched.length > 0) {
		writeModelsCache(path, fetched, now);
		return fetched;
	}
	return cached?.models ?? [];
}
