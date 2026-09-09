/**
 * stdout tap for live status parts and abort control (design D1/D2). The
 * engine keeps sole ownership of NDJSON parsing for classification; this
 * wrapper only attaches a second 'data' listener on child.stdout INSIDE the
 * spawnImpl call — the same synchronous tick in which runAgyStream later
 * attaches its readline — so Node broadcasts every chunk to both consumers
 * and no bytes are lost. The wrapper retains the ChildProcess so an abort
 * can SIGTERM it (agy runs --dangerously-skip-permissions); the engine then
 * resolves SpawnRun normally and the tapped conversationId survives as the
 * resume handle. One tap per run attempt: resume attempts create a fresh tap.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { parseStreamLine } from "agy-bridge-engine";

export interface StreamTap {
	/** Drop-in spawn seam for StreamSpawnOptions.spawnImpl. */
	spawnImpl: typeof spawn;
	/** SIGTERM the tapped child (idempotent); auto-wired to opts.signal. */
	abort(): void;
	/** Conversation id captured by the tap's own line parser; survives kills. */
	readonly conversationId: string | undefined;
	/** Every complete stdout line in arrival order. */
	readonly lines: readonly string[];
}

export interface TapOptions {
	/** Fires abort() (SIGTERM) when the signal aborts. */
	signal?: AbortSignal;
	/** Injectable inner spawn for tests; defaults to node:child_process spawn. */
	spawnFn?: typeof spawn;
}

export function createTap(onLine?: (line: string) => void, opts: TapOptions = {}): StreamTap {
	const spawnFn = opts.spawnFn ?? spawn;
	let child: ChildProcess | undefined;
	let buffer = "";
	let conversationId: string | undefined;
	const lines: string[] = [];
	const consume = (line: string) => {
		if (line === "") return;
		lines.push(line);
		const got = parseStreamLine(line);
		if (got.conversationId !== undefined) conversationId = got.conversationId;
		onLine?.(line);
	};
	const tap: StreamTap = {
		// Attach the tap listener synchronously at spawn time, before the
		// engine's readline: chunk broadcast then reaches both consumers.
		spawnImpl: ((...args: Parameters<typeof spawn>) => {
			child = spawnFn(...args);
			child.stdout?.on("data", (chunk: Buffer) => {
				buffer += chunk.toString("utf8");
				let nl: number;
				while ((nl = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 1);
					consume(line);
				}
			});
			// Mirror readline: a final unterminated line still counts on exit.
			child.on("exit", () => {
				if (buffer !== "") {
					const rest = buffer;
					buffer = "";
					consume(rest);
				}
			});
			return child;
		}) as typeof spawn,
		abort: () => {
			if (child && !child.killed) child.kill("SIGTERM");
		},
		get conversationId() {
			return conversationId;
		},
		get lines() {
			return lines;
		},
	};
	opts.signal?.addEventListener("abort", () => tap.abort(), { once: true });
	return tap;
}
