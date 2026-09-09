/**
 * Model registry for the agy provider (spec R8). agy/default FIRST and mapped
 * to NO --model argument; live-verified Gemini IDs next (checked against
 * `agy models` 2026-09-09); config entries override in place or extend at the
 * end; unknown ids pass through as --model <suffix>. The pool hint reuses the
 * engine's poolForModel so the quota gate (D7) and the registry agree.
 */
import { poolForModel, type Pool } from "agy-bridge-engine";
import type { ModelConfig } from "./config";

export const DEFAULT_LIMITS = { context: 128000, output: 8192 } as const;

export interface AgyModel {
	/** Full id shown to opencode, e.g. "agy/default". */
	id: string;
	/** Value passed via --model; undefined for agy/default (agy picks the default). */
	modelArg?: string;
	name: string;
	limit: { context: number; output: number };
	/** Quota-routing hint from the engine's poolForModel (D7). */
	pool: Pool;
}

function model(id: string, name: string, modelArg?: string): AgyModel {
	return { id, name, modelArg, limit: { ...DEFAULT_LIMITS }, pool: poolForModel(modelArg ?? "") };
}

/** Live-verified registry order (R8): default first, then the Gemini tiers. */
export const BUILTIN_MODELS: readonly AgyModel[] = [
	model("agy/default", "default"),
	model("agy/gemini-3.8-flash-high", "gemini-3.8-flash-high", "gemini-3.8-flash-high"),
	model("agy/gemini-3.8-flash-medium", "gemini-3.8-flash-medium", "gemini-3.8-flash-medium"),
	model("agy/gemini-3.8-flash-low", "gemini-3.8-flash-low", "gemini-3.8-flash-low"),
];

/** Strip the optional "agy/" prefix; ids arrive both bare and prefixed. */
function normalize(id: string): string {
	return id.startsWith("agy/") ? id.slice("agy/".length) : id;
}

/**
 * Registry with config merge applied (R8): a config key matching a builtin
 * overrides name/limits IN PLACE (position and modelArg preserved); any other
 * key extends the list in insertion order. User limits are validated by
 * resolveConfig before they reach this module.
 */
export function listModels(user: Record<string, ModelConfig> = {}): AgyModel[] {
	const merged: AgyModel[] = BUILTIN_MODELS.map((m) => ({ ...m, limit: { ...m.limit } }));
	for (const [id, cfg] of Object.entries(user)) {
		const existing = merged.find((m) => m.id === id);
		if (existing) {
			if (cfg?.name !== undefined) existing.name = cfg.name;
			if (cfg?.limit !== undefined) existing.limit = { ...cfg.limit };
		} else {
			merged.push(model(id, normalize(id), normalize(id)));
		}
	}
	return merged;
}

/**
 * Resolve one model id: registry/config lookup first, then unknown-suffix
 * passthrough (R8.s3) with default limits. agy/default keeps modelArg
 * undefined so the runtime spawns WITHOUT --model (R8.s2).
 */
export function resolveModel(id: string, user: Record<string, ModelConfig> = {}): AgyModel {
	const found = listModels(user).find((m) => m.id === id || m.id === `agy/${normalize(id)}`);
	if (found) return found;
	const suffix = normalize(id);
	return model(`agy/${suffix}`, suffix, suffix);
}
