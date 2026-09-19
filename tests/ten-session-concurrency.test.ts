/**
 * Root-level integration suite: the ten-session concurrency matrix.
 *
 * Proves, on top of the REAL adapters (runTurn of both opencode-adapter and
 * pi-adapter) and the REAL engine (runAgyStream, classifyRun, the bounded
 * termination chain, and acquireConversationLock) — with FAKE child
 * processes only — the concurrency contract that no package-scoped unit
 * suite can prove end to end:
 *
 *  1. Ten genuinely overlapping executions (5 opencode + 5 pi) sharing ONE
 *     tmp project dir and ONE tmp state dir: a harness-level barrier holds
 *     every fake child at spawn until ALL 10 have arrived, then releases
 *     them together. peak === 10 with zero closes before the 10th arrival
 *     proves true overlap, not a serialized Promise.all.
 *  2. Cancellation isolation: aborting ONE session's signal inside the
 *     barrier ends exactly that session (AbortError, existing abort
 *     persistence semantics) while the other nine succeed; only the
 *     canceled child is ever killed.
 *  3. A timeout does not block the set: one session with a tiny timeoutMs
 *     and a go-silent child ends with the timeout-family terminal error
 *     after the adapter's normal attempt policy (exactly the one recovery
 *     spawn, ≤2 spawns), the rest unaffected.
 *  4. Unconfirmed termination never replays: a kill-ignoring child that
 *     never closes settles termination_unconfirmed with EXACTLY ONE spawn,
 *     the honest unconfirmed message (not timeout, not fallthrough),
 *     retryable:false, and no success binding persisted.
 *  5. Exclusive, untruncated logs: every execution's log carries its OWN
 *     SESSION=<id> marker and no file carries another session's; opencode
 *     per-callId groups (attempt log + summary.json) and pi per-attempt
 *     attempt-N.log files are all complete and readable at the end.
 *  6. Retention protects active runs: the opencode diagnostics prune path
 *     (same function, same default retention runTurn uses in session mode)
 *     removes an injected OLD COMPLETED group but keeps every group from
 *     the matrix and an old INCOMPLETE (summary-less) group.
 *  7. Store integrity: all 5 opencode + 5 pi success bindings present (no
 *     lost updates); failed sessions carry exactly what each adapter's
 *     existing failure-persistence rules dictate — and nothing more.
 *  8. Same-conversation exclusion (same process): two concurrent runTurn
 *     calls resuming the SAME stored conversation — the second fails with
 *     the typed busy TurnError before any spawn while the first holds the
 *     lock, and the first completes normally.
 *  9. Cross-process lock proof: two real OS processes contend for the same
 *     conversation lock via a probe script importing the engine source by
 *     absolute path; stdout-line handshakes (with guard timeouts, never
 *     ms-timing) prove proc1 held BEFORE proc2 attempted, proc2 reported
 *     busy, and proc3 acquired cleanly after release.
 *
 * Determinism: every wait is a barrier/ordering handshake wrapped in a
 * bounded guard race — no arbitrary sleeps, no ms-timing assertions. The
 * matrix re-runs per scenario test on fresh mkdtemp roots; this file only
 * ever touches roots it created itself. Provider capacity (real agy fan-out
 * limits) is explicitly NOT proven here — fake children isolate bridge
 * orchestration from the provider.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

// Engine (real): conversation lock + message hashes for pi baseline assertions.
import {
	acquireConversationLock,
	ConversationBusyError,
	messageHashes,
} from "../packages/engine/src/index";
// opencode adapter (real runTurn, store, config, diagnostics).
import {
	runTurn as ocRunTurn,
	TurnError as OcTurnError,
	type TurnDeps as OcTurnDeps,
} from "../packages/opencode-adapter/src/turn";
import { openSessionStore as openOcStore } from "../packages/opencode-adapter/src/session-store";
import { resolveConfig as ocResolveConfig } from "../packages/opencode-adapter/src/config";
import { diagnosticsDirFor, pruneDiagnosticsUnder } from "../packages/opencode-adapter/src/diagnostics";
// pi adapter (real runTurn + store).
import {
	runTurn as piRunTurn,
	TurnError as PiTurnError,
	type TurnDeps as PiTurnDeps,
} from "../packages/pi-adapter/src/turn";
import { openPiSessionStore } from "../packages/pi-adapter/src/session-store";

// --- tmp roots (only ever our own mkdtemp dirs) --------------------------------

const tmpRoots: string[] = [];
function freshRoot(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpRoots.push(dir);
	return dir;
}
afterAll(() => {
	for (const dir of tmpRoots) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort cleanup of our own tmp roots */
		}
	}
});

// --- small deterministic helpers ------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Guard race: an unfulfilled barrier/handshake must FAIL the test, never hang it. */
function guard<T>(p: Promise<T>, label: string, ms = 30_000): Promise<T> {
	return Promise.race([
		p,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error(`${label}: still unresolved after ${ms}ms (barrier deadlock?)`)), ms);
		}),
	]);
}

type Adapter = "oc" | "pi";
/** Child script: "barrier" waits for the full arrival set; "silent" emits init+marker then goes quiet; "neverdie" additionally ignores every kill. */
type ChildMode = "barrier" | "silent" | "neverdie";

interface SessionSpec {
	adapter: Adapter;
	sessionId: string;
	conversationId: string;
	mode: ChildMode;
	controller: AbortController;
	/** Resolved when this session's child receives its FIRST kill (deterministic abort handshake). */
	onKilled?: () => void;
}

interface Harness {
	total: number;
	arrivals: number;
	inFlight: number;
	peak: number;
	closesBeforeFull: number;
	/** Sessions whose children received a kill (recorded once, on the first kill). */
	killedSessions: string[];
	gateResolved: boolean;
	gate: Promise<void>;
	resolveGate: () => void;
	arrivalsDone: Promise<void>;
	arrivalsDoneResolve: () => void;
	arrivalsSignaled: boolean;
	/** When true the gate does NOT auto-resolve at full arrival — the test calls releaseGate() explicitly (deterministic mid-barrier actions). */
	manualRelease: boolean;
	releaseGate: () => void;
}

interface SharedRoots {
	projectDir: string;
	stateDir: string;
	ocStorePath: string;
}

interface SessionOutcome {
	spec: SessionSpec;
	spawns: number;
	fulfilled: boolean;
	result?: {
		conversationId?: string;
		classificationOutcome: string;
		logPath: string;
	};
	error?: unknown;
}

const OC_HASHES = (id: string): string[] => [`h-${id}`];
const PI_CONTENT = (id: string): string => `hello from ${id}`;
const markerOf = (id: string): string => `SESSION=${id}`;

// --- harness: fake children with a full-arrival barrier -------------------------

function makeHarness(total: number, manualRelease = false): Harness {
	const gate = deferred<void>();
	const arrivalsDone = deferred<void>();
	// Mutable handle first: releaseGate/closeGate below reference the object
	// they are attached to.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const harness: any = {
		total,
		arrivals: 0,
		inFlight: 0,
		peak: 0,
		closesBeforeFull: 0,
		killedSessions: [],
		gateResolved: false,
		gate: gate.promise,
		arrivalsDone: arrivalsDone.promise,
		arrivalsDoneResolve: () => {
			arrivalsDone.resolve();
		},
		arrivalsSignaled: false,
		manualRelease,
	};
	// Release the held children (explicit under manualRelease, automatic at
	// full arrival otherwise). Marking gateResolved keeps the accounting
	// single-shot.
	harness.releaseGate = () => {
		if (!harness.gateResolved) {
			harness.gateResolved = true;
			gate.resolve();
		}
	};
	harness.resolveGate = harness.releaseGate;
	return harness as Harness;
}

/** Push this execution's NDJSON: unique init conversation id, its own marker, and the SUCCESS result. */
function emitChildOutput(
	spec: SessionSpec,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	child: any,
	opts: { withResult: boolean },
): void {
	const lines = [
		JSON.stringify({ event: "init", conversation_id: spec.conversationId }),
		markerOf(spec.sessionId),
	];
	if (opts.withResult) {
		lines.push(
			JSON.stringify({
				event: "result",
				result: {
					conversation_id: spec.conversationId,
					status: "SUCCESS",
					response: `done ${spec.sessionId}`,
				},
			}),
		);
	}
	child.stdout.push(Buffer.from(lines.map((l) => `${l}\n`).join("")));
}

/**
 * Per-session spawnFn seam (same shape both adapters inject): records the
 * spawn, runs the harness accounting (inFlight/peak/arrivals), and scripts
 * the child per its mode. Barrier children wait until ALL sessions have
 * arrived before emitting anything and closing — so a serialized runner can
 * never reach peak > 1 and can never collect 10 arrivals at all.
 */
function harnessSpawnFn(spec: SessionSpec, harness: Harness, spawns: { count: number }): never {
	const spawnFn = (_bin: string, _args: string[], _io: { cwd: string }) => {
		spawns.count += 1;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const child: any = new EventEmitter();
		child.stdout = new Readable({ read() {} });
		child.stderr = new Readable({ read() {} });
		child.stdin = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		child.killed = false;
		child.killCalls = 0;
		child.kill = (sig?: string) => {
			child.killCalls += 1;
			if (!child.killed) {
				child.killed = true;
				harness.killedSessions.push(spec.sessionId);
				spec.onKilled?.();
				if (spec.mode !== "neverdie") {
					harness.inFlight = Math.max(0, harness.inFlight - 1);
					queueMicrotask(() => child.emit("close", null, sig ?? "SIGTERM"));
				}
				// neverdie: ignores the kill — no killed state effect, no close.
			}
			return true;
		};
		harness.inFlight += 1;
		harness.peak = Math.max(harness.peak, harness.inFlight);
		harness.arrivals += 1;
		if (spec.mode === "barrier") {
			if (!harness.gateResolved && harness.arrivals >= harness.total) {
				if (!harness.manualRelease) harness.releaseGate();
				// Full arrival is signaled regardless: mid-barrier test actions
				// (e.g. the scenario-2 abort) wait on THIS, then release the gate.
				if (!harness.arrivalsSignaled) {
					harness.arrivalsSignaled = true;
					harness.arrivalsDoneResolve();
				}
			}
			harness.gate.then(
				() => {
					if (child.killed) return; // killed while held at the barrier
					emitChildOutput(spec, child, { withResult: true });
					harness.inFlight = Math.max(0, harness.inFlight - 1);
					if (harness.arrivals < harness.total) harness.closesBeforeFull += 1;
					// Close on a later event-loop phase, NEVER in the same tick as
					// the push: stdout data delivery (readline + tap) is scheduled
					// ahead of setImmediate, so the engine always sees the full
					// output before the run resolves. Deterministic ordering, not
					// a timing sleep.
					setImmediate(() => child.emit("close", 0, null));
				},
				() => {
					/* guard rejected — the test has already failed; leave the child quiet */
				},
			);
		} else {
			// silent / neverdie: emit init + own marker, then go quiet forever
			// (the engine's watchdogs own the outcome; a neverdie child ignores
			// even SIGKILL so only the bounded chain can settle it).
			emitChildOutput(spec, child, { withResult: false });
		}
		return child;
	};
	return spawnFn as never;
}

// --- per-adapter deps ------------------------------------------------------------

function ocDepsFor(
	roots: SharedRoots,
	ocStore: ReturnType<typeof openOcStore>,
	spec: SessionSpec,
	harness: Harness,
	opts: { timeoutMs?: number; terminationGraceMs?: number; terminationSettleMs?: number } = {},
): { deps: OcTurnDeps; spawns: { count: number } } {
	const spawns = { count: 0 };
	const deps: OcTurnDeps = {
		bin: "agy",
		config: ocResolveConfig({
			workdirMode: "session",
			scratchRoot: roots.stateDir,
			stateDir: roots.stateDir,
			timeoutMs: opts.timeoutMs ?? 30_000,
			...(opts.terminationGraceMs !== undefined ? { terminationGraceMs: opts.terminationGraceMs } : {}),
			...(opts.terminationSettleMs !== undefined ? { terminationSettleMs: opts.terminationSettleMs } : {}),
		}),
		store: ocStore,
		worktree: roots.projectDir,
		spawnFn: harnessSpawnFn(spec, harness, spawns),
	};
	return { deps, spawns };
}

function piDepsFor(
	roots: SharedRoots,
	piStore: ReturnType<typeof openPiSessionStore>,
	spec: SessionSpec,
	harness: Harness,
	opts: { timeoutMs?: number; terminationGraceMs?: number; terminationSettleMs?: number } = {},
): { deps: PiTurnDeps; spawns: { count: number } } {
	const spawns = { count: 0 };
	const deps: PiTurnDeps = {
		bin: "agy",
		store: piStore,
		timeoutMs: opts.timeoutMs ?? 30_000,
		workdir: roots.projectDir,
		logRoot: roots.projectDir,
		stateDir: roots.stateDir,
		spawnFn: harnessSpawnFn(spec, harness, spawns),
		...(opts.terminationGraceMs !== undefined ? { terminationGraceMs: opts.terminationGraceMs } : {}),
		...(opts.terminationSettleMs !== undefined ? { terminationSettleMs: opts.terminationSettleMs } : {}),
	};
	return { deps, spawns };
}

/** pi turn request — boundary cast: the adapter's Context/SimpleStreamOptions are pi-host types; the runtime shape used here is the minimal proven one (see packages/pi-adapter/tests/turn.test.ts fixtures). */
function piRequest(spec: SessionSpec): Parameters<typeof piRunTurn>[1] {
	return {
		context: { messages: [{ role: "user", content: PI_CONTENT(spec.sessionId), timestamp: 1 }] },
		options: { sessionId: spec.sessionId, signal: spec.controller.signal },
	} as Parameters<typeof piRunTurn>[1];
}

function ocRequest(spec: SessionSpec): Parameters<typeof ocRunTurn>[1] {
	return {
		prompt: PI_CONTENT(spec.sessionId),
		hashes: OC_HASHES(spec.sessionId),
		sessionId: spec.sessionId,
		signal: spec.controller.signal,
	};
}

// --- the ten-session matrix launcher ---------------------------------------------

interface Matrix {
	roots: SharedRoots;
	harness: Harness;
	specs: SessionSpec[];
	outcomes: Promise<Map<string, SessionOutcome>>;
}

function launchMatrix(
	opts: {
		special?: { sessionId: string; mode: ChildMode; timeoutMs?: number; terminationGraceMs?: number; terminationSettleMs?: number };
		/** Hold the children INSIDE the barrier even at full arrival; the test releases them explicitly (scenario 2). */
		manualRelease?: boolean;
	} = {},
): Matrix {
	const projectDir = freshRoot("agy-ten-conc-project-");
	const stateDir = freshRoot("agy-ten-conc-state-");
	const roots: SharedRoots = {
		projectDir,
		stateDir,
		ocStorePath: join(stateDir, "opencode-sessions.json"),
	};
	const harness = makeHarness(10, opts.manualRelease === true);
	const specs: SessionSpec[] = [];
	for (let i = 0; i < 5; i++) {
		specs.push({
			adapter: "oc",
			sessionId: `oc-${i}`,
			conversationId: `conv-oc-${i}`,
			mode: opts.special?.sessionId === `oc-${i}` ? opts.special.mode : "barrier",
			controller: new AbortController(),
		});
	}
	for (let i = 0; i < 5; i++) {
		specs.push({
			adapter: "pi",
			sessionId: `pi-${i}`,
			conversationId: `conv-pi-${i}`,
			mode: opts.special?.sessionId === `pi-${i}` ? opts.special.mode : "barrier",
			controller: new AbortController(),
		});
	}
	const outcomes = (async () => {
		const t0 = Date.now();
		const map = new Map<string, SessionOutcome>();
		await Promise.all(
			specs.map(async (spec) => {
				const special = opts.special?.sessionId === spec.sessionId ? opts.special : undefined;
				const perTest = { timeoutMs: special?.timeoutMs, terminationGraceMs: special?.terminationGraceMs, terminationSettleMs: special?.terminationSettleMs };
				const outcome: SessionOutcome = { spec, spawns: 0, fulfilled: false };
				if (spec.adapter === "oc") {
					const ocStoreForSession = openOcStore(roots.ocStorePath);
					const { deps, spawns } = ocDepsFor(roots, ocStoreForSession, spec, harness, perTest);
					outcome.spawns = spawns.count;
					try {
						const result = await ocRunTurn(deps, ocRequest(spec));
						outcome.fulfilled = true;
						outcome.result = {
							conversationId: result.conversationId,
							classificationOutcome: result.classification.outcome,
							logPath: result.logPath,
						};
					} catch (err) {
						outcome.error = err;
						console.log(
							`[ten-conc] ${spec.sessionId} rejected: ${(err as Error)?.name}: ${(err as Error)?.message}`,
						);
					}
					outcome.spawns = spawns.count;
				} else {
					const piStoreForSession = openPiSessionStore({ stateDir });
					const { deps, spawns } = piDepsFor(roots, piStoreForSession, spec, harness, perTest);
					try {
						const result = await piRunTurn(deps, piRequest(spec));
						outcome.fulfilled = true;
						outcome.result = {
							conversationId: result.conversationId,
							classificationOutcome: result.classification.outcome,
							logPath: result.logPath,
						};
					} catch (err) {
						outcome.error = err;
						console.log(
							`[ten-conc] ${spec.sessionId} rejected: ${(err as Error)?.name}: ${(err as Error)?.message}`,
						);
					}
					outcome.spawns = spawns.count;
				}
				map.set(spec.sessionId, outcome);
				if (process.env.AGY_TEN_CONC_TIMING === "1") {
					console.log(`[ten-conc-timing] ${spec.sessionId} settled at +${Date.now() - t0}ms (fulfilled=${outcome.fulfilled}, spawns=${outcome.spawns})`);
				}
			}),
		);
		return map;
	})();
	return { roots, harness, specs, outcomes };
}

/** Every matrix test takes the same shape: hold at the barrier, optionally act, settle under a guard. */
async function settleMatrix(matrix: Matrix, label: string): Promise<Map<string, SessionOutcome>> {
	await guard(matrix.harness.arrivalsDone, `${label}: arrivals`, 20_000);
	return guard(matrix.outcomes, `${label}: settle`);
}

// --- log collection (scenario 5) --------------------------------------------------

function collectLogFiles(projectDir: string): { path: string; content: string }[] {
	const files: { path: string; content: string }[] = [];
	const diagnosticsDir = diagnosticsDirFor(projectDir);
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) visit(full);
			else if (entry.name.endsWith(".log")) files.push({ path: full, content: readFileSync(full, "utf8") });
		}
	};
	if (existsSync(diagnosticsDir)) visit(diagnosticsDir);
	for (const entry of readdirSync(projectDir, { withFileTypes: true })) {
		if (entry.isDirectory() && entry.name.startsWith("agy-run-")) {
			for (const inner of readdirSync(join(projectDir, entry.name))) {
				if (inner.endsWith(".log")) {
					const full = join(projectDir, entry.name, inner);
					files.push({ path: full, content: readFileSync(full, "utf8") });
				}
			}
		}
	}
	return files;
}

// --- the matrix -------------------------------------------------------------------

describe("integration: ten-session concurrency matrix (real runTurn both adapters, fake children)", () => {
	test(
		"ten genuinely overlapping executions share one project + state dir; exclusive untruncated logs; store integrity (scenarios 1, 5, 7)",
		async () => {
			const matrix = launchMatrix();
			const outcomes = await settleMatrix(matrix, "overlap matrix");
			const h = matrix.harness;

			// --- scenario 1: genuine overlap --------------------------------------
			expect(h.arrivals).toBe(10);
			expect(h.peak).toBe(10); // all ten children in-flight simultaneously
			expect(h.closesBeforeFull).toBe(0); // zero closes before the 10th arrival
			expect(h.killedSessions).toEqual([]); // nothing was killed
			console.log(
				`[ten-conc] overlap evidence: arrivals=${h.arrivals} peak=${h.peak} closesBeforeFull=${h.closesBeforeFull} killed=${h.killedSessions.length}`,
			);
			expect(outcomes.size).toBe(10);
			for (const spec of matrix.specs) {
				const o = outcomes.get(spec.sessionId);
				expect(o?.fulfilled, `${spec.sessionId} fulfilled`).toBe(true);
				expect(o?.result?.classificationOutcome, `${spec.sessionId} outcome`).toBe("success");
				expect(o?.result?.conversationId, `${spec.sessionId} own response`).toBe(spec.conversationId);
				expect(o?.spawns, `${spec.sessionId} exactly one spawn`).toBe(1);
			}

			// --- scenario 5: exclusive, untruncated logs --------------------------
			const logs = collectLogFiles(matrix.roots.projectDir);
			// 5 opencode per-callId attempt logs + 5 pi per-turn attempt logs.
			expect(logs.length).toBe(10);
			for (const spec of matrix.specs) {
				const marker = markerOf(spec.sessionId);
				const carriers = logs.filter((f) => f.content.includes(marker));
				expect(carriers.length, `${marker} appears in exactly ONE log`).toBe(1);
				const own = carriers[0];
				// Complete at the end: own init conversation id AND own SUCCESS result survived (no cross-truncation).
				expect(own.content).toContain(spec.conversationId);
				expect(own.content).toContain("SUCCESS");
				expect(own.content).toContain(`done ${spec.sessionId}`);
				// No other session's marker leaked into this file.
				for (const other of matrix.specs) {
					if (other.sessionId === spec.sessionId) continue;
					expect(own.content.includes(markerOf(other.sessionId)), `${spec.sessionId} log free of ${other.sessionId}`).toBe(false);
				}
			}
			// opencode per-callId groups: attempt-1.log + parseable summary.json each.
			const diagnosticsDir = diagnosticsDirFor(matrix.roots.projectDir);
			const groups = readdirSync(diagnosticsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
			expect(groups.length).toBe(5);
			for (const group of groups) {
				expect(existsSync(join(diagnosticsDir, group.name, "attempt-1.log"))).toBe(true);
				const summary = JSON.parse(readFileSync(join(diagnosticsDir, group.name, "summary.json"), "utf8")) as {
					callId: string;
					recoveryDisposition: string;
					attempts: unknown[];
				};
				expect(summary.callId).toBe(group.name);
				expect(summary.recoveryDisposition).toBe("not-attempted");
				expect(summary.attempts.length).toBe(1);
			}
			// pi per-attempt logs: attempt-1.log inside each turn dir; result.logPath resolves.
			for (const spec of matrix.specs.filter((s) => s.adapter === "pi")) {
				expect(existsSync(outcomes.get(spec.sessionId)?.result?.logPath ?? "/missing"), `${spec.sessionId} logPath`).toBe(true);
			}

			// --- scenario 7: store integrity (success rules) ----------------------
			const ocStore = openOcStore(matrix.roots.ocStorePath);
			const piStore = openPiSessionStore({ stateDir: matrix.roots.stateDir });
			for (const spec of matrix.specs.filter((s) => s.adapter === "oc")) {
				expect(await ocStore.get(spec.sessionId)).toBe(spec.conversationId);
				expect(await ocStore.getEntry(spec.sessionId)).toEqual({
					conversationId: spec.conversationId,
					hashes: OC_HASHES(spec.sessionId),
				});
			}
			for (const spec of matrix.specs.filter((s) => s.adapter === "pi")) {
				expect(await piStore.getEntry(spec.sessionId)).toEqual({
					conversationId: spec.conversationId,
					hashes: messageHashes([{ role: "user", content: PI_CONTENT(spec.sessionId) }]),
				});
			}
		},
		60_000,
	);

	test(
		"cancellation isolation: aborting one session inside the barrier ends only that session (scenario 2)",
		async () => {
			const target = "oc-2";
			const killed = deferred<void>();
			// manualRelease: the abort must land while ALL TEN children are still
			// held inside the barrier (pre-output) — auto-release would let the
			// target emit its init line first and race the abort.
			const matrix = launchMatrix({ manualRelease: true });
			const spec = matrix.specs.find((s) => s.sessionId === target);
			spec!.onKilled = () => killed.resolve();

			const settledPromise = settleMatrix(matrix, "cancellation matrix").catch((err) => err);
			await guard(matrix.harness.arrivalsDone, "cancellation arrivals", 20_000);
			// Deterministic order: all 10 are held at the barrier; abort ONE and
			// wait for its child's kill handshake BEFORE releasing the barrier —
			// the other nine are untouched by the kill and succeed on release.
			spec!.controller.abort();
			await guard(killed.promise, "target kill handshake", 10_000);
			matrix.harness.releaseGate();

			const outcomes = (await settledPromise) as Map<string, SessionOutcome>;
			expect(matrix.harness.killedSessions).toEqual([target]); // ONLY the canceled child was killed
			console.log(`[ten-conc] cancellation evidence: killedSessions=${JSON.stringify(matrix.harness.killedSessions)}`);

			let abortErrors = 0;
			for (const s of matrix.specs) {
				const o = outcomes.get(s.sessionId);
				if (s.sessionId === target) {
					expect(o?.fulfilled).toBe(false);
					expect((o?.error as Error)?.name).toBe("AbortError");
					abortErrors += 1;
				} else {
					expect(o?.fulfilled, `${s.sessionId} unaffected`).toBe(true);
					expect(o?.result?.classificationOutcome).toBe("success");
					expect(o?.spawns).toBe(1);
				}
			}
			expect(abortErrors).toBe(1); // exactly one AbortError among results
			// Existing abort persistence semantics: the tapped conversation id is
			// bound when one was captured. This child was killed at the barrier,
			// BEFORE emitting its init line — no id was captured, so no binding.
			const ocStore = openOcStore(matrix.roots.ocStorePath);
			expect(await ocStore.get(target)).toBeUndefined();
			for (const s of matrix.specs.filter((x) => x.adapter === "oc" && x.sessionId !== target)) {
				expect(await ocStore.get(s.sessionId)).toBe(s.conversationId);
			}
		},
		60_000,
	);

	test(
		"a timeout does not block the set: tiny-cap session pays its own policy, the rest succeed (scenario 3)",
		async () => {
			const matrix = launchMatrix({ special: { sessionId: "oc-3", mode: "silent", timeoutMs: 120 } });
			const outcomes = await settleMatrix(matrix, "timeout matrix");

			const o = outcomes.get("oc-3");
			expect(o?.fulfilled).toBe(false);
			const err = o?.error;
			expect(err).toBeInstanceOf(OcTurnError);
			const turnError = err as OcTurnError;
			// Timeout-family terminal error after the adapter's normal attempt
			// policy: fresh conversation with a captured id → exactly ONE recovery
			// spawn, then the budget-exhausted terminal (never a third spawn).
			expect(o?.spawns).toBe(2);
			expect(turnError.mapping.retryable).toBe(false);
			expect(turnError.mapping.resume).toBe(false);
			expect(turnError.mapping.message).toContain("timed out");
			expect(turnError.mapping.message).toContain("recovery attempt already ran");
			console.log(`[ten-conc] timeout evidence: spawns=${o?.spawns} message=${turnError.mapping.message}`);
			// Existing failure persistence for a fresh conversation whose recovery
			// failed: rebind targets a conversation id that was never bound → the
			// session stays unbound (no success hash may exist).
			const ocStore = openOcStore(matrix.roots.ocStorePath);
			expect(await ocStore.get("oc-3")).toBeUndefined();
			expect(await ocStore.getEntry("oc-3")).toBeUndefined();

			for (const spec of matrix.specs.filter((s) => s.sessionId !== "oc-3")) {
				const ro = outcomes.get(spec.sessionId);
				expect(ro?.fulfilled, `${spec.sessionId} unaffected by the timeout`).toBe(true);
				expect(ro?.result?.classificationOutcome).toBe("success");
				expect(ro?.spawns).toBe(1);
			}
		},
		60_000,
	);

	test(
		"unconfirmed termination never replays: kill-ignoring child settles once, honestly, without a binding (scenario 4)",
		async () => {
			const matrix = launchMatrix({
				special: { sessionId: "pi-1", mode: "neverdie", timeoutMs: 300, terminationGraceMs: 20, terminationSettleMs: 20 },
			});
			const outcomes = await settleMatrix(matrix, "unconfirmed matrix");

			const o = outcomes.get("pi-1");
			expect(o?.fulfilled).toBe(false);
			expect(o?.error).toBeInstanceOf(PiTurnError);
			const turnError = o?.error as PiTurnError;
			// EXACTLY ONE spawn: the replay gate stays === "timeout" — an
			// unconfirmed settlement never earns a recovery attempt.
			expect(o?.spawns).toBe(1);
			expect(turnError.mapping.retryable).toBe(false);
			expect(turnError.mapping.resumeEligible).toBe(false);
			// The unconfirmed message — not the timeout family, not the fallthrough.
			expect(turnError.mapping.message).toMatch(/termination could not be confirmed/i);
			expect(turnError.mapping.message).toContain("trigger: timeout");
			expect(turnError.mapping.message).not.toMatch(/timed out and could not be resumed/);
			expect(turnError.mapping.message).not.toMatch(/empty or invalid/i);
			console.log(`[ten-conc] unconfirmed evidence: spawns=${o?.spawns} message=${turnError.mapping.message}`);
			// NO success binding persisted for the unconfirmed session.
			const piStore = openPiSessionStore({ stateDir: matrix.roots.stateDir });
			expect(await piStore.getEntry("pi-1")).toBeUndefined();

			for (const spec of matrix.specs.filter((s) => s.sessionId !== "pi-1")) {
				const ro = outcomes.get(spec.sessionId);
				expect(ro?.fulfilled, `${spec.sessionId} unaffected`).toBe(true);
				expect(ro?.result?.classificationOutcome).toBe("success");
			}
		},
		60_000,
	);

	test(
		"retention protects active runs: prune removes only old COMPLETED groups, keeps the matrix state (scenario 6)",
		async () => {
			const matrix = launchMatrix();
			const outcomes = await settleMatrix(matrix, "retention matrix");
			const diagnosticsDir = diagnosticsDirFor(matrix.roots.projectDir);

			const matrixGroups = matrix.specs
				.filter((s) => s.adapter === "oc")
				.map((s) => outcomes.get(s.sessionId)!.result!.logPath)
				.map((summaryPath) => summaryPath.slice(0, summaryPath.lastIndexOf("/")));
			expect(matrixGroups.length).toBe(5);

			// Injected OLD COMPLETED group: valid UUID name + summary.json + 8-day mtime.
			// The mtime that matters is the SUMMARY FILE's — listCompletedCallGroups
			// reads its mtime as the group clock.
			const oldCompleted = join(diagnosticsDir, randomUUID());
			mkdirSync(oldCompleted, { recursive: true });
			writeFileSync(join(oldCompleted, "summary.json"), JSON.stringify({ injected: "old-completed" }));
			const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
			utimesSync(oldCompleted, old, old);
			utimesSync(join(oldCompleted, "summary.json"), old, old);
			// Injected OLD INCOMPLETE group: UUID name + attempt log but NO summary — never a pruning candidate.
			const oldIncomplete = join(diagnosticsDir, randomUUID());
			mkdirSync(oldIncomplete, { recursive: true });
			writeFileSync(join(oldIncomplete, "attempt-1.log"), "no summary — in-flight shape");
			utimesSync(oldIncomplete, old, old);

			// The opencode diagnostics prune path, run exactly as session-mode
			// runTurn runs it: same function, same (default) retention settings.
			const pruned = pruneDiagnosticsUnder(diagnosticsDir);
			console.log(`[ten-conc] retention evidence: pruned=${pruned} oldCompletedRemoved=${!existsSync(oldCompleted)} oldIncompleteKept=${existsSync(oldIncomplete)}`);

			expect(pruned).toBe(1);
			expect(existsSync(oldCompleted)).toBe(false); // old + completed → removed
			expect(existsSync(oldIncomplete)).toBe(true); // old but NOT completed → protected
			for (const group of matrixGroups) {
				expect(existsSync(group), `matrix group survives: ${group}`).toBe(true);
			}
			// The matrix's pi turn dirs live outside the diagnostics root — untouched.
			for (const spec of matrix.specs.filter((s) => s.adapter === "pi")) {
				expect(existsSync(outcomes.get(spec.sessionId)!.result!.logPath)).toBe(true);
			}
		},
		60_000,
	);

	test(
		"same-conversation exclusion (same process): second concurrent runTurn fails busy with zero spawns (scenario 8)",
		async () => {
			const stateDir = freshRoot("agy-ten-conc-busy-state-");
			const projectDir = freshRoot("agy-ten-conc-busy-project-");
			const ocStorePath = join(stateDir, "opencode-sessions.json");
			const ocStore = openOcStore(ocStorePath);
			// Two sessions bound to the SAME conversation: both turns will resume it.
			await ocStore.bind("sess-a", "conv-shared", ["h0"]);
			await ocStore.bind("sess-b", "conv-shared", ["h0"]);

			const firstSpawned = deferred<void>();
			const releaseFirst = deferred<void>();
			const firstSpawns = { count: 0 };
			const secondSpawns = { count: 0 };
			const firstDeps: OcTurnDeps = {
				bin: "agy",
				config: ocResolveConfig({ workdirMode: "session", stateDir, timeoutMs: 30_000 }),
				store: ocStore,
				worktree: projectDir,
				spawnFn: ((_bin: string, _args: string[], _io: { cwd: string }) => {
					firstSpawns.count += 1;
					firstSpawned.resolve();
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const child: any = new EventEmitter();
					child.stdout = new Readable({ read() {} });
					child.stderr = new Readable({ read() {} });
					child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
					child.killed = false;
					child.kill = () => true;
					// Hold the conversation lock until the busy contention is proven.
					releaseFirst.promise.then(() => {
						child.stdout.push(
							Buffer.from(
								`${JSON.stringify({ event: "init", conversation_id: "conv-next" })}\n${JSON.stringify({
									event: "result",
									result: { conversation_id: "conv-next", status: "SUCCESS", response: "first done" },
								})}\n`,
							),
						);
						// Close AFTER the pushed data is delivered (see harness note).
						setImmediate(() => child.emit("close", 0, null));
					});
					return child;
				}) as never,
			};
			const secondDeps: OcTurnDeps = {
				bin: "agy",
				config: ocResolveConfig({ workdirMode: "session", stateDir, timeoutMs: 30_000 }),
				store: ocStore,
				worktree: projectDir,
				spawnFn: ((_bin: string, _args: string[], _io: { cwd: string }) => {
					secondSpawns.count += 1;
					// If the lock were a no-op this child would run; emit a full success
					// so the revert-proof fails on ASSERTIONS, not on a hang.
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const child: any = new EventEmitter();
					child.stdout = new Readable({ read() {} });
					child.stderr = new Readable({ read() {} });
					child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
					child.killed = false;
					child.kill = () => true;
					child.stdout.push(
						Buffer.from(
							`${JSON.stringify({ event: "init", conversation_id: "conv-racer" })}\n${JSON.stringify({
								event: "result",
								result: { conversation_id: "conv-racer", status: "SUCCESS", response: "racer done" },
							})}\n`,
						),
					);
					setImmediate(() => child.emit("close", 0, null));
					return child;
				}) as never,
			};

			const first = ocRunTurn(firstDeps, { prompt: "p", hashes: ["h0"], sessionId: "sess-a" });
			await guard(firstSpawned.promise, "first turn spawn", 10_000); // lock is HELD from here (acquisition precedes the attempt)
			const second = ocRunTurn(secondDeps, { prompt: "p", hashes: ["h0"], sessionId: "sess-b" });

			let secondError: unknown;
			try {
				await guard(second, "second turn busy rejection", 15_000);
			} catch (err) {
				secondError = err;
			}
			// The second call failed with the typed busy error BEFORE any spawn,
			// while the first call was still holding the lock.
			expect(secondError).toBeInstanceOf(OcTurnError);
			const busyError = secondError as OcTurnError;
			expect(busyError.mapping.retryable).toBe(false);
			expect(busyError.mapping.resume).toBe(false);
			expect(busyError.mapping.message).toContain("another agy request is active for this conversation");
			expect(secondSpawns.count).toBe(0);
			console.log(`[ten-conc] same-process busy evidence: secondSpawns=${secondSpawns.count} message=${busyError.mapping.message}`);

			// The first call completes normally once released.
			releaseFirst.resolve();
			const firstResult = await guard(first, "first turn completion", 15_000);
			expect(firstResult.classification.outcome).toBe("success");
			expect(firstSpawns.count).toBe(1);
			// Lock hygiene: the finally released the conversation lock on every
			// path. The lock dir is <stateDir>/agy-bridge/conversation-locks —
			// resolveStateDir appends the agy-bridge segment to the override.
			expect(readdirSync(join(stateDir, "agy-bridge", "conversation-locks"))).toEqual([]);
		},
		60_000,
	);

	test(
		"cross-process lock proof: two OS processes contend; busy reported; release frees the lock (scenario 9)",
		async () => {
			const root = freshRoot("agy-ten-conc-lockprobe-");
			const lockDir = join(root, "conversation-locks");
			mkdirSync(lockDir, { recursive: true });
			// Probe child: imports the engine lock by ABSOLUTE path and speaks one
			// JSON line per outcome on stdout; "release" arrives on stdin.
			const probePath = join(root, "lock-probe.ts");
			writeFileSync(
				probePath,
				`import { acquireConversationLock, ConversationBusyError } from "/home/bruno/Code/personal/agy-bridge/packages/engine/src/conversation-lock.ts";
const [cmd, dir, key, waitMs] = process.argv.slice(2);
const say = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\\n");
if (cmd === "acquire") {
  try {
    const lock = await acquireConversationLock(dir!, key!, { waitMs: Number(waitMs) });
    say({ event: "acquired" });
    let released = false;
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      if (chunk.trim() === "release" && !released) {
        released = true;
        lock.release();
        say({ event: "released" });
        process.exit(0);
      }
    });
    process.stdin.on("end", () => {
      if (!released) {
        lock.release();
        process.exit(0);
      }
    });
  } catch (err) {
    if (err instanceof ConversationBusyError) say({ event: "busy" });
    else say({ event: "error", message: String(err) });
    process.exit(1);
  }
}
`,
			);

			const transcript: string[] = [];
			const spawnProbe = (args: string[]): ChildProcess =>
				nodeSpawn(process.execPath, [probePath, "acquire", lockDir, "conv-cross", ...args], {
					stdio: ["pipe", "pipe", "pipe"],
				});

			const nextLine = (child: ChildProcess, expected: string, label: string): Promise<Record<string, unknown>> => {
				let buffer = "";
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const stdout = child.stdout as any;
				return guard(
					new Promise<Record<string, unknown>>((resolve, reject) => {
						const onData = (chunk: Buffer) => {
							buffer += chunk.toString("utf8");
							const nl = buffer.indexOf("\n");
							if (nl < 0) return;
							const line = buffer.slice(0, nl);
							stdout.removeListener("data", onData);
							const parsed = JSON.parse(line) as Record<string, unknown>;
							if (parsed.event !== expected) {
								reject(new Error(`${label}: expected "${expected}", got: ${line}`));
								return;
							}
							resolve(parsed);
						};
						stdout.on("data", onData);
						child.once("exit", (code: number | null) => {
							reject(new Error(`${label}: probe exited (code ${code}) before "${expected}"`));
						});
					}),
					label,
					15_000,
				);
			};

			const timeline: string[] = [];
			const procs: ChildProcess[] = [];
			try {
				// 1) proc1 acquires and HOLDS.
				const proc1 = spawnProbe(["5000"]);
				procs.push(proc1);
				await nextLine(proc1, "acquired", "proc1 acquire");
				const proc1HeldAt = Date.now();
				timeline.push(`proc1 acquired (holding) @${proc1HeldAt}`);
				transcript.push("proc1: {\"event\":\"acquired\"}");

				// 2) proc2 — SAME dir/key, small bounded wait — attempts only AFTER
				//    proc1 is confirmed holding, and must report busy.
				const proc2SpawnedAt = Date.now();
				const proc2 = spawnProbe(["400"]);
				procs.push(proc2);
				await nextLine(proc2, "busy", "proc2 busy");
				timeline.push(`proc2 spawned @${proc2SpawnedAt} → busy (contended with a confirmed holder)`);
				transcript.push("proc2: {\"event\":\"busy\"}");
				await guard(
					new Promise<void>((resolve) => proc2.once("exit", () => resolve())),
					"proc2 exit",
					10_000,
				);

				// Contention proof by ordering, not timing: proc1 was confirmed
				// holding STRICTLY BEFORE proc2 was even spawned.
				expect(proc1HeldAt).toBeLessThanOrEqual(proc2SpawnedAt);

				// 3) proc1 releases via the stdin handshake; the lock file is gone.
				proc1.stdin!.write("release\n");
				await nextLine(proc1, "released", "proc1 release");
				transcript.push("proc1: {\"event\":\"released\"}");
				await guard(
					new Promise<void>((resolve) => proc1.once("exit", () => resolve())),
					"proc1 exit",
					10_000,
				);
				expect(readdirSync(lockDir)).toEqual([]); // release removed the lock file

				// 4) proc3 acquires cleanly after the release.
				const proc3 = spawnProbe(["5000"]);
				procs.push(proc3);
				await nextLine(proc3, "acquired", "proc3 acquire after release");
				timeline.push("proc3 acquired after release");
				transcript.push("proc3: {\"event\":\"acquired\"}");
				proc3.stdin!.write("release\n");
				await nextLine(proc3, "released", "proc3 release");
				transcript.push("proc3: {\"event\":\"released\"}");

				console.log(`[ten-conc] multiprocess handshake:\n  ${timeline.join("\n  ")}`);
				console.log(`[ten-conc] multiprocess transcript (trimmed):\n  ${transcript.join("\n  ")}`);
			} finally {
				for (const p of procs) {
					try {
						p.kill("SIGKILL");
					} catch {
						/* already gone */
					}
				}
			}
		},
		60_000,
	);
});
