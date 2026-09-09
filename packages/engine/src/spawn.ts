/**
 * Contained agy runner: workdir-only exposure (never --add-dir), hard
 * timeout, run.log capture, and the daily pattern guard counted from
 * agy's own conversation databases. The runner is async (node:child_process
 * spawn) and consumes agy's `--output-format stream-json` NDJSON stream:
 * every line is flushed to run.log AS IT ARRIVES, the `init` event yields the
 * conversation id (a recovery handle that survives timeouts/kills), and the
 * final `result` event carries the same typed envelope as json mode.
 */
import { mkdirSync, readdirSync, statSync, openSync, closeSync, appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface SpawnOptions {
	bin: string;
	prompt: string;
	workdir: string;
	timeoutMs: number;
	env?: Record<string, string>;
	/** Requested model passed through to agy as `--model`; omitted when empty. */
	model?: string;
	/** Resume handle: appends `--conversation <id>` to continue an existing agy conversation. */
	resumeConversationId?: string;
}

export interface SpawnRun {
	exitCode: number | null;
	timedOut: boolean;
	log: string;
	elapsedMs: number;
	spawnError?: string;
	/** Final envelope from the stream-json `result` event; unset when absent or unparseable. */
	envelope?: AgyEnvelope;
	/** True when the stall watchdog SIGTERMed the child after stallMs without a single output line. */
	stalled?: boolean;
	/** agy conversation id from the stream-json `init` event; captured early so it survives timeouts/kills. */
	conversationId?: string;
	/** Stream progress: count of parsed NDJSON event lines and the last event type; present only when at least one event line arrived. */
	progress?: { events: number; lastEvent?: string };
}

/** Token accounting reported by agy's envelope. */
export interface AgyUsage {
	input_tokens: number;
	output_tokens: number;
	thinking_tokens: number;
	cache_read_tokens: number;
	total_tokens: number;
}

/** Typed envelope agy prints (json mode on stdout; stream-json wraps it in the `result` event). */
export interface AgyEnvelope {
	conversation_id?: string;
	status?: string;
	response?: string;
	error?: string;
	num_turns?: number;
	usage?: AgyUsage;
}

/** Validate an unknown value as an agy envelope: an object with a string `status` field. */
function asAgyEnvelope(raw: unknown): AgyEnvelope | null {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
	const rec = raw as Record<string, unknown>;
	if (typeof rec.status !== 'string') return null;
	return raw as AgyEnvelope;
}

/**
 * Parse agy's `--output-format json` envelope from stdout. In json mode the
 * envelope is the whole stdout (possibly with a trailing newline); when other
 * noise precedes it, fall back to the LAST non-empty line. Returns null on
 * anything that is not an object with a string `status` field; never throws.
 */
export function parseAgyEnvelope(stdout: string): AgyEnvelope | null {
	const text = stdout.trim();
	if (text === '') return null;
	const candidates = [text, ...text.split('\n').reverse().map((l) => l.trim()).filter((l) => l !== '')];
	for (const cand of candidates) {
		try {
			const env = asAgyEnvelope(JSON.parse(cand));
			if (env) return env;
		} catch {
			continue;
		}
	}
	return null;
}

/**
 * Classify ONE `--output-format stream-json` NDJSON line (pure, tolerant).
 * - `init` event  → conversationId (the early recovery handle).
 * - `result` event → the final envelope, validated exactly like parseAgyEnvelope.
 * - any line with a string `event` → that event type, for progress surfacing.
 * A bare envelope line (object with string `status`, no `event`) also yields
 * the envelope, for tolerance against agy quirks. Non-JSON lines → {}.
 */
export function parseStreamLine(line: string): { conversationId?: string; envelope?: AgyEnvelope; event?: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return {};
	}
	if (typeof parsed !== 'object' || parsed === null) return {};
	const rec = parsed as Record<string, unknown>;
	const out: { conversationId?: string; envelope?: AgyEnvelope; event?: string } = {};
	if (typeof rec.event === 'string') out.event = rec.event;
	if (rec.event === 'init' && typeof rec.conversation_id === 'string') out.conversationId = rec.conversation_id;
	if (rec.event === 'result') out.envelope = asAgyEnvelope(rec.result) ?? undefined;
	if (rec.event === undefined) out.envelope = asAgyEnvelope(parsed) ?? undefined;
	return out;
}

/**
 * Build the agy print-mode argv. NOTE: no --add-dir beyond the workdir ever;
 * agy runs with skip-permissions so any added dir would be writable.
 */
export function buildAgyArgs(opts: SpawnOptions, outputFormat: 'json' | 'stream-json' = 'json'): string[] {
	const args = ['--print', opts.prompt, '--add-dir', opts.workdir, '--dangerously-skip-permissions'];
	// agy's print-mode client wait defaults to 5m0s; without an explicit value long
	// explorations die at 300s while our budgets (AGY_EXPLORE_TIMEOUT_MS defaults:
	// 1200s CLI / 1230s plugin) never fire. Derive the flag from timeoutMs so it
	// fires slightly BEFORE our async runner's hard cap, which stays strictly
	// larger and remains the outer killer.
	const secs = Math.max(1, Math.floor((opts.timeoutMs - 10_000) / 1000));
	args.push('--print-timeout', `${secs}s`);
	// json mode: one typed envelope (status/error/conversation_id/usage) on
	// stdout. stream-json mode: NDJSON (init → step_update… → result) so the
	// runner can stream progress and capture the conversation id early.
	args.push('--output-format', outputFormat);
	if (opts.resumeConversationId) args.push('--conversation', opts.resumeConversationId);
	if (opts.model) args.push('--model', opts.model);
	return args;
}

/**
 * Stall watchdog default: 10 minutes without a single stdout/stderr line.
 * EVIDENCE (live probe 2026-09-09, `--output-format stream-json`, trivial
 * prompt, 18s total): a real run streams 28 NDJSON lines — `init` first, 26
 * intermediate `step_update` events, `result` last — so a silent child means
 * a hung transport/backend, not healthy generation, and killing it is safe.
 * Caveat: `agent_response` steps emit only on DONE (no progress events inside
 * a single long LLM turn), so one very long generation is silent while it
 * runs; the measured heaviest full run is 173s, far inside the window.
 * `stallMs: 0` disables the watchdog entirely.
 */
export const DEFAULT_STALL_MS = 600_000;

export interface StreamSpawnOptions extends SpawnOptions {
	/** Stall watchdog ms without any output line before SIGTERM; 0 disables. Default DEFAULT_STALL_MS. */
	stallMs?: number;
	/** Test seam: replace the real child_process spawn. */
	spawnImpl?: typeof spawn;
}

/**
 * Async stream runner over agy's NDJSON output: opens/truncates run.log up
 * front and appends every stdout line and stderr chunk the moment they
 * arrive (so a killed run still leaves its progress on disk), resets a stall
 * watchdog on every line, enforces the overall hard cap at timeoutMs
 * (SIGTERM), and returns whatever was captured — init conversation id and
 * partial log included — even when killed.
 */
export async function runAgyStream(opts: StreamSpawnOptions): Promise<SpawnRun> {
	mkdirSync(opts.workdir, { recursive: true });
	const start = Date.now();
	const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
	return new Promise<SpawnRun>((resolve) => {
		const spawnFn = opts.spawnImpl ?? spawn;
		const child = spawnFn(opts.bin, buildAgyArgs(opts, 'stream-json'), {
			cwd: opts.workdir,
			env: opts.env ? { ...process.env, ...opts.env } : process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const logFd = openSync(`${opts.workdir}/run.log`, 'w');
		let log = '';
		let envelope: AgyEnvelope | undefined;
		let conversationId: string | undefined;
		let eventCount = 0;
		let lastEvent: string | undefined;
		let exitCode: number | null = null;
		let timedOut = false;
		let stalled = false;
		let spawnError: string | undefined;
		let settled = false;
		let stallTimer: ReturnType<typeof setTimeout> | null = null;
		const append = (chunk: string) => {
			log += chunk;
			try {
				appendFileSync(logFd, chunk);
			} catch {
				/* disk error — the in-memory log still wins */
			}
		};
		const armStall = () => {
			if (stallTimer) clearTimeout(stallTimer);
			if (stallMs <= 0 || settled) return;
			stallTimer = setTimeout(() => {
				stalled = true;
				child.kill('SIGTERM');
			}, stallMs);
		};
		const capTimer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGTERM');
		}, opts.timeoutMs);
		const finish = () => {
			if (settled) return;
			settled = true;
			if (stallTimer) clearTimeout(stallTimer);
			clearTimeout(capTimer);
			// Release the stdio pipes: after a kill, grandchildren (e.g. a sleep
			// the shell spawned) can hold them open and delay 'close' indefinitely.
			child.stdout?.destroy();
			child.stderr?.destroy();
			try {
				closeSync(logFd);
			} catch {
				/* already closed */
			}
			resolve({
				exitCode,
				timedOut,
				log,
				elapsedMs: Date.now() - start,
				envelope,
				conversationId,
				progress: eventCount > 0 ? { events: eventCount, lastEvent } : undefined,
				stalled: stalled || undefined,
				spawnError,
			});
		};
		child.on('error', (err: NodeJS.ErrnoException) => {
			spawnError = err.code === 'ENOENT' ? 'ENOENT' : err.message;
		});
		armStall();
		const rl = createInterface({ input: child.stdout! });
		rl.on('line', (line: string) => {
			armStall();
			append(`${line}\n`);
			const got = parseStreamLine(line);
			if (got.event !== undefined) {
				eventCount++;
				lastEvent = got.event;
			}
			if (got.conversationId !== undefined) conversationId = got.conversationId;
			if (got.envelope !== undefined) envelope = got.envelope;
		});
		child.stderr?.on('data', (chunk: Buffer) => {
			armStall();
			append(chunk.toString('utf8'));
		});
		// Resolve on the FIRST of exit|close: 'close' waits for the stdio pipes
		// to drain, which a killed process tree can delay indefinitely (see
		// finish()); 'exit' is the reliable signal that the child is gone.
		child.on('exit', (code: number | null) => {
			exitCode = code;
			finish();
		});
		child.on('close', (code: number | null) => {
			if (!settled) exitCode = code;
			finish();
		});
	});
}

/** The ONE agy runner (async): runAgyStream is the implementation; this alias keeps call sites readable. */
export const runAgy = runAgyStream;

/** Daily guard: count agy conversation DBs touched since the start of `day`. */
export function countRecentConversations(conversationsDir: string, day: Date): number {
	const since = new Date(day);
	since.setHours(0, 0, 0, 0);
	try {
		return readdirSync(conversationsDir)
			.filter((f) => f.endsWith('.db'))
			.filter((f) => statSync(`${conversationsDir}/${f}`).mtime >= since)
			.length;
	} catch {
		return 0;
	}
}
