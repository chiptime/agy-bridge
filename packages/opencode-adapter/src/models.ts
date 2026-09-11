/**
 * Model registry for the agy provider (spec R8). agy/default FIRST and mapped
 * to NO --model argument; with dynamic discovery (WU: `agy models`) the
 * discovered models become agy/<id> entries with agy's own display names —
 * the static builtin list is ONLY the fallback when discovery is absent or
 * empty. Config entries override in place or extend at the end; unknown ids
 * pass through as --model <suffix>. The pool hint reuses the engine's
 * poolForModel so the quota gate (D7) and the registry agree.
 *
 * Effort-variant collapse: agy ids encode the reasoning effort as a
 * -high/-medium/-low suffix (verified live via `agy models`). Those suffixed
 * ids COLLAPSE into their base model, which carries a `variants` payload
 * whose VALUES are the full agy ids passed as --model at turn time
 * (opencode 1.18.30 ModelV2.variants + session model.variant). Flat suffixed
 * entries deliberately do NOT appear in the picker — the user wants ONE base
 * entry with variant selection — but they remain directly selectable through
 * resolveModel's unknown-suffix passthrough, so legacy pinned configs and
 * existing sessions holding e.g. agy/gemini-3.8-flash-high keep working.
 * A collapsed base has NO exact bare agy id to spawn, so its modelArg
 * defaults to the HIGHEST discovered effort (high > medium > low) — that is
 * also the documented fallback for unknown or absent variants.
 */
import { poolForModel, type Pool } from "agy-bridge-engine";
import type { Model as ModelV2 } from "@opencode-ai/sdk/v2";
import type { ModelConfig } from "./config";

export const DEFAULT_LIMITS = { context: 128000, output: 8192 } as const;

/** Variant payload: the ONLY channel to carry the full agy id into the turn
 * (--model argument) until we empirically confirm where opencode merges
 * variant config into the LLM call. Deliberately namespaced. The index
 * signature satisfies the SDK's variants type
 * ({ [key: string]: { [key: string]: unknown } }). */
export type AgyVariantPayload = {
	agyModelId: string;
	[key: string]: unknown;
};

export interface AgyModel {
	/** Full id shown to opencode, e.g. "agy/default". */
	id: string;
	/** Value passed via --model; undefined for agy/default (agy picks the default).
	 * For a collapsed base this is the HIGHEST discovered effort (fallback). */
	modelArg?: string;
	name: string;
	limit: { context: number; output: number };
	/** Quota-routing hint from the engine's poolForModel (D7). */
	pool: Pool;
	/** Effort variants keyed by the effort name; present ONLY on collapsed bases. */
	variants?: Record<string, AgyVariantPayload>;
}

function model(id: string, name: string, modelArg?: string): AgyModel {
	return { id, name, modelArg, limit: { ...DEFAULT_LIMITS }, pool: poolForModel(modelArg ?? "") };
}

/** Effort suffixes agy ids encode; order is ALSO the fallback priority. */
const EFFORT_SUFFIXES = ["high", "medium", "low"] as const;
type Effort = (typeof EFFORT_SUFFIXES)[number];

/** Split a trailing effort suffix off an agy id; null when none applies. */
function splitEffort(id: string): { base: string; effort: Effort } | null {
	for (const effort of EFFORT_SUFFIXES) {
		const suffix = `-${effort}`;
		if (id.endsWith(suffix) && id.length > suffix.length) {
			return { base: id.slice(0, -suffix.length), effort };
		}
	}
	return null;
}

/** Strip the optional "agy/" prefix; ids arrive both bare and prefixed. */
function normalize(id: string): string {
	return id.startsWith("agy/") ? id.slice("agy/".length) : id;
}

/** One bare discovery row from the engine's listAgyModels. */
export interface DiscoveredEntry {
	id: string;
	name: string;
}

/**
 * Static fallback discovery (undefined/empty live discovery): default plus
 * the known suffixed Gemini tiers. They route through the SAME collapse as
 * live discovery, so the fallback picker matches the dynamic one.
 */
const FALLBACK_DISCOVERY: readonly DiscoveredEntry[] = [
	{ id: "gemini-3.8-flash-high", name: "gemini-3.8-flash-high" },
	{ id: "gemini-3.8-flash-medium", name: "gemini-3.8-flash-medium" },
	{ id: "gemini-3.8-flash-low", name: "gemini-3.8-flash-low" },
];

/**
 * The base registry for a discovery round: the mandatory agy/default first,
 * then the discovered rows with effort-suffixed ids collapsed into their
 * base model (variants carry the full agy ids; the base modelArg falls back
 * to the highest discovered effort) — or the static fallback discovery when
 * live discovery is undefined or empty (spawn failure, backend outage, cold
 * cache). Deduped by id, first occurrence wins, so a discovered "default"
 * can never displace ours.
 */
function baseRegistry(discovered?: readonly DiscoveredEntry[]): AgyModel[] {
	const rows = discovered && discovered.length > 0 ? discovered : FALLBACK_DISCOVERY;
	const registry: AgyModel[] = [model("agy/default", "default")];
	const byId = new Map<string, AgyModel>([["agy/default", registry[0]]]);
	const effortsByBase = new Map<string, Partial<Record<Effort, string>>>();

	for (const row of rows) {
		const id = normalize(row.id);
		if (id === "default" || byId.has(id)) continue;
		const variant = splitEffort(id);
		if (variant) {
			const baseId = `agy/${variant.base}`;
			let base = byId.get(baseId);
			if (!base) {
				// First sighting: highest-effort modelArg is patched below once
				// all efforts of this base are known.
				base = model(baseId, row.name, id);
				registry.push(base);
				byId.set(baseId, base);
			}
			const efforts = effortsByBase.get(baseId) ?? {};
			if (efforts[variant.effort] === undefined) efforts[variant.effort] = id;
			effortsByBase.set(baseId, efforts);
		} else {
			const flat = model(`agy/${id}`, row.name, id);
			registry.push(flat);
			byId.set(`agy/${id}`, flat);
		}
	}

	// Patch collapsed bases: variants payload + highest-effort modelArg
	// fallback (a collapsed base has no exact bare agy id to spawn).
	for (const [baseId, efforts] of effortsByBase) {
		const base = byId.get(baseId);
		if (!base) continue;
		const fallback = efforts.high ?? efforts.medium ?? efforts.low;
		if (fallback !== undefined) base.modelArg = fallback;
		base.pool = poolForModel(base.modelArg ?? "");
		const variants: Record<string, AgyVariantPayload> = {};
		for (const [effort, agyId] of Object.entries(efforts)) {
			if (agyId !== undefined) variants[effort] = { agyModelId: agyId };
		}
		base.variants = variants;
	}

	const seen = new Set<string>();
	return registry.filter((m) => (seen.has(m.id) ? false : seen.add(m.id)));
}

/**
 * Registry with discovery and config merge applied: agy/default first, then
 * discovered models with effort suffixes collapsed into bases (static
 * fallback discovery ONLY when live discovery is undefined or empty), then
 * a config key matching any entry overrides name/limits IN PLACE (position
 * and modelArg preserved) while any other key extends the list in insertion
 * order — including legacy suffixed keys, which extend FLAT so pinned
 * configs keep their full-id modelArg. The final list is deduped by id
 * (first occurrence wins). User limits are validated by resolveConfig
 * before they reach this module.
 */
export function resolveRegistry(
	user: Record<string, ModelConfig> = {},
	discovered?: readonly DiscoveredEntry[],
): AgyModel[] {
	return applyConfig(baseRegistry(discovered), user);
}

/** Legacy entry point kept for the provider side: static registry + config. */
export function listModels(user: Record<string, ModelConfig> = {}): AgyModel[] {
	return applyConfig(baseRegistry(undefined), user);
}

function applyConfig(
	base: AgyModel[],
	user: Record<string, ModelConfig>,
): AgyModel[] {
	const merged = base.map((m) => ({ ...m, limit: { ...m.limit } }));
	for (const [id, cfg] of Object.entries(user)) {
		const existing = merged.find((m) => m.id === id);
		if (existing) {
			if (cfg?.name !== undefined) existing.name = cfg.name;
			if (cfg?.limit !== undefined) existing.limit = { ...cfg.limit };
		} else {
			merged.push(model(id, normalize(id), normalize(id)));
		}
	}
	const seen = new Set<string>();
	return merged.filter((m) => (seen.has(m.id) ? false : seen.add(m.id)));
}

/**
 * Resolve one model id: registry/config lookup first, then unknown-suffix
 * passthrough (R8.s3) with default limits. agy/default keeps modelArg
 * undefined so the runtime spawns WITHOUT --model (R8.s2). BACKWARD COMPAT
 * with the effort collapse: suffixed ids (agy/gemini-3.8-flash-high) are no
 * longer registry entries, so they resolve via the passthrough to a flat
 * model whose modelArg is the FULL agy id — direct selection keeps working
 * exactly as before the collapse.
 */
export function resolveModel(id: string, user: Record<string, ModelConfig> = {}): AgyModel {
	const found = listModels(user).find((m) => m.id === id || m.id === `agy/${normalize(id)}`);
	if (found) return found;
	const suffix = normalize(id);
	return model(`agy/${suffix}`, suffix, suffix);
}

/**
 * Build the record the plugin's `provider.models` hook returns (pinned
 * @opencode-ai/plugin@1.18.30: `models?(provider: ProviderV2, ctx) =>
 * Promise<Record<string, ModelV2>>`). Keys are BARE model suffixes — the
 * host namespaces them under the provider id — and each value is the full
 * SDK v2 Model descriptor. Transport truth: every model is served by our
 * own custom provider factory (this package's "./provider" export), NOT a
 * direct HTTP endpoint. opencode's loader imports `api.npm` DIRECTLY when
 * it starts with file:// (registry specs go through Npm.add, which cannot
 * resolve an unpublished package), so self-reference the bundled provider
 * entry: <this module's dir>/provider.js. Unknown economics/metadata are
 * neutral zeros with an empty release date.
 */
const TRANSPORT_NPM = new URL("provider.js", import.meta.url).href;

export function buildModelRecord(
	registry: readonly AgyModel[],
	providerId: string,
): Record<string, ModelV2> {
	const record: Record<string, ModelV2> = {};
	for (const entry of registry) {
		const suffix = normalize(entry.id);
		record[suffix] = {
			id: suffix,
			providerID: providerId,
			api: { id: entry.modelArg ?? suffix, url: "", npm: TRANSPORT_NPM },
			name: entry.name,
			capabilities: {
				temperature: true,
				reasoning: true,
				attachment: false,
				toolcall: true,
				input: { text: true, audio: false, image: false, video: false, pdf: false },
				output: { text: true, audio: false, image: false, video: false, pdf: false },
				interleaved: false,
			},
			cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
			limit: { context: entry.limit.context, output: entry.limit.output },
			status: "active",
			options: {},
			headers: {},
			release_date: "",
			// Effort variants (collapsed bases only): each payload carries the
			// full agy id the runtime passes as --model at turn time. SDK type
			// (1.18.30): variants?: { [key: string]: { [key: string]: unknown } }.
			...(entry.variants !== undefined ? { variants: entry.variants } : {}),
		};
	}
	return record;
}
