/**
 * Adapter options: defaults, validation, typed errors (spec R9 defaults,
 * threat-matrix "never a relative path"). Pure module — no filesystem or
 * process access; absolute-path and numeric sanity are enforced HERE so the
 * runtime modules can trust the resolved config without re-checking.
 */
export type WorkdirMode = "scratch" | "session";

/** Payload of one effort variant: the full agy id passed as --model.
 * A type ALIAS (not an interface) so it stays assignable to the registry's
 * index-signature AgyVariantPayload. */
export type AgyVariantConfig = {
	agyModelId: string;
	[key: string]: unknown;
};

/** User-supplied per-model override/extension (R8 config merge). */
export interface ModelConfig {
	name?: string;
	limit?: { context: number; output: number };
	/** Effort variants for a collapsed base (config-fed registries): keyed by
	 * effort name, each carrying the full effort-suffixed agy id. Config is
	 * the picker channel AND the runtime channel — opencode does not consult
	 * the plugin provider.models hook (verified 2026-09-11), so variants must
	 * survive into applyConfig for variant resolution to work at all. */
	variants?: Record<string, AgyVariantConfig>;
}

export interface AgyAdapterOptions {
	workdirMode?: WorkdirMode;
	/** Absolute dir for per-run scratch workdirs; default os.tmpdir() (paths.ts). */
	scratchRoot?: string;
	/** Absolute state dir override; default XDG state resolution (paths.ts). */
	stateDir?: string;
	/** Absolute passive quota snapshot dir; quota gate skipped when unset. */
	quotaSnapshotDir?: string;
	/** Model overrides/extensions keyed by full id, e.g. "agy/custom". */
	models?: Record<string, ModelConfig>;
	/** Per-attempt hard cap in ms; engine defaults apply when unset. */
	timeoutMs?: number;
}

export interface AgyAdapterConfig {
	workdirMode: WorkdirMode;
	scratchRoot?: string;
	stateDir?: string;
	quotaSnapshotDir?: string;
	models: Record<string, ModelConfig>;
	timeoutMs?: number;
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

/**
 * Resolve raw options into a validated config. Unknown workdirMode values,
 * relative path options, non-positive-integer limits/timeoutMs, and
 * output>context limits all throw {@link AgyConfigError} BEFORE any spawn
 * can happen (threat matrix: config errors never reach the child process).
 */
export function resolveConfig(options: Partial<AgyAdapterOptions> = {}): AgyAdapterConfig {
	const workdirMode = options.workdirMode ?? "scratch";
	if (workdirMode !== "scratch" && workdirMode !== "session") {
		throw new AgyConfigError(
			"workdirMode",
			`workdirMode must be "scratch" or "session", got "${String(workdirMode)}"`,
		);
	}
	if (options.scratchRoot !== undefined) requireAbsolute("scratchRoot", options.scratchRoot);
	if (options.stateDir !== undefined) requireAbsolute("stateDir", options.stateDir);
	if (options.quotaSnapshotDir !== undefined) {
		requireAbsolute("quotaSnapshotDir", options.quotaSnapshotDir);
	}
	const models: Record<string, ModelConfig> = {};
	for (const [id, entry] of Object.entries(options.models ?? {})) {
		if (entry?.limit !== undefined) validateModelLimits(id, entry.limit);
		models[id] = entry;
	}
	if (options.timeoutMs !== undefined && !isPositiveInt(options.timeoutMs)) {
		throw new AgyConfigError("timeoutMs", `timeoutMs must be a positive integer, got ${String(options.timeoutMs)}`);
	}
	return {
		workdirMode,
		scratchRoot: options.scratchRoot,
		stateDir: options.stateDir,
		quotaSnapshotDir: options.quotaSnapshotDir,
		models,
		timeoutMs: options.timeoutMs,
	};
}
