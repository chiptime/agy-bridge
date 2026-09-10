/**
 * Scratch containment for AskAgy delegations (spec R9 + threat-matrix
 * "Git repository selection" row): every default-scope delegation spawns
 * in a FRESH agy-run-* tmp dir created under the config-validated
 * scratch root (config.scratchRoot ?? os.tmpdir()) — never the pi
 * project dir, never ctx.cwd, and never anything a caller supplied.
 * Each prep ALSO prunes sibling agy-run-* dirs older than 7 days;
 * foreign entries (any name without the prefix) are never touched, and
 * neither are fresh dirs.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const SCRATCH_DIR_PREFIX = "agy-run-";
export const SCRATCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ScratchPrepOptions {
	/** Validated absolute scratch root (config.scratchRoot ?? os.tmpdir()). */
	root: string;
	/** Wall-clock seam (tests); default Date.now. */
	now?: () => number;
}

export interface ScratchWorkdir {
	/** Fresh agy-run-* dir the delegated child spawns in. */
	path: string;
	/** Stale agy-run-* siblings removed by this prep. */
	pruned: string[];
}

/**
 * Prepare the scratch workdir for one delegation: prune stale siblings
 * (prefix-matched agy-run-* older than SCRATCH_MAX_AGE_MS only), then
 * create a fresh mkdtemp dir. The root is created on demand — a
 * user-configured absolute scratchRoot may not exist on first run.
 */
export function prepareScratchWorkdir(opts: ScratchPrepOptions): ScratchWorkdir {
	const now = opts.now ?? Date.now;
	mkdirSync(opts.root, { recursive: true });
	const pruned: string[] = [];
	let entries: string[];
	try {
		entries = readdirSync(opts.root);
	} catch {
		entries = [];
	}
	for (const name of entries) {
		if (!name.startsWith(SCRATCH_DIR_PREFIX)) continue; // foreign dirs are untouchable
		const full = join(opts.root, name);
		try {
			if (statSync(full).mtimeMs <= now() - SCRATCH_MAX_AGE_MS) {
				rmSync(full, { recursive: true, force: true });
				pruned.push(full);
			}
		} catch {
			/* raced away between readdir and stat — nothing to prune */
		}
	}
	const path = mkdtempSync(join(opts.root, SCRATCH_DIR_PREFIX));
	return { path, pruned };
}
