/**
 * Model registry for the pi provider `agy` (spec R2). Registry keys are the
 * BARE model ids agy reports — pi namespaces them under the provider id, so
 * "default" surfaces as "agy/default" in the picker. Our default entry is
 * FIRST and carries no --model argument; discovered ids that encode effort
 * as a -high/-medium/-low suffix COLLAPSE into their base model, which is
 * registered with reasoning:true and a thinkingLevelMap whose VALUES are
 * the full agy ids passed as --model at turn time (pi passes the requested
 * ThinkingLevel to the custom streamSimple, which resolves the map). Ids
 * without a known effort suffix stay flat with reasoning:false. The static
 * catalog is ONLY the fallback when discovery is absent or empty — the
 * registry never throws, so startup never does either.
 */
import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ModelConfig } from "./config";

/**
 * pi declarations agy cannot report: `agy models` exposes no context/output
 * limits, so the design pins 1M/65536 defaults (overridable per model via
 * the R12 config map; the open question resolves empirically at D4/E).
 */
export const DEFAULT_LIMITS = { context: 1_000_000, output: 65_536 } as const;

export interface PiAgyModel {
	/** Registry key: the bare agy id pi namespaces as "agy/<id>". */
	id: string;
	/** Value passed via --model at turn time; undefined for the default entry (agy picks). */
	modelArg?: string;
	name: string;
	/** True only when effort variants collapsed into this base model. */
	reasoning: boolean;
	/** Effort routing: the map VALUE is the full agy id for --model. */
	thinkingLevelMap?: ThinkingLevelMap;
	limit: { context: number; output: number };
}

/** One bare discovery row from the engine's listAgyModels. */
export interface DiscoveredEntry {
	id: string;
	name: string;
}

/** Effort suffixes agy ids encode (design #4); pi's other levels route to null. */
const EFFORT_SUFFIXES = ["high", "medium", "low"] as const;
type Effort = (typeof EFFORT_SUFFIXES)[number];

function splitEffort(id: string): { base: string; effort: Effort } | null {
	for (const effort of EFFORT_SUFFIXES) {
		const suffix = `-${effort}`;
		if (id.endsWith(suffix) && id.length > suffix.length) {
			return { base: id.slice(0, -suffix.length), effort };
		}
	}
	return null;
}

/** Strip the optional "agy/" prefix; discovery rows arrive both bare and prefixed. */
function normalize(id: string): string {
	return id.startsWith("agy/") ? id.slice("agy/".length) : id;
}

function entry(id: string, name: string, modelArg?: string): PiAgyModel {
	return { id, name, modelArg, reasoning: false, limit: { ...DEFAULT_LIMITS } };
}

/** Static fallback discovery (R2): default plus the known Gemini flash tiers. */
export const FALLBACK_DISCOVERY: readonly DiscoveredEntry[] = [
	{ id: "gemini-3.8-flash-high", name: "gemini-3.8-flash-high" },
	{ id: "gemini-3.8-flash-medium", name: "gemini-3.8-flash-medium" },
	{ id: "gemini-3.8-flash-low", name: "gemini-3.8-flash-low" },
];

/**
 * Base registry for one discovery round: our default entry first (a
 * discovered "default" can never displace it), then the remaining rows in
 * order with effort variants collapsed into their base model. Deduped by
 * id, first occurrence wins. Undefined/empty discovery serves the static
 * fallback catalog — this function never throws.
 */
function baseRegistry(discovered?: readonly DiscoveredEntry[]): PiAgyModel[] {
	const rows = discovered && discovered.length > 0 ? discovered : FALLBACK_DISCOVERY;
	const registry: PiAgyModel[] = [entry("default", "default")];
	const byId = new Map<string, PiAgyModel>([["default", registry[0]]]);
	const effortsByBase = new Map<string, Partial<Record<Effort, string>>>();

	for (const row of rows) {
		const id = normalize(row.id);
		if (id === "default" || byId.has(id)) continue;
		const variant = splitEffort(id);
		if (variant) {
			let base = byId.get(variant.base);
			if (!base) {
				base = entry(variant.base, variant.base, variant.base);
				registry.push(base);
				byId.set(variant.base, base);
			}
			const efforts = effortsByBase.get(variant.base) ?? {};
			if (efforts[variant.effort] === undefined) efforts[variant.effort] = id;
			effortsByBase.set(variant.base, efforts);
		} else {
			const flat = entry(id, row.name, id);
			registry.push(flat);
			byId.set(id, flat);
		}
	}

	for (const [baseId, efforts] of effortsByBase) {
		const base = byId.get(baseId)!;
		base.reasoning = true;
		base.thinkingLevelMap = {
			off: null,
			minimal: null,
			low: efforts.low ?? null,
			medium: efforts.medium ?? null,
			high: efforts.high ?? null,
			xhigh: null,
			max: null,
		};
	}
	return registry;
}

/**
 * Registry with discovery and config merge applied: default first, then
 * collapsed/flat discovered models (static catalog ONLY as the
 * undefined/empty fallback), then a config key matching any entry overrides
 * name/limits IN PLACE (position, modelArg, and reasoning preserved) while
 * any other key extends the list flat in insertion order. The final list is
 * deduped by id (first occurrence wins). User limits are validated by
 * resolveConfig before they reach this module.
 */
export function resolveRegistry(
	user: Record<string, ModelConfig> = {},
	discovered?: readonly DiscoveredEntry[],
): PiAgyModel[] {
	const merged = baseRegistry(discovered).map((m) => ({ ...m, limit: { ...m.limit } }));
	for (const [id, cfg] of Object.entries(user)) {
		const existing = merged.find((m) => m.id === id);
		if (existing) {
			if (cfg?.name !== undefined) existing.name = cfg.name;
			if (cfg?.limit !== undefined) existing.limit = { ...cfg.limit };
		} else {
			const bare = normalize(id);
			const extended = entry(bare, cfg?.name ?? bare, bare);
			if (cfg?.limit !== undefined) extended.limit = { ...cfg.limit };
			merged.push(extended);
		}
	}
	const seen = new Set<string>();
	return merged.filter((m) => (seen.has(m.id) ? false : seen.add(m.id)));
}

/**
 * The declaration handed to pi's registerProvider models array (structural
 * subset of ProviderConfigInput's model entry): agy is a custom-provider
 * transport, so economics are neutral zeros, the input modality follows the
 * resolved `imageInput` flag (pi-image-input R2/Q2: enabled advertises
 * ["text","image"] so the host paperclip, list-models images column, and
 * the vision-capable `read` tool activate; disabled stays text-only), and
 * the design-pinned limits become contextWindow/maxTokens.
 */
export interface ProviderModelDeclaration {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
}

export function toProviderModel(entry: PiAgyModel, imageInput?: boolean): ProviderModelDeclaration {
	return {
		id: entry.id,
		name: entry.name,
		reasoning: entry.reasoning,
		...(entry.thinkingLevelMap !== undefined ? { thinkingLevelMap: entry.thinkingLevelMap } : {}),
		input: ["text", ...(imageInput ? (["image"] as const) : [])],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: entry.limit.context,
		maxTokens: entry.limit.output,
	};
}
