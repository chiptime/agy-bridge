/**
 * Opt-in unified bridge debug log (v0.2 R11, design D11). Enabled iff
 * AGY_BRIDGE_DEBUG=1; the file is AGY_BRIDGE_DEBUG_PATH ?? join(stateDir,
 * "debug.log") — the resolved config.stateDir already IS "<root>/agy-bridge",
 * so the default lands at the spec's "<stateDir>/agy-bridge/debug.log".
 *
 * Every event appends ONE JSON line `{ts, event, ...fields}` (ISO ts;
 * fields carry ids, codes, and durations only — the API accepts no
 * free-text payload beyond the `event` code, so the prompt body can never
 * reach this log; run.log already holds the full per-run NDJSON and the
 * debug log only indexes it).
 *
 * Size policy (D11): stat before write; a file over 5 MB is truncated to
 * empty before the append (truncate fresh, no rotation chain). The parent
 * directory is created on demand at the first write. Every failure —
 * unwritable path, ENOTDIR, anything — is swallowed: debug must never
 * break the bridge.
 */
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** One structured debug event writer; the only public method is log(). */
export interface DebugLogger {
	log(event: string, fields?: Record<string, unknown>): void;
}

export interface DebugLoggerOptions {
	/** Environment snapshot (gate + path override); defaults to process.env. */
	env?: Record<string, string | undefined>;
	/** Resolved state dir (config.stateDir); debug.log lands directly inside it. */
	stateDir: string;
}

/** D11: a file over 5 MB is truncated fresh before the next append. */
const MAX_BYTES = 5 * 1024 * 1024;

/** Resolve the debug log path for a logger config (exported for tests). */
export function debugLogPath(opts: DebugLoggerOptions): string {
	return (opts.env ?? process.env)["AGY_BRIDGE_DEBUG_PATH"] ?? join(opts.stateDir, "debug.log");
}

/** Build the debug logger: disabled loggers are pure no-ops (R11: unset env → no log writes). */
export function createDebugLogger(opts: DebugLoggerOptions): DebugLogger {
	if ((opts.env ?? process.env)["AGY_BRIDGE_DEBUG"] !== "1") {
		return { log: () => {} };
	}
	const path = debugLogPath(opts);
	let dirReady = false;
	return {
		log(event, fields) {
			try {
				if (!dirReady) {
					mkdirSync(dirname(path), { recursive: true });
					dirReady = true;
				}
				// D11: stat before write; oversize → truncate fresh (a missing
				// file is the normal first-write case and is swallowed above).
				try {
					if (statSync(path).size > MAX_BYTES) writeFileSync(path, "");
				} catch {
					/* stat miss = file absent yet */
				}
				appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}\n`);
			} catch {
				/* debug must never break the bridge */
			}
		},
	};
}
