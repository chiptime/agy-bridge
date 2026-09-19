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
	/**
	 * R2 seam: redirect target for the streamed run log (mode 'w', line by
	 * line). Defaults to `<workdir>/run.log`; the parent directory is the
	 * caller's responsibility.
	 */
	logPath?: string;
	/**
	 * Prompt transport (additive, default off = existing behavior): when
	 * true the prompt travels on the child's stdin as ONE stream-json
	 * NDJSON user line — verified against the real binary (2026-09-11):
	 * `--print` REQUIRES a value (a bare `--print` is rejected and raw
	 * stdin text is never read in print mode), so argv switches to
	 * `--input-format stream-json --output-format stream-json` with no
	 * `--print` family flag at all. The runner writes
	 * `{"event":"user","message":{"role":"user","content":"<prompt>"}}`
	 * once, then closes the pipe — hostile prompt content can never reach
	 * argv.
	 */
	promptViaStdin?: boolean;
	/**
	 * Delegation mode seam (v0.2 R10, additive): "plan" maps AskAgy's
	 * read/none modes, "accept-edits" maps full. When set, `--mode <v>` is
	 * pushed in BOTH argv branches immediately after
	 * --dangerously-skip-permissions; undefined keeps the argv byte-identical
	 * to v0.1. --sandbox is never emitted (incompatible with
	 * skip-permissions, D3).
	 */
	mode?: "plan" | "accept-edits";
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
	/** True when the child never confirmed death (no exit/close) before the bounded termination chain's final settle deadline fired. */
	terminationUnconfirmed?: boolean;
	/** Which path requested termination first: the hard cap, the stall watchdog, or an external abort. */
	terminationTrigger?: 'timeout' | 'stall' | 'abort';
	/** First signal we asked the child to die with (SIGTERM today). */
	requestedSignal?: string;
	/** Escalation signal attempted after the grace window; recorded even when the kill call threw. */
	escalatedSignal?: string;
	/** Signal argument reported by the child's `close` event, when one arrived before settlement. */
	observedSignal?: string;
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
 * Build the agy argv. NOTE: no --add-dir beyond the workdir ever; agy runs
 * with skip-permissions so any added dir would be writable.
 */
export function buildAgyArgs(opts: SpawnOptions, outputFormat: 'json' | 'stream-json' = 'json'): string[] {
	if (opts.promptViaStdin) {
		// Corrected stdin transport (verified live): `--print` requires a
		// value, so the only stdin route is NDJSON stream mode — one user
		// line on stdin (written by runAgyStream). The --print-timeout flag
		// belongs to print mode and stays off; the runner's own timeoutMs
		// hard cap and stall watchdog remain the killers.
		const stdinArgs = [
			'--input-format',
			'stream-json',
			'--output-format',
			'stream-json',
			'--add-dir',
			opts.workdir,
			'--dangerously-skip-permissions',
		];
		// Mode seam (R10): identical position in both branches — right after
		// --dangerously-skip-permissions, before the resume/model flags.
		if (opts.mode !== undefined) stdinArgs.push('--mode', opts.mode);
		if (opts.resumeConversationId) stdinArgs.push('--conversation', opts.resumeConversationId);
		if (opts.model) stdinArgs.push('--model', opts.model);
		return stdinArgs;
	}
	const args = [
		'--print',
		opts.prompt,
		'--add-dir',
		opts.workdir,
		'--dangerously-skip-permissions',
	];
	// Mode seam (R10): identical position in both branches — right after
	// --dangerously-skip-permissions, before the format/resume/model flags.
	if (opts.mode !== undefined) args.push('--mode', opts.mode);
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

/**
 * Bounded-termination chain bounds: after a termination request (cap, stall
 * watchdog, or abort) the child gets TERMINATION_GRACE_MS to die from the
 * SIGTERM before escalation to SIGKILL, then TERMINATION_FINAL_DEADLINE_MS
 * more to report exit/close before the run settles as unconfirmed. Internal
 * bounds, not public config; worst-case added latency per attempt is their
 * sum (10s).
 */
export const TERMINATION_GRACE_MS = 5_000;
export const TERMINATION_FINAL_DEADLINE_MS = 5_000;

export interface StreamSpawnOptions extends SpawnOptions {
	/** Stall watchdog ms without any output line before SIGTERM; 0 disables. Default DEFAULT_STALL_MS. */
	stallMs?: number;
	/** Test seam: replace the real child_process spawn. */
	spawnImpl?: typeof spawn;
	/**
	 * External cancellation: aborting this signal drives the bounded
	 * termination chain via requestTermination('abort'). Consumed by
	 * runAgyStream itself — never forwarded to spawn(). Declared explicitly
	 * because the engine's local SpawnOptions (unlike node's own) does not
	 * carry it.
	 */
	signal?: AbortSignal;
	/** Test/internal seam: SIGTERM→SIGKILL escalation delay. Default TERMINATION_GRACE_MS. */
	terminationGraceMs?: number;
	/** Test/internal seam: settle deadline after SIGKILL without a confirmed death. Default TERMINATION_FINAL_DEADLINE_MS. */
	terminationSettleMs?: number;
}

/**
 * Async stream runner over agy's NDJSON output: opens/truncates run.log up
 * front and appends every stdout line and stderr chunk the moment they
 * arrive (so a killed run still leaves its progress on disk), resets a stall
 * watchdog on every line, enforces the overall hard cap at timeoutMs, and
 * returns whatever was captured — init conversation id and partial log
 * included — even when killed. Termination is a bounded chain (SIGTERM →
 * SIGKILL after TERMINATION_GRACE_MS → forced settlement after
 * TERMINATION_FINAL_DEADLINE_MS, flagged terminationUnconfirmed) driven by
 * the cap, the stall watchdog, or an external abort signal, so an
 * unkillable child can never hang the attempt.
 */
export async function runAgyStream(opts: StreamSpawnOptions): Promise<SpawnRun> {
	mkdirSync(opts.workdir, { recursive: true });
	const start = Date.now();
	const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
	return new Promise<SpawnRun>((resolve) => {
		const spawnFn = opts.spawnImpl ?? spawn;
		// Open the attempt log BEFORE spawning the child (reordered — see
		// timeout-recovery PRD review): if this throws (permissions, disk
		// full, a TOCTOU race on the parent directory), no child is ever
		// spawned. Opening it AFTER spawnFn(...) would leave an
		// already-running child with no error handler and no watchdogs
		// attached yet if the open failed — an orphaned, unmonitored
		// process. Mode 0o600: owner-restricted access (PRD section 3);
		// process output captured here may be sensitive.
		const logFd = openSync(opts.logPath ?? `${opts.workdir}/run.log`, 'w', 0o600);
		// spawnFn is production-real Node spawn(), which never throws
		// synchronously for realistic failures (ENOENT surfaces async via
		// the 'error' event, handled below) — this try/catch only guards
		// the test-only injection seam (StreamSpawnOptions.spawnImpl) and
		// any argument-validation TypeError. Without it, a synchronous
		// throw here would leave the already-opened logFd leaked: nothing
		// downstream (armStall/finish/child.on('error')) has been reached
		// yet to close it.
		let child: ReturnType<typeof spawn>;
		try {
			child = spawnFn(opts.bin, buildAgyArgs(opts, 'stream-json'), {
				cwd: opts.workdir,
				env: opts.env ? { ...process.env, ...opts.env } : process.env,
				stdio: [opts.promptViaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
			});
		} catch (err) {
			try {
				closeSync(logFd);
			} catch {
				/* already closed */
			}
			throw err;
		}
		if (opts.promptViaStdin) {
			// Prompt transport: stdin, never argv. ONE NDJSON user line (the
			// stream-json input contract); the child processes the turn and
			// exits on stdin EOF. A child killed before draining the pipe
			// (timeout/abort) makes this write fail with EPIPE — swallow it;
			// the kill path owns the outcome.
			child.stdin?.on('error', () => {});
			child.stdin?.end(
				JSON.stringify({ event: 'user', message: { role: 'user', content: opts.prompt } }) + '\n',
			);
		}
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
		let graceTimer: ReturnType<typeof setTimeout> | null = null;
		let finalTimer: ReturnType<typeof setTimeout> | null = null;
		let terminationTrigger: SpawnRun['terminationTrigger'];
		let requestedSignal: string | undefined;
		let escalatedSignal: string | undefined;
		let observedSignal: string | undefined;
		let terminationUnconfirmed = false;
		const append = (chunk: string) => {
			log += chunk;
			try {
				appendFileSync(logFd, chunk);
			} catch {
				/* disk error — the in-memory log still wins */
			}
		};
		// Bounded termination chain: requestTermination asks politely with
		// SIGTERM, the grace timer escalates to SIGKILL, and the final settle
		// timer forces settlement even when the child never reports
		// exit/close. Every kill call is try/catch-wrapped — a throwing kill
		// (EPERM, already-reaped pid) must still hand control to the next
		// stage; a timer callback NEVER throws.
		const killOrRecord = (sig: NodeJS.Signals): void => {
			try {
				child.kill(sig);
			} catch (err) {
				// Best-effort diagnostic into the attempt log; the in-memory
				// copy still wins if the fd write fails (same contract as
				// append() below).
				append(
					`[agy-bridge] child.kill(${JSON.stringify(sig)}) failed: ${err instanceof Error ? err.message : String(err)}\n`,
				);
			}
		};
		const requestTermination = (trigger: 'timeout' | 'stall' | 'abort'): void => {
			if (settled) return;
			// Only the FIRST requester owns the recorded trigger.
			if (!terminationTrigger) terminationTrigger = trigger;
			if (!requestedSignal) requestedSignal = 'SIGTERM';
			killOrRecord('SIGTERM');
			// Arm the escalation exactly once, no matter how many triggers fire.
			if (graceTimer) return;
			graceTimer = setTimeout(() => {
				if (settled) return;
				killOrRecord('SIGKILL');
				// Recorded even when the kill threw: the attempt was made.
				escalatedSignal = 'SIGKILL';
				finalTimer = setTimeout(() => {
					if (settled) return;
					// Forced settlement without exit/close: the child ignored
					// every signal (or each kill attempt threw) and this
					// attempt must never hang forever.
					terminationUnconfirmed = true;
					finish();
				}, opts.terminationSettleMs ?? TERMINATION_FINAL_DEADLINE_MS);
			}, opts.terminationGraceMs ?? TERMINATION_GRACE_MS);
		};
		const capTimer = setTimeout(() => {
			timedOut = true;
			requestTermination('timeout');
		}, opts.timeoutMs);
		const armStall = () => {
			if (stallTimer) clearTimeout(stallTimer);
			if (stallMs <= 0 || settled) return;
			stallTimer = setTimeout(() => {
				stalled = true;
				requestTermination('stall');
			}, stallMs);
		};
		const onAbort = () => requestTermination('abort');
		if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
		const onExit = (code: number | null) => {
			exitCode = code;
			finish();
		};
		const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
			// Mirror the exitCode guard: a close racing in after settlement
			// (forced or otherwise) must not mutate the resolved run.
			if (!settled) {
				exitCode = code;
				observedSignal = signal ?? undefined;
			}
			finish();
		};
		const finish = () => {
			if (settled) return;
			settled = true;
			if (stallTimer) clearTimeout(stallTimer);
			clearTimeout(capTimer);
			if (graceTimer) clearTimeout(graceTimer);
			if (finalTimer) clearTimeout(finalTimer);
			opts.signal?.removeEventListener('abort', onAbort);
			child.off('exit', onExit);
			child.off('close', onClose);
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
				terminationUnconfirmed: terminationUnconfirmed || undefined,
				terminationTrigger,
				requestedSignal,
				escalatedSignal,
				observedSignal,
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
		child.on('exit', onExit);
		child.on('close', onClose);
		// Abort composition: an already-aborted signal must still take down
		// this fresh child — fire the same requestTermination('abort') path
		// immediately after spawn. EventTarget never fires listeners added
		// after abort, and the adapters' taps already own the stale-signal
		// kill path upstream; killing here keeps engine behavior
		// self-contained without skipping the spawn.
		if (opts.signal?.aborted) requestTermination('abort');
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
