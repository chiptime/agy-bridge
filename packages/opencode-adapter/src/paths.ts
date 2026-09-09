/**
 * Path policy for the adapter (R7 state file, R9 scratch root). Pure and
 * injectable: environment comes in as data so tests never mutate
 * process.env, and every consumer gets one canonical resolution.
 */
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface PathOptions {
	/** Environment snapshot; defaults to process.env. */
	env?: Record<string, string | undefined>;
	/** Hard override for the state dir root (already validated absolute by config). */
	override?: string;
}

/**
 * XDG state dir for agy-bridge: an absolute XDG_STATE_HOME wins, a relative
 * one is ignored per the XDG spec, otherwise ~/.local/state. A caller-supplied
 * override beats everything.
 */
export function resolveStateDir(opts: PathOptions = {}): string {
	const root = opts.override ?? xdgStateRoot(opts.env ?? process.env);
	return join(root, "agy-bridge");
}

function xdgStateRoot(env: Record<string, string | undefined>): string {
	const xdg = env["XDG_STATE_HOME"];
	if (xdg && isAbsolute(xdg)) return xdg;
	const home = env["HOME"] || homedir();
	return join(home, ".local", "state");
}

/** Exact session-map location (R7): `<state>/agy-bridge/opencode-sessions.json`. */
export function sessionMapPath(opts: PathOptions = {}): string {
	return join(resolveStateDir(opts), "opencode-sessions.json");
}

export interface ScratchOptions {
	/** Config scratchRoot (validated absolute). */
	override?: string;
	/** Injectable tmpdir for tests; defaults to os.tmpdir(). */
	tmpdir?: string;
}

/** Scratch root for per-run workdirs (R9): config value ?? os.tmpdir(). */
export function resolveScratchRoot(opts: ScratchOptions = {}): string {
	return opts.override ?? opts.tmpdir ?? tmpdir();
}
