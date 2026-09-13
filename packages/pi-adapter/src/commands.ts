/**
 * The /agy command builders (spec R10). pi's registerCommand consumes
 * `{ description, handler }` per the RegisteredCommand shape; this
 * module exports the BUILDER (createAgyCommand) plus the pure status
 * renderer — the D4 factory performs the actual registration
 * (pi.registerCommand("agy", createAgyCommand(deps))).
 *
 * /agy status summarizes bridge state through the lifecycle registry
 * and the session store: a config summary of non-secret fields only
 * (binary, per-attempt timeout, state dir — the config surface holds
 * no credentials), the discovered model count with the discovery
 * cache's age and freshness, the current session's persisted binding
 * (conversation id + baseline size, or "none"), the session's AskAgy
 * thread binding (v0.3 R5 — `thread: <id> (resume-always)` or none),
 * and whether a turn is in flight for that session. /agy clear drops
 * the current session's PERSISTED binding rows — BOTH the session row
 * and its `:ask` thread row (R5 key `sessionId ?? cwd`, both read from
 * the command context) — and their in-memory registry entries.
 * Anything else — including a bare /agy — prints usage help.
 */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { BridgeState } from "./lifecycle";
import { askThreadKey, piSessionKey, type SessionStore } from "./session-store";

export const AGY_USAGE_LINES: readonly string[] = [
	"Usage: /agy <subcommand>",
	"  status — show agy bridge state (config, models, session + thread bindings, in-flight turn)",
	"  clear  — clear this session's persisted agy bindings (session AND thread rows) and in-memory state",
];

export interface AgyCommandDeps {
	/** agy binary (config.agyBin) — displayed as-is, never secret. */
	bin: string;
	/** Per-attempt timeout (config.timeoutMs). */
	timeoutMs: number;
	/** Resolved state dir (config.stateDir). */
	stateDir: string;
	/** Persistent session store (R5 rows). */
	store: SessionStore;
	/** Lifecycle registry: discovery cache, in-flight turns, binding cache. */
	state: BridgeState;
	/** Wall-clock seam (tests). */
	now?: () => number;
}

/** Compact human age: 2.0s → 2.0m → 2.0h. */
function formatAge(ms: number): string {
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
	return `${(ms / 3_600_000).toFixed(1)}h`;
}

/** Render the status lines for one session key (pure read; warms the binding cache). */
export async function buildStatusLines(deps: AgyCommandDeps, key: string): Promise<string[]> {
	const now = deps.now ?? Date.now;
	const discovery = deps.state.discoverySnapshot(now());
	const modelsLine =
		discovery === undefined
			? "models: no discovery cache"
			: `models: ${discovery.rows.length} discovered, cache ${formatAge(discovery.ageMs)} old (${discovery.fresh ? "fresh" : "stale"})`;
	const entry = await deps.state.lookupBinding(deps.store, key);
	const sessionLine =
		entry === undefined
			? "session: none"
			: `session: ${entry.conversationId} (${entry.hashes !== undefined ? `${entry.hashes.length} hashes` : "unknown baseline"})`;
	// v0.3 R5/D5: the AskAgy thread binding (derived INSIDE from the same
	// shared key — never forked). Thread rows are always hash-less, so the
	// thread line never prints a hash count.
	const threadEntry = await deps.state.lookupBinding(deps.store, askThreadKey(key));
	const threadLine = threadEntry === undefined ? "thread: none" : `thread: ${threadEntry.conversationId} (resume-always)`;
	const turn = deps.state.currentTurn(key);
	const turnLine =
		turn === undefined ? "turn: idle" : `turn: in flight (${formatAge(Math.max(0, now() - turn.startedAt))})`;
	return [
		"agy bridge status",
		`  bin: ${deps.bin} (timeout ${Math.round(deps.timeoutMs / 1000)}s)`,
		`  state: ${deps.stateDir}`,
		`  ${modelsLine}`,
		`  ${sessionLine}`,
		`  ${threadLine}`,
		`  ${turnLine}`,
	];
}

/** The R5 session key at the command boundary: the session's id, else the project cwd (shared derivation, v0.3 D1). */
function commandSessionKey(ctx: ExtensionCommandContext): string {
	return piSessionKey(ctx);
}

export interface AgyCommand {
	description: string;
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

/**
 * Build the /agy command options for pi.registerCommand. The subcommand
 * is the first whitespace token; anything after it is ignored.
 */
export function createAgyCommand(deps: AgyCommandDeps): AgyCommand {
	return {
		description: "agy bridge: status and session-binding management",
		async handler(args, ctx) {
			const sub = args.trim().split(/\s+/)[0] ?? "";
			const key = commandSessionKey(ctx);
			if (sub === "status") {
				ctx.ui.notify((await buildStatusLines(deps, key)).join("\n"), "info");
			} else if (sub === "clear") {
				// v0.3 R5/D4: the session row AND its thread row share the
				// session's fate — both persisted rows and both cache entries.
				const askKey = askThreadKey(key);
				const entry = await deps.store.getEntry(key);
				const threadEntry = await deps.store.getEntry(askKey);
				await deps.store.rebind(key);
				await deps.store.rebind(askKey);
				deps.state.dropBinding(key);
				deps.state.dropBinding(askKey);
				ctx.ui.notify(
					entry !== undefined && threadEntry !== undefined
						? `agy bindings cleared: conversation ${entry.conversationId} (session) and thread conversation ${threadEntry.conversationId}`
						: entry !== undefined
							? `agy binding cleared: conversation ${entry.conversationId}`
							: threadEntry !== undefined
								? `agy binding cleared: thread conversation ${threadEntry.conversationId}`
								: "no agy binding for this session",
					"info",
				);
			} else {
				ctx.ui.notify(AGY_USAGE_LINES.join("\n"), "info");
			}
		},
	};
}
