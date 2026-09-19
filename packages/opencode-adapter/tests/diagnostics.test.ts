/**
 * Unit + integration tests for bounded call/attempt diagnostics
 * (timeout-recovery PRD slice 1, spec section 3). Unit tests exercise the
 * pure diagnostics.ts building blocks directly (record shape, bounded
 * serialization/truncation, retention listing/pruning). Integration tests
 * drive the real runTurn with a fake spawnImpl (the proven turn.test.ts
 * pattern) to prove the bounded diagnostic record — not just the engine's
 * classification — carries the distinguishable failure cause (AC6), that
 * logs survive concurrent/retried calls sharing one workdir (AC9), that
 * `Full log:` stays usable and honest about write failures (AC10), and
 * that retention/allowlisting hold under injected long/sensitive/foreign
 * input (AC11).
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { runTurn, TurnError, type TurnDeps } from "../src/turn";
import { openSessionStore, type SessionStore } from "../src/session-store";
import { resolveConfig } from "../src/config";
import {
	MAX_CALL_GROUPS,
	MAX_FALLBACK_ENTRIES,
	MAX_SUMMARY_BYTES,
	NO_DIAGNOSTICS_LOG,
	attemptLogPathFor,
	boundedSummaryJson,
	buildAttemptDiagnostic,
	callGroupDirFor,
	diagnosticsDirFor,
	fallbackAttemptLogPathFor,
	fallbackDiagnosticsDir,
	generateCallId,
	listCompletedCallGroups,
	pruneCallGroups,
	pruneDiagnosticsUnder,
	pruneFallbackDiagnostics,
	pruneLooseTier3Logs,
	resolveAttemptLogPath,
	summaryPathFor,
	writeCallSummary,
	type CallDiagnosticSummary,
} from "../src/diagnostics";

const DAY_MS = 24 * 60 * 60 * 1000;
const backdate = (path: string, days: number) => {
	const old = new Date(Date.now() - days * DAY_MS);
	utimesSync(path, old, old);
};

/** Minimal ChildProcess stand-in: scripted NDJSON lines, then exit/close. */
function fakeChild(opts: { lines?: unknown[]; exit?: number | null; hold?: boolean }) {
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
	child.kill = () => {
		child.killed = true;
		queueMicrotask(() => child.emit("close", null, "SIGTERM"));
		return true;
	};
	for (const line of opts.lines ?? []) {
		child.stdout.push(Buffer.from(`${JSON.stringify(line)}\n`));
	}
	// "exit" in opts (not `?? 0`): callers explicitly pass exit: null to
	// simulate a signal-killed child with no exit code at all.
	if (!opts.hold) setTimeout(() => child.emit("close", "exit" in opts ? opts.exit : 0, null), 10);
	return child;
}

const SUCCESS = (conversationId: string) => ({
	event: "result",
	result: { conversation_id: conversationId, status: "SUCCESS", response: "done" },
});

async function setup(spawnFn: unknown, depsOverride: Partial<TurnDeps> = {}) {
	const root = await mkdtemp("/tmp/agy-diag-");
	const store: SessionStore = openSessionStore(join(root, "sessions.json"));
	const deps: TurnDeps = {
		bin: "agy",
		config: resolveConfig({ scratchRoot: root, timeoutMs: 30_000 }),
		store,
		spawnFn: spawnFn as never,
		...depsOverride,
	};
	return { root, store, deps };
}

const baseAttempt = {
	attemptIndex: 1,
	logPath: "/w/.agy-diagnostics/call-1/attempt-1.log",
	mode: "initial" as const,
	resumed: false,
	timeoutMsEffective: 30_000,
	stallMsEffective: 600_000,
	wallElapsedMs: 123,
	aborted: false,
	classificationOutcome: "success",
	classificationReason: "ok",
};

describe("unit: diagnostics — record building (allowlist, PRD section 3)", () => {
	test("generateCallId: distinct, non-sequential, UUID-shaped identities — never a timestamp", () => {
		const a = generateCallId();
		const b = generateCallId();
		expect(a).not.toBe(b);
		expect(a).toMatch(/^[0-9a-f-]{36}$/i);
	});

	test("path builders nest attempt logs and the summary under one exclusive call group dir", () => {
		const workdir = "/w";
		const callId = "call-1";
		expect(callGroupDirFor(workdir, callId)).toBe(join(workdir, ".agy-diagnostics", callId));
		expect(attemptLogPathFor(workdir, callId, 1)).toBe(join(workdir, ".agy-diagnostics", callId, "attempt-1.log"));
		expect(attemptLogPathFor(workdir, callId, 2)).toBe(join(workdir, ".agy-diagnostics", callId, "attempt-2.log"));
		expect(summaryPathFor(workdir, callId)).toBe(join(workdir, ".agy-diagnostics", callId, "summary.json"));
	});

	test("idAvailable reflects capture WITHOUT ever leaking the raw conversationId into the record", () => {
		const withId = buildAttemptDiagnostic({ ...baseAttempt, conversationId: "super-secret-conv-id", exitCode: 0, timedOut: false, stalled: false });
		expect(withId.idAvailable).toBe(true);
		expect(JSON.stringify(withId)).not.toContain("super-secret-conv-id");
		const withoutId = buildAttemptDiagnostic({ ...baseAttempt, conversationId: undefined, exitCode: 0, timedOut: false, stalled: false });
		expect(withoutId.idAvailable).toBe(false);
	});

	test("signal is derived purely from already-known watchdog flags (AC6 evidence: distinguishable causes)", () => {
		const capExpiry = buildAttemptDiagnostic({ ...baseAttempt, conversationId: undefined, exitCode: null, timedOut: true, stalled: false });
		expect(capExpiry.signal).toBe("SIGTERM");
		const silenceExpiry = buildAttemptDiagnostic({ ...baseAttempt, conversationId: undefined, exitCode: null, timedOut: false, stalled: true });
		expect(silenceExpiry.signal).toBe("SIGTERM");
		const cleanExit = buildAttemptDiagnostic({ ...baseAttempt, conversationId: undefined, exitCode: 0, timedOut: false, stalled: false });
		expect(cleanExit.signal).toBe("none");
		const unexplainedNullExit = buildAttemptDiagnostic({ ...baseAttempt, conversationId: undefined, exitCode: null, timedOut: false, stalled: false });
		expect(unexplainedNullExit.signal).toBe("unknown");
	});

	test("escalation honesty: a run the chain escalated to SIGKILL reports SIGKILL, never a plain SIGTERM", () => {
		const escalated = buildAttemptDiagnostic({
			...baseAttempt,
			conversationId: undefined,
			exitCode: null,
			timedOut: true,
			stalled: false,
			escalatedSignal: "SIGKILL",
		});
		expect(escalated.signal).toBe("SIGKILL");
		// Also when the trigger was a stall or an abort (no timedOut flag).
		const escalatedUnconfirmed = buildAttemptDiagnostic({
			...baseAttempt,
			conversationId: undefined,
			exitCode: null,
			timedOut: false,
			stalled: false,
			escalatedSignal: "SIGKILL",
		});
		expect(escalatedUnconfirmed.signal).toBe("SIGKILL");
		// Without escalation the watchdog report is unchanged.
		const plain = buildAttemptDiagnostic({ ...baseAttempt, conversationId: undefined, exitCode: null, timedOut: true, stalled: false });
		expect(plain.signal).toBe("SIGTERM");
	});
});

describe("unit: diagnostics — bounded serialization (AC11: truncation, no unbounded growth)", () => {
	const summaryOf = (attempts: CallDiagnosticSummary["attempts"]): CallDiagnosticSummary => ({
		version: 1,
		callId: "call-1",
		bridgeVersion: "unknown",
		recoveryDisposition: "not-attempted",
		attempts,
		createdAt: new Date(0).toISOString(),
		completedAt: new Date(0).toISOString(),
	});

	test("a normal-size record fits within the bound untruncated", () => {
		const { json, truncated } = boundedSummaryJson(summaryOf([buildAttemptDiagnostic({ ...baseAttempt, conversationId: "c", exitCode: 0, timedOut: false, stalled: false })]));
		expect(truncated).toBe(false);
		expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
		expect(JSON.parse(json).attempts).toHaveLength(1);
	});

	test("an oversized record (many long attempt entries) is truncated deterministically, stays valid JSON, and marks truncation explicitly", () => {
		const longPath = `/w/.agy-diagnostics/call-1/${"x".repeat(400)}.log`;
		const many = Array.from({ length: 60 }, (_, i) =>
			buildAttemptDiagnostic({ ...baseAttempt, attemptIndex: i + 1, logPath: longPath, conversationId: "c", exitCode: 0, timedOut: false, stalled: false }),
		);
		const { json, truncated } = boundedSummaryJson(summaryOf(many));
		expect(truncated).toBe(true);
		expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(MAX_SUMMARY_BYTES);
		const parsed = JSON.parse(json) as CallDiagnosticSummary; // must stay valid JSON even truncated.
		expect(parsed.truncated).toBe(true);
		expect(parsed.truncationNote).toMatch(/\[truncated\]$/);
		expect(parsed.attempts.length).toBeLessThan(many.length);
	});
});

describe("unit: diagnostics — retention listing and pruning (AC11: bounded age/count, protected active/foreign)", () => {
	test("listCompletedCallGroups: only real, non-symlinked, UUID-named directories WITH a summary.json count as completed", async () => {
		const root = await mkdtemp("/tmp/agy-diag-list-");
		const done = join(root, generateCallId());
		mkdirSync(done);
		writeFileSync(join(done, "summary.json"), "{}");
		const active = join(root, generateCallId());
		mkdirSync(active); // no summary.json yet — in-progress, never a candidate.
		// The symlink target lives OUTSIDE root: only the symlink itself
		// (never followed) sits inside the directory under test, even
		// though its own name is UUID-shaped.
		const target = await mkdtemp("/tmp/agy-diag-list-target-");
		writeFileSync(join(target, "summary.json"), "{}");
		symlinkSync(target, join(root, generateCallId()), "dir"); // never followed.
		// A non-UUID name is never bridge-owned, even with a summary.json —
		// the weak "has a summary.json" check alone is not ownership proof.
		const foreign = join(root, "not-a-uuid-dir");
		mkdirSync(foreign);
		writeFileSync(join(foreign, "summary.json"), "{}");

		const groups = listCompletedCallGroups(root);
		expect(groups.map((g) => g.dir).sort()).toEqual([done].sort());
	});

	test("listCompletedCallGroups: a missing/unreadable root never throws — yields an empty list", () => {
		expect(listCompletedCallGroups("/definitely/not/a/real/agy/diagnostics/dir")).toEqual([]);
	});

	test("pruneCallGroups: age-expired groups are removed together with their attempt logs; younger survivors untouched", async () => {
		const root = await mkdtemp("/tmp/agy-diag-age-");
		const old = join(root, generateCallId());
		mkdirSync(old);
		writeFileSync(join(old, "summary.json"), "{}");
		writeFileSync(join(old, "attempt-1.log"), "evidence");
		backdate(join(old, "summary.json"), 8);
		const fresh = join(root, generateCallId());
		mkdirSync(fresh);
		writeFileSync(join(fresh, "summary.json"), "{}");

		const groups = listCompletedCallGroups(root);
		const pruned = pruneCallGroups(groups, { now: new Date(), maxAgeMs: 7 * DAY_MS, maxGroups: 200 });
		expect(pruned).toBe(1);
		expect(existsSync(old)).toBe(false); // summary + its attempt log removed together, no orphans.
		expect(existsSync(fresh)).toBe(true);
	});

	test("pruneCallGroups: count cap prunes the OLDEST excess first, keeping the newest maxGroups", async () => {
		const root = await mkdtemp("/tmp/agy-diag-count-");
		const dirs: string[] = [];
		const base = Date.now();
		for (let i = 0; i < 5; i++) {
			const dir = join(root, generateCallId());
			mkdirSync(dir);
			writeFileSync(join(dir, "summary.json"), "{}");
			// Distinct, increasing (but all recent) mtimes so ordering is
			// deterministic without tripping the age-based filter.
			const mtime = new Date(base - (5 - i) * 1000);
			utimesSync(join(dir, "summary.json"), mtime, mtime);
			dirs.push(dir);
		}
		const groups = listCompletedCallGroups(root);
		const pruned = pruneCallGroups(groups, { now: new Date(), maxAgeMs: 365 * DAY_MS, maxGroups: 3 });
		expect(pruned).toBe(2);
		expect(existsSync(dirs[0])).toBe(false);
		expect(existsSync(dirs[1])).toBe(false);
		expect(existsSync(dirs[2])).toBe(true);
		expect(existsSync(dirs[3])).toBe(true);
		expect(existsSync(dirs[4])).toBe(true);
	});

	test("pruneDiagnosticsUnder never touches an active (summary-less) group regardless of age", async () => {
		const root = await mkdtemp("/tmp/agy-diag-active-");
		const diagDir = join(root, ".agy-diagnostics");
		mkdirSync(diagDir);
		const active = join(diagDir, "in-flight-call");
		mkdirSync(active);
		writeFileSync(join(active, "attempt-1.log"), "still running");
		backdate(active, 30); // even ancient, no summary.json means never a candidate.

		const pruned = pruneDiagnosticsUnder(diagDir, { now: new Date(), maxAgeMs: 7 * DAY_MS, maxGroups: 200 });
		expect(pruned).toBe(0);
		expect(existsSync(active)).toBe(true);
	});

	test("pruneDiagnosticsUnder is a safe no-op on a missing directory", () => {
		expect(pruneDiagnosticsUnder("/definitely/missing/.agy-diagnostics")).toBe(0);
	});

	test("pruneDiagnosticsUnder never follows .agy-diagnostics ITSELF when it is a symlink (mirrors the child-symlink guard above)", async () => {
		const root = await mkdtemp("/tmp/agy-diag-rootlink-");
		const target = await mkdtemp("/tmp/agy-diag-rootlink-target-");
		// The victim lives OUTSIDE root, has a UUID-shaped name AND a real
		// summary.json — it would pass every other ownership check. Only
		// the "never follow the diagnostics root symlink" guard protects it.
		const victimId = generateCallId();
		const victim = join(target, victimId);
		mkdirSync(victim);
		writeFileSync(join(victim, "summary.json"), "{}");
		backdate(join(victim, "summary.json"), 30); // ancient — would otherwise be a prime age-prune candidate.
		const diagLink = join(root, ".agy-diagnostics");
		symlinkSync(target, diagLink, "dir"); // .agy-diagnostics ITSELF is a symlink, not a real directory.

		const pruned = pruneDiagnosticsUnder(diagLink, { now: new Date(), maxAgeMs: 7 * DAY_MS, maxGroups: 200 });
		expect(pruned).toBe(0);
		expect(existsSync(victim)).toBe(true); // nothing outside was ever touched.
		expect(existsSync(join(victim, "summary.json"))).toBe(true);
	});

	test("MAX_CALL_GROUPS matches the PRD's decided 200-group retention limit", () => {
		expect(MAX_CALL_GROUPS).toBe(200);
	});
});

describe("unit: diagnostics — filesystem permissions (Fix 2: owner-restricted diagnostics)", () => {
	test("call group directories and the written summary are created with owner-only modes (0o700/0o600), independent of the ambient umask", async () => {
		const root = await mkdtemp("/tmp/agy-diag-perms-");
		// A permissive umask that WOULD widen the modes if they were left to
		// the default flag/umask behavior instead of an explicit mode arg.
		const originalUmask = process.umask(0o022);
		try {
			const callId = generateCallId();
			const summaryPath = writeCallSummary(root, callId, {
				version: 1,
				callId,
				bridgeVersion: "unknown",
				recoveryDisposition: "not-attempted",
				attempts: [],
				createdAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
			});
			expect(statSync(callGroupDirFor(root, callId)).mode & 0o777).toBe(0o700);
			expect(statSync(summaryPath).mode & 0o777).toBe(0o600);
		} finally {
			process.umask(originalUmask);
		}
	});

	test("resolveAttemptLogPath's call group directory is also created with mode 0o700, independent of the ambient umask", async () => {
		const root = await mkdtemp("/tmp/agy-diag-perms-attempt-");
		const originalUmask = process.umask(0o022);
		try {
			const callId = generateCallId();
			resolveAttemptLogPath(root, callId, 1);
			expect(statSync(callGroupDirFor(root, callId)).mode & 0o777).toBe(0o700);
		} finally {
			process.umask(originalUmask);
		}
	});
});

describe("unit: diagnostics — fallback attempt-log retention (Fix 5: tmp fallback escapes retention)", () => {
	test("resolveAttemptLogPath degrades to the dedicated, pruneable fallback subdirectory — never a bare loose tmpdir file — when the call group dir cannot be created", async () => {
		const root = await mkdtemp("/tmp/agy-diag-fallback-resolve-");
		// Block .agy-diagnostics with a REGULAR FILE so mkdirSync(callGroupDirFor)
		// can never succeed for this call (ENOTDIR), regardless of callId.
		writeFileSync(diagnosticsDirFor(root), "not a directory");
		const callId = generateCallId();
		const path = resolveAttemptLogPath(root, callId, 1);
		expect(path).toBe(fallbackAttemptLogPathFor(callId, 1));
		expect(path.includes("agy-bridge-diagnostics-fallback")).toBe(true);
		expect(existsSync(fallbackDiagnosticsDir())).toBe(true);
	});

	test("pruneFallbackDiagnostics: an old fallback log is pruned; a recent one survives", () => {
		const dir = fallbackDiagnosticsDir();
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const oldPath = join(dir, `${generateCallId()}-1.log`);
		const freshPath = join(dir, `${generateCallId()}-1.log`);
		writeFileSync(oldPath, "stale evidence");
		writeFileSync(freshPath, "recent evidence");
		backdate(oldPath, 8);
		try {
			const pruned = pruneFallbackDiagnostics(dir, { now: new Date(), maxAgeMs: 7 * DAY_MS });
			expect(pruned).toBe(1);
			expect(existsSync(oldPath)).toBe(false);
			expect(existsSync(freshPath)).toBe(true);
		} finally {
			// Keep the shared, non-mkdtemp fallback dir clean across test runs.
			rmSync(oldPath, { force: true });
			rmSync(freshPath, { force: true });
		}
	});

	test("pruneFallbackDiagnostics: a count bound prunes the OLDEST excess first, even when nothing is age-expired", async () => {
		const root = await mkdtemp("/tmp/agy-diag-fallback-count-");
		const base = Date.now();
		const paths: string[] = [];
		for (let i = 0; i < 5; i++) {
			const p = join(root, `${generateCallId()}-1.log`);
			writeFileSync(p, "evidence");
			const mtime = new Date(base - (5 - i) * 1000);
			utimesSync(p, mtime, mtime);
			paths.push(p);
		}
		const pruned = pruneFallbackDiagnostics(root, { now: new Date(), maxAgeMs: 365 * DAY_MS, maxEntries: 3 });
		expect(pruned).toBe(2);
		expect(existsSync(paths[0])).toBe(false);
		expect(existsSync(paths[1])).toBe(false);
		expect(existsSync(paths[2])).toBe(true);
		expect(existsSync(paths[3])).toBe(true);
		expect(existsSync(paths[4])).toBe(true);
	});

	test("MAX_FALLBACK_ENTRIES is a real, positive finite bound (PRD section 3: no unbounded exception)", () => {
		expect(MAX_FALLBACK_ENTRIES).toBeGreaterThan(0);
		expect(Number.isFinite(MAX_FALLBACK_ENTRIES)).toBe(true);
	});

	test("Fix 1 (audit H1): pruneFallbackDiagnostics never follows a symlinked root — the real exported function, against a sandboxed root", async () => {
		const target = await mkdtemp("/tmp/agy-diag-fallback-symlink-target-");
		const decoy = join(target, "old-decoy.log");
		writeFileSync(decoy, "pre-existing evidence living OUTSIDE the intended fallback root");
		backdate(decoy, 30); // ancient — would be a prime prune candidate if the guard were missing.
		const parent = await mkdtemp("/tmp/agy-diag-fallback-symlink-parent-");
		const fakeRoot = join(parent, "agy-bridge-diagnostics-fallback");
		symlinkSync(target, fakeRoot, "dir"); // the root ITSELF is a symlink, never a real directory.

		const pruned = pruneFallbackDiagnostics(fakeRoot, { now: new Date(), maxAgeMs: 7 * DAY_MS });
		expect(pruned).toBe(0);
		expect(existsSync(decoy)).toBe(true); // never touched — the guard rejected the root before any readdir.
	});

	test("Fix 1: a genuine (non-symlinked) fallback root still prunes normally — the guard is not overbroad", async () => {
		const root = await mkdtemp("/tmp/agy-diag-fallback-realdir-");
		const oldPath = join(root, `${generateCallId()}-1.log`);
		writeFileSync(oldPath, "stale evidence");
		backdate(oldPath, 8);
		const pruned = pruneFallbackDiagnostics(root, { now: new Date(), maxAgeMs: 7 * DAY_MS });
		expect(pruned).toBe(1);
		expect(existsSync(oldPath)).toBe(false);
	});

	test("pruneFallbackDiagnostics is a safe no-op on a missing root (never throws)", () => {
		expect(pruneFallbackDiagnostics("/definitely/missing/agy-bridge-diagnostics-fallback")).toBe(0);
	});
});

describe("unit: diagnostics — tier-3 loose tmpdir sweep (Fix 3: no unpruneable exception)", () => {
	test("pruneLooseTier3Logs: prunes ONLY files matching the exact agy-attempt-<uuid>-<n>.log pattern this call site writes", async () => {
		const root = await mkdtemp("/tmp/agy-diag-tier3-");
		const owned = join(root, `agy-attempt-${generateCallId()}-1.log`);
		const unrelated = join(root, "some-other-process.log");
		const nearMiss = join(root, "agy-attempt-not-a-uuid-1.log");
		writeFileSync(owned, "evidence");
		writeFileSync(unrelated, "unrelated tmpdir content — never bridge-owned");
		writeFileSync(nearMiss, "wrong shape — never bridge-owned");
		backdate(owned, 8);
		backdate(unrelated, 8);
		backdate(nearMiss, 8);

		const pruned = pruneLooseTier3Logs(root, { now: new Date(), maxAgeMs: 7 * DAY_MS });
		expect(pruned).toBe(1);
		expect(existsSync(owned)).toBe(false);
		expect(existsSync(unrelated)).toBe(true); // pattern-scoped: a blanket tmpdir sweep would have deleted this too.
		expect(existsSync(nearMiss)).toBe(true);
	});

	test("pruneLooseTier3Logs: count bound prunes the OLDEST matching excess first", async () => {
		const root = await mkdtemp("/tmp/agy-diag-tier3-count-");
		const base = Date.now();
		const paths: string[] = [];
		for (let i = 0; i < 4; i++) {
			const p = join(root, `agy-attempt-${generateCallId()}-1.log`);
			writeFileSync(p, "evidence");
			const mtime = new Date(base - (4 - i) * 1000);
			utimesSync(p, mtime, mtime);
			paths.push(p);
		}
		const pruned = pruneLooseTier3Logs(root, { now: new Date(), maxAgeMs: 365 * DAY_MS, maxEntries: 2 });
		expect(pruned).toBe(2);
		expect(existsSync(paths[0])).toBe(false);
		expect(existsSync(paths[1])).toBe(false);
		expect(existsSync(paths[2])).toBe(true);
		expect(existsSync(paths[3])).toBe(true);
	});

	test("pruneLooseTier3Logs never follows a symlinked root (mirrors pruneFallbackDiagnostics's guard)", async () => {
		const target = await mkdtemp("/tmp/agy-diag-tier3-symlink-target-");
		const decoy = join(target, `agy-attempt-${generateCallId()}-1.log`);
		writeFileSync(decoy, "pre-existing evidence");
		backdate(decoy, 30);
		const parent = await mkdtemp("/tmp/agy-diag-tier3-symlink-parent-");
		const fakeRoot = join(parent, "tmp-stand-in");
		symlinkSync(target, fakeRoot, "dir");

		const pruned = pruneLooseTier3Logs(fakeRoot, { now: new Date(), maxAgeMs: 7 * DAY_MS });
		expect(pruned).toBe(0);
		expect(existsSync(decoy)).toBe(true);
	});
});

describe("unit: diagnostics — writeCallSummary (AC10: readable, honest about failure)", () => {
	test("writes a parseable, exclusive summary naming the call id and returns its absolute path", async () => {
		const root = await mkdtemp("/tmp/agy-diag-write-");
		const callId = generateCallId();
		const summary: CallDiagnosticSummary = {
			version: 1,
			callId,
			bridgeVersion: "unknown",
			recoveryDisposition: "not-attempted",
			attempts: [],
			createdAt: new Date().toISOString(),
			completedAt: new Date().toISOString(),
		};
		const path = writeCallSummary(root, callId, summary);
		expect(path).toBe(summaryPathFor(root, callId));
		const parsed = JSON.parse(readFileSync(path, "utf8")) as CallDiagnosticSummary;
		expect(parsed.callId).toBe(callId);
	});

	test("throws (never fabricates a path) when the diagnostics directory cannot be created", async () => {
		const root = await mkdtemp("/tmp/agy-diag-fail-");
		// Block the .agy-diagnostics path with a REGULAR FILE: mkdirSync
		// under it can never succeed (ENOTDIR), regardless of callId.
		writeFileSync(diagnosticsDirFor(root), "not a directory");
		const callId = generateCallId();
		expect(() =>
			writeCallSummary(root, callId, {
				version: 1,
				callId,
				bridgeVersion: "unknown",
				recoveryDisposition: "not-attempted",
				attempts: [],
				createdAt: new Date().toISOString(),
				completedAt: new Date().toISOString(),
			}),
		).toThrow();
	});
});

describe("integration: diagnostics via runTurn (AC6 — distinguishable causes reach the record)", () => {
	// Each scenario deliberately omits an "init" event (no captured id) so
	// canResume is false and the call makes exactly ONE attempt — isolating
	// one classification per summary for a clean assertion.
	const readSummary = (worktree: string): CallDiagnosticSummary => {
		const groupDirs = readdirSync(join(worktree, ".agy-diagnostics"));
		expect(groupDirs).toHaveLength(1);
		return JSON.parse(readFileSync(join(worktree, ".agy-diagnostics", groupDirs[0], "summary.json"), "utf8"));
	};

	test("cap expiry (timedOut, no exit) → timeout/timeout, signal SIGTERM", async () => {
		const worktree = await mkdtemp("/tmp/agy-diag-ac6-cap-");
		const { deps } = await setup(() => fakeChild({ lines: [], hold: true }));
		deps.config = resolveConfig({ workdirMode: "session", timeoutMs: 50 });
		let caught: TurnError | undefined;
		try {
			await runTurn({ ...deps, worktree }, { prompt: "p", hashes: ["h"], sessionId: "s" });
		} catch (err) {
			caught = err as TurnError;
		}
		expect(caught).toBeInstanceOf(TurnError);
		const summary = readSummary(worktree);
		expect(summary.attempts[0].classificationOutcome).toBe("timeout");
		expect(summary.attempts[0].classificationReason).toBe("timeout");
		expect(summary.attempts[0].timedOut).toBe(true);
		expect(summary.attempts[0].signal).toBe("SIGTERM");
		expect(summary.attempts[0].idAvailable).toBe(false);
	});

	test("exit 124 (print-timeout convention, no watchdog flags) → timeout/timeout", async () => {
		const worktree = await mkdtemp("/tmp/agy-diag-ac6-124-");
		const { deps } = await setup(() => fakeChild({ lines: [], exit: 124 }));
		deps.config = resolveConfig({ workdirMode: "session", timeoutMs: 30_000 });
		let caught: TurnError | undefined;
		try {
			await runTurn({ ...deps, worktree }, { prompt: "p", hashes: ["h"], sessionId: "s" });
		} catch (err) {
			caught = err as TurnError;
		}
		expect(caught).toBeInstanceOf(TurnError);
		const summary = readSummary(worktree);
		expect(summary.attempts[0].classificationOutcome).toBe("timeout");
		expect(summary.attempts[0].classificationReason).toBe("timeout");
		expect(summary.attempts[0].exitCode).toBe(124);
		expect(summary.attempts[0].timedOut).toBe(false);
	});

	test("recognized CLI timeout signature in agy's own log → timeout/agy_print_wait_timeout, distinguishable from exit 124", async () => {
		const worktree = await mkdtemp("/tmp/agy-diag-ac6-printwait-");
		const { deps } = await setup(() => {
			const child = fakeChild({ lines: [], exit: 1 });
			setTimeout(() => child.stderr.push(Buffer.from("[agy] print timeout after 60s with turn in progress\n")), 1);
			return child;
		});
		deps.config = resolveConfig({ workdirMode: "session", timeoutMs: 30_000 });
		let caught: TurnError | undefined;
		try {
			await runTurn({ ...deps, worktree }, { prompt: "p", hashes: ["h"], sessionId: "s" });
		} catch (err) {
			caught = err as TurnError;
		}
		expect(caught).toBeInstanceOf(TurnError);
		const summary = readSummary(worktree);
		expect(summary.attempts[0].classificationOutcome).toBe("timeout");
		expect(summary.attempts[0].classificationReason).toBe("agy_print_wait_timeout");
	});

	test("signal exit (null exit code, no watchdog flags) → task_failure, never promoted to timeout", async () => {
		const worktree = await mkdtemp("/tmp/agy-diag-ac6-signal-");
		const { deps } = await setup(() => fakeChild({ lines: [], exit: null }));
		deps.config = resolveConfig({ workdirMode: "session", timeoutMs: 30_000 });
		let caught: TurnError | undefined;
		try {
			await runTurn({ ...deps, worktree }, { prompt: "p", hashes: ["h"], sessionId: "s" });
		} catch (err) {
			caught = err as TurnError;
		}
		expect(caught).toBeInstanceOf(TurnError);
		const summary = readSummary(worktree);
		expect(summary.attempts[0].classificationOutcome).toBe("task_failure");
		expect(summary.attempts[0].classificationReason).toBe("nonzero_exit");
		expect(summary.attempts[0].exitCode).toBeNull();
		expect(summary.attempts[0].signal).toBe("unknown");
	});

	test('plain "interrupted" text alone → task_failure, never promoted to timeout (PRD line ~24)', async () => {
		const worktree = await mkdtemp("/tmp/agy-diag-ac6-interrupted-");
		const { deps } = await setup(() => {
			const child = fakeChild({ lines: [], exit: 1 });
			setTimeout(() => child.stderr.push(Buffer.from("error: interrupted\n")), 1);
			return child;
		});
		deps.config = resolveConfig({ workdirMode: "session", timeoutMs: 30_000 });
		let caught: TurnError | undefined;
		try {
			await runTurn({ ...deps, worktree }, { prompt: "p", hashes: ["h"], sessionId: "s" });
		} catch (err) {
			caught = err as TurnError;
		}
		expect(caught).toBeInstanceOf(TurnError);
		const summary = readSummary(worktree);
		expect(summary.attempts[0].classificationOutcome).toBe("task_failure");
		expect(summary.attempts[0].classificationReason).toBe("nonzero_exit");
	});
});

describe("integration: diagnostics via runTurn (AC9 — logs survive recovery/retries and concurrent calls)", () => {
	test("scratch mode: two attempts of one call (timeout then resume-success) get exclusive attempt logs; the first attempt's evidence survives", async () => {
		const spawns: unknown[][] = [];
		const { root, deps } = await setup((_bin: string, args: string[]) => {
			spawns.push(args);
			return spawns.length === 1
				? fakeChild({ lines: [{ event: "init", conversation_id: "conv-1" }], exit: 124 })
				: fakeChild({ lines: [{ event: "init", conversation_id: "conv-2" }, SUCCESS("conv-2")], exit: 0 });
		});
		const result = await runTurn(deps, { prompt: "p", hashes: ["h"], sessionId: "sess-ac9-scratch" });
		expect(result.classification.outcome).toBe("success");
		expect(result.resumed).toBe(true);
		expect(spawns).toHaveLength(2);
		// Locate the one call group this test's scratch dir produced.
		const scratchDir = readdirSync(root).find((d) => d.startsWith("agy-run-"));
		expect(scratchDir).toBeDefined();
		const groupParent = join(root, scratchDir!, ".agy-diagnostics");
		const groups = readdirSync(groupParent);
		expect(groups).toHaveLength(1); // one call → one group, regardless of attempt count.
		const groupDir = join(groupParent, groups[0]);
		const attempt1 = join(groupDir, "attempt-1.log");
		const attempt2 = join(groupDir, "attempt-2.log");
		expect(attempt1).not.toBe(attempt2);
		expect(existsSync(attempt1)).toBe(true);
		expect(existsSync(attempt2)).toBe(true);
		// The first attempt's evidence (its init event) was never truncated
		// by the second attempt's write — the historical bug this PRD closes.
		expect(readFileSync(attempt1, "utf8")).toContain("conv-1");
		expect(readFileSync(attempt2, "utf8")).toContain("conv-2");
		const summary = JSON.parse(readFileSync(join(groupDir, "summary.json"), "utf8")) as CallDiagnosticSummary;
		expect(summary.attempts).toHaveLength(2);
		expect(summary.attempts.map((a) => a.logPath)).toEqual([attempt1, attempt2]);
		// Fix 3: the diagnostic record must honestly label WHICH attempt was
		// the canResume-triggered recovery attempt, and the call-level
		// disposition must reflect that its outcome was success.
		expect(summary.attempts[0].mode).toBe("initial");
		expect(summary.attempts[1].mode).toBe("recovery");
		expect(summary.recoveryDisposition).toBe("attempted-success");
	});

	test("session mode: two DIFFERENT calls interleaved on one shared workdir get exclusive call groups and stable summaries", async () => {
		const worktree = await mkdtemp("/tmp/agy-diag-ac9-session-");
		let spawnCount = 0;
		const { deps } = await setup((_bin: string, _args: string[]) => {
			spawnCount++;
			const id = `conv-${spawnCount}`;
			return fakeChild({ lines: [{ event: "init", conversation_id: id }, SUCCESS(id)], exit: 0 });
		});
		deps.config = resolveConfig({ workdirMode: "session", timeoutMs: 30_000 });
		const [r1, r2] = await Promise.all([
			runTurn({ ...deps, worktree }, { prompt: "p1", hashes: ["h1"], sessionId: "sess-a" }),
			runTurn({ ...deps, worktree }, { prompt: "p2", hashes: ["h2"], sessionId: "sess-b" }),
		]);
		expect(r1.classification.outcome).toBe("success");
		expect(r2.classification.outcome).toBe("success");
		expect(r1.logPath).not.toBe(r2.logPath); // exclusive call groups, never a shared alias.
		const groups = readdirSync(join(worktree, ".agy-diagnostics"));
		expect(groups).toHaveLength(2);
		const s1 = JSON.parse(readFileSync(r1.logPath, "utf8")) as CallDiagnosticSummary;
		const s2 = JSON.parse(readFileSync(r2.logPath, "utf8")) as CallDiagnosticSummary;
		expect(s1.callId).not.toBe(s2.callId);
		expect(s1.attempts).toHaveLength(1);
		expect(s2.attempts).toHaveLength(1);
	});
});

describe("integration: diagnostics via runTurn (Fix 3 — recovery attempt mode/disposition honesty)", () => {
	test("a recovery attempt that ALSO fails is labeled mode 'recovery' and recoveryDisposition 'attempted-failure' — never silently 'not-attempted'", async () => {
		const worktree = await mkdtemp("/tmp/agy-diag-recovery-fail-");
		const spawns: unknown[][] = [];
		const { deps } = await setup((_bin: string, args: string[]) => {
			spawns.push(args);
			return spawns.length === 1
				? fakeChild({ lines: [{ event: "init", conversation_id: "conv-1" }], exit: 124 })
				: fakeChild({ lines: [{ event: "init", conversation_id: "conv-2" }], exit: 124 });
		});
		deps.config = resolveConfig({ workdirMode: "session", timeoutMs: 30_000 });
		let caught: TurnError | undefined;
		try {
			await runTurn({ ...deps, worktree }, { prompt: "p", hashes: ["h"], sessionId: "s" });
		} catch (err) {
			caught = err as TurnError;
		}
		expect(caught).toBeInstanceOf(TurnError);
		expect(spawns).toHaveLength(2); // canResume fired: the pre-existing resume-once mechanic ran.
		const groupDirs = readdirSync(join(worktree, ".agy-diagnostics"));
		expect(groupDirs).toHaveLength(1); // one call → one group, regardless of attempt count.
		const summary = JSON.parse(
			readFileSync(join(worktree, ".agy-diagnostics", groupDirs[0], "summary.json"), "utf8"),
		) as CallDiagnosticSummary;
		expect(summary.attempts).toHaveLength(2);
		expect(summary.attempts[0].mode).toBe("initial");
		expect(summary.attempts[1].mode).toBe("recovery");
		expect(summary.recoveryDisposition).toBe("attempted-failure");
	});
});

describe("integration: diagnostics via runTurn (AC10 — Full log: stays usable and honest)", () => {
	test("Full log: names a readable summary whose attempt references are all real, existing files", async () => {
		const worktree = await mkdtemp("/tmp/agy-diag-ac10-usable-");
		const { deps } = await setup(() => fakeChild({ lines: [], exit: 1 }));
		deps.config = resolveConfig({ workdirMode: "session", timeoutMs: 30_000 });
		let caught: TurnError | undefined;
		try {
			await runTurn({ ...deps, worktree }, { prompt: "p", hashes: ["h"], sessionId: "s" });
		} catch (err) {
			caught = err as TurnError;
		}
		expect(caught).toBeInstanceOf(TurnError);
		const match = caught?.mapping.message.match(/Full log: (.+)$/);
		expect(match).not.toBeNull();
		const summaryPath = match![1];
		expect(existsSync(summaryPath)).toBe(true);
		const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as CallDiagnosticSummary;
		for (const a of summary.attempts) {
			expect(existsSync(a.logPath)).toBe(true);
			expect(statSync(a.logPath).isFile()).toBe(true);
		}
	});

	test("a diagnostics write failure never masks the turn's real cause and never fabricates a log path", async () => {
		const worktree = await mkdtemp("/tmp/agy-diag-ac10-failure-");
		// Block .agy-diagnostics with a regular file so writeCallSummary's
		// mkdirSync(recursive) can never succeed for this call, regardless
		// of the randomly generated callId.
		writeFileSync(diagnosticsDirFor(worktree), "not a directory");
		const { deps } = await setup(() => fakeChild({ lines: [], exit: 124 })); // exit 124: a real, distinct cause.
		deps.config = resolveConfig({ workdirMode: "session", timeoutMs: 30_000 });
		let caught: TurnError | undefined;
		try {
			await runTurn({ ...deps, worktree }, { prompt: "p", hashes: ["h"], sessionId: "s" });
		} catch (err) {
			caught = err as TurnError;
		}
		expect(caught).toBeInstanceOf(TurnError);
		// The original cause is preserved even though diagnostics failed.
		expect(caught?.mapping.message).toContain("agy timed out and could not be resumed");
		// Unavailability is reported honestly — no fabricated path.
		expect(caught?.mapping.message).toContain(NO_DIAGNOSTICS_LOG);
		expect(caught?.mapping.message).not.toMatch(/\.agy-diagnostics\/[^/]+\/summary\.json/);
	});
});
