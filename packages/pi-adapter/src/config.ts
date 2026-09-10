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

export interface PiAdapterOptions {
	/** Environment snapshot; defaults to process.env. */
	env?: Record<string, string | undefined>;
	/** Absolute dir for per-run scratch workdirs; default os.tmpdir() (paths.ts). */
	scratchRoot?: string;
	/** Absolute state dir override; default XDG state resolution (paths.ts). */
	stateDir?: string;
	/** Model overrides/extensions keyed by registry id, e.g. "gemini-3.8-flash". */
	models?: Record<string, ModelConfig>;
	/** Per-attempt hard cap in ms; engine defaults apply when unset. */
	timeoutMs?: number;
}

export interface PiAdapterConfig {
	/** agy binary: env AGY_BIN wins over the plain "agy" on PATH. */
	agyBin: string;
	/** Always absolute: explicit override or the XDG state default. */
	stateDir: string;
	scratchRoot?: string;
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
 * Resolve raw options into a validated config. Relative path options,
 * non-positive-integer limits/timeoutMs, and output>context limits all
 * throw {@link AgyConfigError} BEFORE any spawn can happen (threat matrix:
 * config errors never reach the child process).
 */
export function resolveConfig(options: PiAdapterOptions = {}): PiAdapterConfig {
	const env = options.env ?? process.env;
	if (options.scratchRoot !== undefined) requireAbsolute("scratchRoot", options.scratchRoot);
	if (options.stateDir !== undefined) requireAbsolute("stateDir", options.stateDir);
	const models: Record<string, ModelConfig> = {};
	for (const [id, entry] of Object.entries(options.models ?? {})) {
		if (entry?.limit !== undefined) validateModelLimits(id, entry.limit);
		models[id] = entry;
	}
	if (options.timeoutMs !== undefined && !isPositiveInt(options.timeoutMs)) {
		throw new AgyConfigError("timeoutMs", `timeoutMs must be a positive integer, got ${String(options.timeoutMs)}`);
	}
	return {
		agyBin: env["AGY_BIN"] ?? "agy",
		stateDir: options.stateDir ?? resolveStateDir({ env }),
		scratchRoot: options.scratchRoot,
		models,
		timeoutMs: options.timeoutMs,
	};
}
