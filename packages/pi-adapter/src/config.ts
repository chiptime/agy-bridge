/**
 * pi-adapter options: defaults, validation, typed errors (spec R12 env
 * parity, threat-matrix "never a relative path"). Mirrors the opencode
 * adapter's config module — AGY_BIN resolution, timeoutMs budget, the
 * models override map — with the pi addition that stateDir resolves to a
 * CONCRETE absolute dir (explicit override or XDG default) so downstream
 * modules never re-derive it. Pure module apart from the injected env
 * snapshot: absolute-path and numeric sanity are enforced HERE, at factory
 * load, BEFORE any spawn can happen.
 */
import { resolveStateDir } from "./paths";

/** User-supplied per-model override/extension (R2 config merge). */
export interface ModelConfig {
	name?: string;
	limit?: { context: number; output: number };
}

/** askAgy delegation section (v0.2 R2): unknown keys are ignored downstream. */
export interface AskAgyOptions {
	enabled?: boolean;
	name?: string;
	label?: string;
	description?: string;
	/** Closed enum (D1); validated in resolveConfig before any spawn. */
	defaultMode?: "read" | "none" | "full";
	/** false narrows the accepted enum to read|none (R2). */
	allowFullMode?: boolean;
	defaultIsolated?: boolean;
	/** Skills-catalog seam; defaults true (R2). */
	appendSkills?: boolean;
}

/** Resolved askAgy section: defaults filled, values validated. */
export interface AskAgyConfig {
	enabled: boolean;
	name?: string;
	label?: string;
	description?: string;
	defaultMode: "read" | "none" | "full";
	allowFullMode: boolean;
	defaultIsolated: boolean;
	appendSkills: boolean;
}

/**
 * Pre-merged file layer produced by file-config.ts (v0.2 R1, D10): it sits
 * BEHIND explicit options — explicit > project > global > env/defaults.
 */
export interface FileConfigLayer {
	/** Merged file values mapped onto the existing option keys. */
	config: Partial<PiAdapterOptions>;
	/** Merged raw askAgy section; validated by the same single gate. */
	askAgy: Record<string, unknown>;
}

export interface PiAdapterOptions {
	/** Environment snapshot; defaults to process.env. Test seam only — never a file layer. */
	env?: Record<string, string | undefined>;
	/** Absolute dir for per-run scratch workdirs; default os.tmpdir() (paths.ts). */
	scratchRoot?: string;
	/** Absolute state dir override; default XDG state resolution (paths.ts). */
	stateDir?: string;
	/** Model overrides/extensions keyed by registry id, e.g. "gemini-3.8-flash". */
	models?: Record<string, ModelConfig>;
	/** Per-attempt hard cap in ms; engine defaults apply when unset. */
	timeoutMs?: number;
	/** AskAgy delegation section (v0.2 R2). */
	askAgy?: AskAgyOptions;
}

export interface PiAdapterConfig {
	/** agy binary: env AGY_BIN wins over the plain "agy" on PATH. */
	agyBin: string;
	/** Always absolute: explicit override or the XDG state default. */
	stateDir: string;
	scratchRoot?: string;
	models: Record<string, ModelConfig>;
	timeoutMs?: number;
	/** Resolved askAgy section with confirmed defaults (v0.2 R2). */
	askAgy: AskAgyConfig;
}

/** Typed validation error: field names the exact rejected option. */
export class AgyConfigError extends Error {
	readonly code = "AGY_CONFIG_INVALID" as const;
	constructor(
		public readonly field: string,
		message: string,
	) {
		super(message);
		this.name = "AgyConfigError";
	}
}

function isPositiveInt(n: unknown): n is number {
	return typeof n === "number" && Number.isInteger(n) && n > 0;
}

function requireAbsolute(field: string, value: string): string {
	if (!value.startsWith("/")) {
		throw new AgyConfigError(field, `${field} must be an absolute path, got "${value}"`);
	}
	return value;
}

function validateModelLimits(id: string, limit: { context: number; output: number }): void {
	const field = `models.${id}.limit`;
	for (const key of ["context", "output"] as const) {
		if (!isPositiveInt(limit?.[key])) {
			throw new AgyConfigError(field, `${field}.${key} must be a positive integer`);
		}
	}
	if (limit.output > limit.context) {
		throw new AgyConfigError(field, `${field}.output (${limit.output}) must not exceed context (${limit.context})`);
	}
}

/** Closed mode enum (v0.2 D1); allowFullMode:false narrows it further. */
const ASK_AGY_MODES = ["read", "none", "full"] as const;

/** askAgy field validators: undefined passes (defaults apply), wrong types throw with the exact path. */
function requireAskAgyBool(raw: Record<string, unknown>, key: string): boolean | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") {
		throw new AgyConfigError(`askAgy.${key}`, `askAgy.${key} must be a boolean, got ${typeof value}`);
	}
	return value;
}

function requireAskAgyString(raw: Record<string, unknown>, key: string): string | undefined {
	const value = raw[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new AgyConfigError(`askAgy.${key}`, `askAgy.${key} must be a string, got ${typeof value}`);
	}
	return value;
}

/**
 * Validate the merged raw askAgy section into a resolved one (v0.2 R2, D10).
 * Unknown keys are ignored (tolerant); wrong-typed values and defaultMode
 * violations throw {@link AgyConfigError} BEFORE any spawn can happen.
 * Confirmed product defaults: enabled FALSE (off by default + one-time
 * notice, R3) and defaultMode "read" (safe second-opinion behavior).
 */
function validateAskAgy(raw: Record<string, unknown>): AskAgyConfig {
	const enabled = requireAskAgyBool(raw, "enabled") ?? false;
	const name = requireAskAgyString(raw, "name");
	const label = requireAskAgyString(raw, "label");
	const description = requireAskAgyString(raw, "description");
	const allowFullMode = requireAskAgyBool(raw, "allowFullMode") ?? true;
	const defaultIsolated = requireAskAgyBool(raw, "defaultIsolated") ?? false;
	const appendSkills = requireAskAgyBool(raw, "appendSkills") ?? true;
	const rawMode = raw["defaultMode"];
	let defaultMode: AskAgyConfig["defaultMode"] = "read";
	if (rawMode !== undefined) {
		if (typeof rawMode !== "string" || !(ASK_AGY_MODES as readonly string[]).includes(rawMode)) {
			throw new AgyConfigError(
				"askAgy.defaultMode",
				`askAgy.defaultMode must be "read", "none", or "full", got "${String(rawMode)}"`,
			);
		}
		defaultMode = rawMode as AskAgyConfig["defaultMode"];
	}
	if (!allowFullMode && defaultMode === "full") {
		throw new AgyConfigError(
			"askAgy.defaultMode",
			`askAgy.defaultMode "full" requires allowFullMode, which is configured false (accepted modes: read|none)`,
		);
	}
	return {
		enabled,
		...(name !== undefined ? { name } : {}),
		...(label !== undefined ? { label } : {}),
		...(description !== undefined ? { description } : {}),
		defaultMode,
		allowFullMode,
		defaultIsolated,
		appendSkills,
	};
}

/**
 * Resolve raw options into a validated config. Relative path options,
 * non-positive-integer limits/timeoutMs, and output>context limits all
 * throw {@link AgyConfigError} BEFORE any spawn can happen (threat matrix:
 * config errors never reach the child process). The optional file layer
 * (v0.2 R1/D10) feeds values BEHIND the explicit options; both converge on
 * this single validation gate.
 */
export function resolveConfig(options: PiAdapterOptions = {}, fileLayer?: FileConfigLayer): PiAdapterConfig {
	const env = options.env ?? process.env;
	const layer = fileLayer?.config ?? {};
	const pickLayered = <T>(fileValue: T | undefined, explicit: T | undefined): T | undefined =>
		explicit !== undefined ? explicit : fileValue;
	const scratchRoot = pickLayered(layer.scratchRoot, options.scratchRoot);
	const stateDir = pickLayered(layer.stateDir, options.stateDir);
	const timeoutMs = pickLayered(layer.timeoutMs, options.timeoutMs);
	// Per-key merge (D10): file entries first, explicit entries win per key.
	const models: Record<string, ModelConfig> = { ...(layer.models ?? {}) };
	for (const [id, entry] of Object.entries(options.models ?? {})) models[id] = entry;
	if (scratchRoot !== undefined) requireAbsolute("scratchRoot", scratchRoot);
	if (stateDir !== undefined) requireAbsolute("stateDir", stateDir);
	for (const [id, entry] of Object.entries(models)) {
		if (entry?.limit !== undefined) validateModelLimits(id, entry.limit);
	}
	if (timeoutMs !== undefined && !isPositiveInt(timeoutMs)) {
		throw new AgyConfigError("timeoutMs", `timeoutMs must be a positive integer, got ${String(timeoutMs)}`);
	}
	const explicitAskAgy: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(options.askAgy ?? {})) {
		if (value !== undefined) explicitAskAgy[key] = value;
	}
	const askAgy = validateAskAgy({ ...(fileLayer?.askAgy ?? {}), ...explicitAskAgy });
	return {
		agyBin: env["AGY_BIN"] ?? "agy",
		stateDir: stateDir ?? resolveStateDir({ env }),
		scratchRoot,
		models,
		timeoutMs,
		askAgy,
	};
}
