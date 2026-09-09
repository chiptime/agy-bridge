/**
 * Model registry for the agy provider (spec R8). agy/default FIRST and mapped
 * to NO --model argument; with dynamic discovery (WU: `agy models`) the
 * discovered models become agy/<id> entries with agy's own display names —
 * the static builtin list is ONLY the fallback when discovery is absent or
 * empty. Config entries override in place or extend at the end; unknown ids
 * pass through as --model <suffix>. The pool hint reuses the engine's
 * poolForModel so the quota gate (D7) and the registry agree.
 */
import { poolForModel, type Pool } from "agy-bridge-engine";
import type { Model as ModelV2 } from "@opencode-ai/sdk/v2";
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

/** Static fallback registry order (R8): default first, then the Gemini tiers. */
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

/** One bare discovery row from the engine's listAgyModels. */
export interface DiscoveredEntry {
	id: string;
	name: string;
}

/**
 * The base registry for a discovery round: the discovered models (bare id →
 * agy/<id>, agy's human name kept, modelArg = bare id) after the mandatory
 * agy/default — or the static builtin list when discovery is undefined or
 * empty (spawn failure, backend outage, cold cache). Deduped by id, first
 * occurrence wins, so a discovered "default" can never displace ours.
 */
function baseRegistry(discovered?: readonly DiscoveredEntry[]): AgyModel[] {
	const base = discovered && discovered.length > 0
		? [
				model("agy/default", "default"),
				...discovered.map((d) => model(`agy/${normalize(d.id)}`, d.name, normalize(d.id))),
			]
		: [...BUILTIN_MODELS];
	const seen = new Set<string>();
	return base.filter((m) => (seen.has(m.id) ? false : seen.add(m.id)));
}

/**
 * Registry with discovery and config merge applied: agy/default first, then
 * discovered models (static list ONLY as the undefined/empty fallback), then
 * a config key matching any entry overrides name/limits IN PLACE (position
 * and modelArg preserved) while any other key extends the list in insertion
 * order. The final list is deduped by id (first occurrence wins). User
 * limits are validated by resolveConfig before they reach this module.
 */
export function resolveRegistry(
	user: Record<string, ModelConfig> = {},
	discovered?: readonly DiscoveredEntry[],
): AgyModel[] {
	return applyConfig(baseRegistry(discovered), user);
}

/** Legacy entry point kept for the provider side: static registry + config. */
export function listModels(user: Record<string, ModelConfig> = {}): AgyModel[] {
	return applyConfig([...BUILTIN_MODELS], user);
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
 * undefined so the runtime spawns WITHOUT --model (R8.s2).
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
		};
	}
	return record;
}
