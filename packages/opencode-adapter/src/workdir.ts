/**
 * Workdir authority for agy runs (spec R9 + threat matrix): scratch mode
 * gives every turn a fresh mkdtemp dir under the configured root (never a
 * relative path, never a second --add-dir — the engine adds exactly the
 * workdir); session mode uses the plugin worktree verbatim as the child's
 * cwd, validated absolute, NOT the filesystem root, and existing BEFORE
 * any spawn can happen (the root is "/" for the opencode "global" project
 * and would otherwise turn run.log into //run.log → EACCES). The
 * 7-day scratch prune reclaims old run dirs while keeping each run.log —
 * terminal error messages (R6) point users at those paths.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { AgyConfigError, type WorkdirMode } from "./config";

export const SCRATCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface WorkdirOptions {
	/** Absolute scratch root (validated by config); default os.tmpdir(). */
	scratchRoot?: string;
	/** Plugin worktree; required and validated in session mode. */
	worktree?: string;
	/** Injectable tmpdir for tests. */
	tmpdir?: string;
}

export interface PreparedWorkdir {
	/** The dir the child will run in: also the single --add-dir value. */
	dir: string;
	/** True when this dir is adapter-owned scratch (prune domain). */
	scratch: boolean;
}

/**
 * Resolve the run cwd for one turn. Session mode NEVER falls back: a
 * relative, missing, or absent worktree throws {@link AgyConfigError} so
 * the turn aborts before spawning anything (threat matrix case 3).
 */
export function prepareWorkdir(mode: WorkdirMode, opts: WorkdirOptions): PreparedWorkdir {
	if (mode === "session") {
		const worktree = opts.worktree;
		if (worktree === undefined || !isAbsolute(worktree)) {
			throw new AgyConfigError(
				"worktree",
				`session workdirMode requires an absolute worktree, got "${String(worktree)}"`,
			);
		}
		if (worktree === "/") {
			throw new AgyConfigError(
				"worktree",
				'session workdirMode refuses the filesystem root "/" — opencode reports "/" for non-git directories; run inside a git worktree or switch workdirMode to "scratch"',
			);
		}
		let stat;
		try {
			stat = statSync(worktree);
		} catch {
			stat = undefined;
		}
		if (!stat?.isDirectory()) {
			throw new AgyConfigError("worktree", `session worktree does not exist: "${worktree}"`);
		}
		return { dir: worktree, scratch: false };
	}
	const root = opts.scratchRoot ?? opts.tmpdir ?? tmpdir();
	return { dir: mkdtempSync(join(root, "agy-run-")), scratch: true };
}

/**
 * Prune scratch dirs older than 7 days: everything inside is removed
 * EXCEPT run.log (kept so R6 log-path messages keep resolving). ONLY dirs
 * named with our own `agy-run-` prefix are ever considered — the default
 * root is os.tmpdir() and foreign dirs there must never be touched.
 * Returns the number of pruned dirs; an unreadable root prunes nothing.
 */
export function pruneScratch(root: string, now: Date = new Date()): number {
	let entries;
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return 0;
	}
	let pruned = 0;
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith("agy-run-")) continue;
		const dir = join(root, entry.name);
		let mtime: Date;
		try {
			mtime = statSync(dir).mtime;
		} catch {
			continue;
		}
		if (mtime.getTime() > now.getTime() - SCRATCH_MAX_AGE_MS) continue;
		for (const inner of readdirSync(dir)) {
			if (inner === "run.log") continue;
			rmSync(join(dir, inner), { recursive: true, force: true });
		}
		pruned++;
	}
	return pruned;
}
