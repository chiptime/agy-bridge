/**
 * Dynamic model discovery for agy (host-agnostic): runs `agy models`, which
 * prints a human preamble line followed by TSV rows `<id>\t<Human Name>`
 * (verified live against agy v1.1.28, 2026-09-09 — 14 models, no --json
 * flag, one backend round-trip ~1-2s). Parsing is tolerant by design:
 * preamble/blank/malformed lines are skipped, and ANY failure (spawn error,
 * nonzero exit, empty output) yields [] instead of throwing so hosts can
 * fall back to their static registry without special-casing.
 */
import { spawnSync } from "node:child_process";

/** One discovered agy model: bare id plus the human display name agy prints. */
export interface AgyModelEntry {
	id: string;
	name: string;
}

/**
 * Ceiling for the `agy models` round-trip. A healthy backend answers in
 * ~1-2s; 15s only fires on a hung transport, where [] (static fallback)
 * is better than blocking the host forever.
 */
export const DEFAULT_MODELS_TIMEOUT_MS = 15_000;

/** What a runner observes about one `agy models` invocation. */
export interface AgyModelsRun {
	stdout: string;
	exitCode: number | null;
	/** e.g. "ENOENT" when the binary could not even start. */
	spawnError?: string;
}

/** Test/dependency seam: replace the real spawnSync call. */
export type AgyModelsRunner = (bin: string) => AgyModelsRun;

export interface ListAgyModelsOptions {
	bin: string;
	/** Hard cap for the child process; default DEFAULT_MODELS_TIMEOUT_MS. */
	timeoutMs?: number;
	/** Test seam: replace the real child_process spawnSync. */
	runner?: AgyModelsRunner;
}

/**
 * Parse `agy models` stdout (pure, tolerant): keep only lines containing a
 * tab, split on the FIRST tab (display names never contain tabs, but a
 * defensive join keeps later fields harmless), trim both sides, and drop
 * rows with an empty id or name. Preamble/blank/malformed lines vanish.
 */
export function parseAgyModelsOutput(stdout: string): AgyModelEntry[] {
	const models: AgyModelEntry[] = [];
	for (const rawLine of stdout.split("\n")) {
		const line = rawLine.trim();
		if (!line.includes("\t")) continue;
		const tabIndex = line.indexOf("\t");
		const id = line.slice(0, tabIndex).trim();
		const name = line.slice(tabIndex + 1).trim();
		if (id === "" || name === "") continue;
		models.push({ id, name });
	}
	return models;
}

/**
 * List the models agy currently offers: spawn `<bin> models`, parse the TSV
 * rows after the preamble. Never throws — spawn errors, nonzero exits,
 * timeouts, unparseable/empty output, and injected runner failures all
 * return [] (the caller's signal to fall back to its static registry).
 */
export async function listAgyModels(opts: ListAgyModelsOptions): Promise<AgyModelEntry[]> {
	let run: AgyModelsRun;
	try {
		run = opts.runner
			? opts.runner(opts.bin)
			: defaultRunner(opts.bin, opts.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS);
	} catch {
		return [];
	}
	if (run.spawnError !== undefined || run.exitCode !== 0) return [];
	return parseAgyModelsOutput(run.stdout);
}

function defaultRunner(bin: string, timeoutMs: number): AgyModelsRun {
	try {
		const res = spawnSync(bin, ["models"], {
			encoding: "utf8",
			timeout: timeoutMs,
			env: process.env,
		});
		return {
			stdout: typeof res.stdout === "string" ? res.stdout : "",
			exitCode: res.status,
			// Marker parity with spawn.ts conventions: ENOENT when the binary is
			// absent, a generic marker for any other spawn failure.
			spawnError: res.error
				? (res.error as NodeJS.ErrnoException).code ?? "spawn"
				: undefined,
		};
	} catch {
		return { stdout: "", exitCode: null, spawnError: "spawn" };
	}
}
