/**
 * Engine behavior tests for the host-agnostic agy bridge engine, ported from
 * dotfiles `ai/opencode-router` (tests/agy-router.test.ts). Covers the stream
 * spawn runner (args, envelope parsing, stall watchdog, hard cap, progress),
 * outcome classification (error taxonomy incl. the three timeout variants),
 * fallback policy, and passive quota selection. The SDD contract tests
 * (dispatch/persist/validate/metrics/CLI) stayed behind in the source repo.
 *
 * Divergence helpers (R11 engine lift): ordered per-message content hashes,
 * linear-continuation prefix detection, and bounded seed rendering — cases
 * ported from the opencode-adapter messages tests (host-agnostic shapes only;
 * mapMessages and the ⟲ status line are host behavior and stay there).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import {
	classifyRun,
	isFallbackAllowed,
	type Outcome,
	type RunSignal,
} from "../src/outcomes";
import {
	decidePool,
	hintActive,
	isStale,
	parseSnapshot,
	parseSnapshotDir,
	poolForModel,
	readHint,
	writeHint,
	type QuotaHint,
	type QuotaSnapshot,
} from "../src/quota";
import {
	buildAgyArgs,
	countRecentConversations,
	DEFAULT_STALL_MS,
	parseAgyEnvelope,
	parseStreamLine,
	runAgy,
} from "../src/spawn";
import { listAgyModels, parseAgyModelsOutput } from "../src/models-list";
import {
	hashesArePrefix,
	messageHashes,
	renderSeed,
	SEED_MAX_CHARS,
	SEED_MAX_MESSAGES,
	type PromptContent,
	type PromptMessage,
} from "../src/messages";
import {
	hashesArePrefix as hashesArePrefixFromIndex,
	messageHashes as messageHashesFromIndex,
	listAgyModels as listAgyModelsFromIndex,
	renderSeed as renderSeedFromIndex,
} from "../src";

describe("unit: outcomes — classify run signals", () => {
	const cases: Array<[string, RunSignal, Outcome, string]> = [
		[
			"missing binary maps to transient agy_absent",
			{ exitCode: null, spawnError: "ENOENT" },
			"transient_unavailable",
			"agy_absent",
		],
		[
			"timeout flag maps to timeout",
			{ exitCode: null, timedOut: true },
			"timeout",
			"timeout",
		],
		[
			"exit 124 from timeout(1) maps to timeout",
			{ exitCode: 124, log: "" },
			"timeout",
			"timeout",
		],
		[
			"stall watchdog kill maps to timeout/stall_detected",
			{ exitCode: null, stalled: true },
			"timeout",
			"stall_detected",
		],
		[
			"auth/captcha log maps to auth_captcha",
			{ exitCode: 1, log: "agent hit a CAPTCHA wall; authentication required" },
			"auth_captcha",
			"auth_or_captcha",
		],
		[
			"quota log + nonzero exit maps to quota_unavailable",
			{ exitCode: 1, log: "429 quota exceeded: RESOURCE_EXHAUSTED" },
			"quota_unavailable",
			"quota_exhausted",
		],
		[
			"exit-code corroboration: quota word on clean exit is NOT unavailability",
			{ exitCode: 0, artifactBytes: 0, log: "429 quota exceeded" },
			"artifact_validation_failure",
			"artifact_missing_or_empty",
		],
		[
			"exit-code corroboration: transient word on clean exit is NOT unavailability",
			{
				exitCode: 0,
				artifactBytes: 0,
				log: "server error 503, service overloaded, connection refused",
			},
			"artifact_validation_failure",
			"artifact_missing_or_empty",
		],
		[
			"outage log + nonzero exit maps to transient_unavailable",
			{
				exitCode: 1,
				log: "server error 503, service overloaded, connection refused",
			},
			"transient_unavailable",
			"provider_outage",
		],
		[
			"agy print-wait timeout line + nonzero exit maps to timeout",
			{ exitCode: 1, log: "Error: timeout waiting for response" },
			"timeout",
			"agy_print_wait_timeout",
		],
		[
			"other nonzero exit maps to task_failure",
			{ exitCode: 2, log: "usage: agy <prompt>" },
			"task_failure",
			"nonzero_exit",
		],
		[
			"empty artifact maps to artifact_validation_failure",
			{ exitCode: 0, log: "finished cleanly", artifactBytes: 0 },
			"artifact_validation_failure",
			"artifact_missing_or_empty",
		],
		[
			"clean run with artifact maps to success",
			{ exitCode: 0, log: "wrote exploration.md", artifactBytes: 412 },
			"success",
			"ok",
		],
		[
			"quota word does not override artifact-backed success",
			{
				exitCode: 0,
				artifactBytes: 412,
				log: "429 quota exceeded: RESOURCE_EXHAUSTED",
			},
			"success",
			"ok",
		],
		[
			"auth word does not override artifact-backed success",
			{
				exitCode: 0,
				artifactBytes: 412,
				log: "captcha wall; authentication required",
			},
			"success",
			"ok",
		],
	];
	for (const [name, signal, outcome, reason] of cases) {
		test(name, () => {
			const got = classifyRun(signal);
			expect(got.outcome).toBe(outcome);
			expect(got.reason).toBe(reason);
		});
	}

	test("auth markers take precedence over quota markers", () => {
		expect(
			classifyRun({ exitCode: 1, log: "429 rate limit AND captcha challenge" })
				.outcome,
		).toBe("auth_captcha");
	});

	test("artifact-backed success outranks auth and quota markers", () => {
		expect(
			classifyRun({
				exitCode: 0,
				artifactBytes: 412,
				log: "429 rate limit AND captcha challenge",
			}).outcome,
		).toBe("success");
	});

	test("timeout takes precedence over log markers", () => {
		expect(
			classifyRun({ exitCode: 124, log: "quota exceeded", timedOut: true })
				.outcome,
		).toBe("timeout");
	});

	test("stall_detected outranks the plain timeout reason when both flags fire", () => {
		expect(
			classifyRun({ exitCode: null, timedOut: true, stalled: true }),
		).toEqual({ outcome: "timeout", reason: "stall_detected" });
	});

	test("stall_detected keeps the recoverable-timeout fallback semantics", () => {
		expect(
			isFallbackAllowed(classifyRun({ exitCode: null, stalled: true }).outcome),
		).toBe(true);
	});

	test("agy print-wait signature outranks quota/transient markers on a failed run", () => {
		const cls = classifyRun({
			exitCode: 1,
			log: "Error: timeout waiting for response (429 quota exceeded)",
		});
		expect(cls).toEqual({ outcome: "timeout", reason: "agy_print_wait_timeout" });
	});

	test("agy print-wait timeout is recoverable: fallback policy derives fallbackAllowed=true", () => {
		const cls = classifyRun({
			exitCode: 1,
			log: "Error: timeout waiting for response",
		});
		expect(cls.outcome).toBe("timeout");
		expect(isFallbackAllowed(cls.outcome)).toBe(true);
	});

	test("exit-code corroboration: quota/transient log noise on a clean exit never allows fallback", () => {
		expect(
			isFallbackAllowed(
				classifyRun({ exitCode: 0, artifactBytes: 0, log: "429 quota exceeded" })
					.outcome,
			),
		).toBe(false);
		expect(
			isFallbackAllowed(
				classifyRun({
					exitCode: 0,
					artifactBytes: 0,
					log: "503 service unavailable",
				}).outcome,
			),
		).toBe(false);
	});

	test("exit-code corroboration: the same logs with a nonzero exit do allow fallback", () => {
		expect(
			isFallbackAllowed(
				classifyRun({ exitCode: 1, log: "429 quota exceeded" }).outcome,
			),
		).toBe(true);
		expect(
			isFallbackAllowed(
				classifyRun({ exitCode: 1, log: "503 service unavailable" }).outcome,
			),
		).toBe(true);
	});

	test("envelope ERROR + timeout error wins even when the log regex ALSO matches", () => {
		const cls = classifyRun({
			exitCode: 1,
			log: "Error: timeout waiting for response",
			envelope: {
				status: "ERROR",
				error: "timeout waiting for response",
				conversation_id: "conv-1",
			},
		});
		expect(cls).toEqual({ outcome: "timeout", reason: "agy_print_wait_timeout" });
	});

	test("envelope ERROR + timeout error classifies with NO log marker at all", () => {
		const cls = classifyRun({
			exitCode: 1,
			log: "",
			envelope: { status: "ERROR", error: "timeout waiting for response" },
		});
		expect(cls).toEqual({ outcome: "timeout", reason: "agy_print_wait_timeout" });
	});

	test("envelope ERROR with a non-timeout error + clean log falls to task_failure", () => {
		const cls = classifyRun({
			exitCode: 1,
			log: "",
			envelope: { status: "ERROR", error: "model refused the task" },
		});
		expect(cls).toEqual({ outcome: "task_failure", reason: "nonzero_exit" });
	});

	test("envelope ERROR still yields to AUTH markers in the log", () => {
		const cls = classifyRun({
			exitCode: 1,
			log: "captcha challenge; authentication required",
			envelope: { status: "ERROR", error: "captcha required" },
		});
		expect(cls).toEqual({ outcome: "auth_captcha", reason: "auth_or_captcha" });
	});

	test("envelope SUCCESS never shortcuts the artifact-backed success rule", () => {
		expect(
			classifyRun({
				exitCode: 0,
				artifactBytes: 0,
				log: "",
				envelope: { status: "SUCCESS" },
			}),
		).toEqual({
			outcome: "artifact_validation_failure",
			reason: "artifact_missing_or_empty",
		});
	});

	test("classifyRun: mid-turn print-wait stderr marker → recoverable timeout for both exit codes", () => {
		// Live variant 3 (2026-09-09): exit 0 + status SUCCESS + empty response +
		// '[agy] print timeout after Ns with turn in progress' on stderr.
		const marker =
			"[agy] print timeout after 15s with turn in progress; returning partial output\n";
		expect(classifyRun({ exitCode: 0, log: marker, artifactBytes: 0 })).toEqual({
			outcome: "timeout",
			reason: "agy_print_wait_timeout",
		});
		expect(classifyRun({ exitCode: 1, log: marker, artifactBytes: 0 })).toEqual({
			outcome: "timeout",
			reason: "agy_print_wait_timeout",
		});
		// A delivered artifact always wins over the marker.
		expect(classifyRun({ exitCode: 0, log: marker, artifactBytes: 12 })).toEqual({
			outcome: "success",
			reason: "ok",
		});
	});

	test("exit 0 + ERROR envelope print-wait timeout (mid-turn variant) classifies as a recoverable timeout", () => {
		// Live regression (2026-09-09): agy can exit 0 when its print-wait deadline
		// aborts mid-turn; without the exit-0 envelope gate in classifyRun this
		// would land in artifact_validation_failure — no fallback, no resume,
		// work discarded.
		expect(
			classifyRun({
				exitCode: 0,
				log: "",
				artifactBytes: 0,
				envelope: { status: "ERROR", error: "timeout waiting for response" },
			}),
		).toEqual({
			outcome: "timeout",
			reason: "agy_print_wait_timeout",
		});
	});

	test("R1 s1: expectArtifact=false + exit 0 + SUCCESS envelope + non-empty response → success(ok)", () => {
		expect(
			classifyRun({
				exitCode: 0,
				log: "streamed run, no artifact expected",
				expectArtifact: false,
				envelope: {
					status: "SUCCESS",
					response: "the streamed answer",
					conversation_id: "conv-1",
				},
			}),
		).toEqual({ outcome: "success", reason: "ok" });
	});

	test("R1 s2 (compat guard): expectArtifact omitted + no artifact → artifact_validation_failure (unchanged)", () => {
		expect(
			classifyRun({
				exitCode: 0,
				log: "streamed run, no artifact expected",
				envelope: { status: "SUCCESS", response: "the streamed answer" },
			}),
		).toEqual({
			outcome: "artifact_validation_failure",
			reason: "artifact_missing_or_empty",
		});
	});

	test("R1: whitespace-only SUCCESS response never satisfies the seam", () => {
		expect(
			classifyRun({
				exitCode: 0,
				log: "",
				expectArtifact: false,
				envelope: { status: "SUCCESS", response: "   " },
			}),
		).toEqual({
			outcome: "artifact_validation_failure",
			reason: "artifact_missing_or_empty",
		});
	});

	test("R1: ERROR envelope keeps the exit-0 print-wait timeout gate for artifact-less runs", () => {
		expect(
			classifyRun({
				exitCode: 0,
				log: "",
				expectArtifact: false,
				envelope: { status: "ERROR", error: "timeout waiting for response" },
			}),
		).toEqual({ outcome: "timeout", reason: "agy_print_wait_timeout" });
	});

	test("R1: missing envelope never satisfies the seam", () => {
		expect(
			classifyRun({
				exitCode: 0,
				log: "finished with no parseable envelope",
				expectArtifact: false,
			}),
		).toEqual({
			outcome: "artifact_validation_failure",
			reason: "artifact_missing_or_empty",
		});
	});

	test("R1: seam success outranks the mid-turn stderr marker, mirroring artifact-backed success", () => {
		const marker =
			"[agy] print timeout after 15s with turn in progress; returning partial output\n";
		expect(
			classifyRun({
				exitCode: 0,
				log: marker,
				expectArtifact: false,
				envelope: { status: "SUCCESS", response: "delivered anyway" },
			}),
		).toEqual({ outcome: "success", reason: "ok" });
	});

	test("R1: expectArtifact=true behaves like omitted — artifact-backed success only", () => {
		expect(
			classifyRun({
				exitCode: 0,
				log: "",
				expectArtifact: true,
				artifactBytes: 412,
				envelope: { status: "ERROR", error: "model refused the task" },
			}),
		).toEqual({ outcome: "success", reason: "ok" });
	});

	test("R1 guard: artifact-backed success still outranks auth/quota markers with the field present", () => {
		expect(
			classifyRun({
				exitCode: 0,
				artifactBytes: 412,
				log: "429 rate limit AND captcha challenge",
				expectArtifact: true,
			}).outcome,
		).toBe("success");
	});
});

describe("unit: outcomes — fallback policy", () => {
	const fallbackCases: Array<[Outcome, boolean]> = [
		["success", false],
		["quota_unavailable", true],
		["transient_unavailable", true],
		["auth_captcha", false],
		["timeout", true],
		["task_failure", false],
		["artifact_validation_failure", false],
	];
	for (const [outcome, allowed] of fallbackCases) {
		test(`${outcome} fallbackAllowed=${allowed}`, () => {
			expect(isFallbackAllowed(outcome)).toBe(allowed);
		});
	}
});

describe("unit: quota — pool by requested model, staleness, thresholds, hint cache", () => {
	/** Real passive snapshot shape from ~/.config/ai-quotas/gemini.json (fractions replaced). */
	const rawSnapshot = (
		gemini5h: number,
		geminiWeekly: number,
		tp5h = 1,
		resetIn = "2099-01-01T00:00:00Z",
	) => ({
		active_model: "Claude Sonnet 4.6",
		quota_gemini_5h: {
			remaining_fraction: gemini5h,
			remaining_percentage: gemini5h * 100,
			reset_in_seconds: 3600,
			reset_time: resetIn,
		},
		quota_gemini_weekly: { remaining_fraction: geminiWeekly },
		quota_3p_5h: {
			remaining_fraction: tp5h,
			remaining_percentage: tp5h * 100,
			reset_in_seconds: 3600,
			reset_time: resetIn,
		},
		quota_3p_weekly: { remaining_fraction: 1 },
	});
	test("pool selected by requested model name, not active_model", () => {
		expect(poolForModel("Gemini 3.7 Flash (High)")).toBe("gemini");
		expect(poolForModel("gemini-2.5-pro")).toBe("gemini");
		expect(poolForModel("Claude Sonnet 4.6")).toBe("3p");
		expect(poolForModel("GPT-5")).toBe("3p");
	});
	test("parseSnapshot reads the passive snapshot shape", () => {
		const snap = parseSnapshot(rawSnapshot(0.96, 0.97));
		expect(snap?.pools.gemini.fiveHour).toBe(0.96);
		expect(snap?.pools.gemini.weekly).toBe(0.97);
		expect(snap?.pools["3p"].fiveHour).toBe(1);
		expect(snap?.activeModel).toBe("Claude Sonnet 4.6");
	});
	test("parseSnapshot rejects garbage input", () => {
		expect(parseSnapshot("not json at all")).toBeNull();
		expect(parseSnapshot({ provider: "antigravity" })).toBeNull();
	});
	test("healthy pool within threshold is allowed", () => {
		const snap = parseSnapshot(rawSnapshot(0.96, 0.97)) as QuotaSnapshot;
		expect(decidePool(snap, "Gemini 3.7 Flash (High)")).toMatchObject({
			pool: "gemini",
			allowed: true,
		});
	});
	test("exhausted 5h window blocks the pool", () => {
		const snap = parseSnapshot(rawSnapshot(0.03, 0.9)) as QuotaSnapshot;
		const d = decidePool(snap, "Gemini 3.7 Flash (High)");
		expect(d.allowed).toBe(false);
		expect(d.reason).toBe("threshold_exhausted");
	});
	test("exhausted weekly budget blocks the pool", () => {
		const snap = parseSnapshot(rawSnapshot(0.9, 0.02)) as QuotaSnapshot;
		expect(decidePool(snap, "Gemini 3.7 Flash (High)").allowed).toBe(false);
	});
	test("gemini exhaustion does not block a 3p request", () => {
		const snap = parseSnapshot(rawSnapshot(0.01, 0.01)) as QuotaSnapshot;
		expect(decidePool(snap, "Claude Sonnet 4.6")).toMatchObject({
			pool: "3p",
			allowed: true,
		});
	});
	test("stale snapshot (reset passed) allows one real attempt", () => {
		const snap = parseSnapshot(
			rawSnapshot(0.01, 0.01, 1, "2020-01-01T00:00:00Z"),
		) as QuotaSnapshot;
		const d = decidePool(snap, "Gemini 3.7 Flash (High)");
		expect(d.allowed).toBe(true);
		expect(d.reason).toBe("stale_snapshot");
	});
	test("isStale is pool-scoped and reset-time driven", () => {
		const snap = parseSnapshot(
			rawSnapshot(0.5, 0.5, 0.5, "2020-01-01T00:00:00Z"),
		) as QuotaSnapshot;
		expect(isStale(snap, "gemini", new Date("2021-01-01T00:00:00Z"))).toBe(true);
		expect(isStale(snap, "gemini", new Date("2019-01-01T00:00:00Z"))).toBe(false);
	});
	test("hint roundtrip: write, read back, expire after reset_time", async () => {
		const dir = await mkdtemp("/tmp/agy-hint-");
		const path = `${dir}/router-quota-hint.json`;
		const hint: QuotaHint = {
			schema: "agy-explore/quota-hint@1",
			pool: "gemini",
			blocked: true,
			resetTime: "2099-01-01T00:00:00Z",
			savedAt: "2026-08-20T00:00:00Z",
		};
		writeHint(path, hint);
		expect(readHint(path)).toEqual(hint);
		expect(readHint(`${dir}/missing.json`)).toBeNull();
		expect(hintActive(hint, new Date("2098-01-01T00:00:00Z"))).toBe(true);
		expect(hintActive(hint, new Date("2100-01-01T00:00:00Z"))).toBe(false);
	});
});

describe("unit: quota — statusline v2 directory", () => {
	/** Exact bytes of the 4 files ~/.local/state/ai-quotas/ writes (captured 2026-08-20, statusline v2). */
	const V2_GEMINI_5H = `{
  "provider": "gemini",
  "kind": "window",
  "used": 3.68,
  "limit": 100,
  "unit": "percent",
  "label": "5h window",
  "display_name": "Google Gemini",
  "resets_at": "2026-08-20T21:14:05Z",
  "fetched_at": "2026-08-20T16:58:14Z",
  "source": "local-log"
}
`;
	const V2_GEMINI_WEEKLY = `{
  "provider": "gemini",
  "kind": "window",
  "used": 4.01,
  "limit": 100,
  "unit": "percent",
  "label": "Weekly",
  "display_name": "Google Gemini",
  "resets_at": "2026-08-24T10:11:30Z",
  "fetched_at": "2026-08-20T16:58:14Z",
  "source": "local-log"
}
`;
	const V2_3P_5H = `{
  "provider": "gemini",
  "kind": "window",
  "used": 0,
  "limit": 100,
  "unit": "percent",
  "label": "3P 5h window",
  "display_name": "Google Gemini",
  "resets_at": "2026-08-20T21:53:45Z",
  "fetched_at": "2026-08-20T16:58:14Z",
  "source": "local-log"
}
`;
	const V2_3P_WEEKLY = `{
  "provider": "gemini",
  "kind": "window",
  "used": 0,
  "limit": 100,
  "unit": "percent",
  "label": "3P Weekly",
  "display_name": "Google Gemini",
  "resets_at": "2026-08-27T16:53:45Z",
  "fetched_at": "2026-08-20T16:58:14Z",
  "source": "local-log"
}
`;
	const V2_ALL: Record<string, string> = {
		"gemini-5h.json": V2_GEMINI_5H,
		"gemini-weekly.json": V2_GEMINI_WEEKLY,
		"gemini-3p-5h.json": V2_3P_5H,
		"gemini-3p-weekly.json": V2_3P_WEEKLY,
	};
	/** Deterministic synthetic v2 file (default resets in 2099 so decide() tests never see wall-clock staleness). */
	const v2File = (over: Record<string, unknown> = {}) =>
		JSON.stringify({
			provider: "gemini",
			kind: "window",
			used: 0,
			limit: 100,
			unit: "percent",
			label: "window",
			display_name: "Google Gemini",
			resets_at: "2099-01-01T00:00:00Z",
			fetched_at: "2026-08-20T16:58:14Z",
			source: "local-log",
			...over,
		});
	async function v2Dir(files: Record<string, string> = V2_ALL) {
		const dir = await mkdtemp("/tmp/agy-quota-v2-");
		for (const [name, text] of Object.entries(files))
			await Bun.write(`${dir}/${name}`, text);
		return dir;
	}
	const FRESH = new Date("2026-08-20T17:00:00Z");

	test("parseSnapshotDir maps filenames to pools/windows and converts percentages to fractions", async () => {
		const snap = parseSnapshotDir(await v2Dir());
		expect(snap?.pools.gemini.fiveHour).toBeCloseTo(0.9632, 10);
		expect(snap?.pools.gemini.weekly).toBeCloseTo(0.9599, 10);
		expect(snap?.pools["3p"].fiveHour).toBe(1);
		expect(snap?.pools["3p"].weekly).toBe(1);
		expect(snap?.pools.gemini.resetTime).toBe("2026-08-20T21:14:05Z");
		expect(snap?.pools["3p"].resetTime).toBe("2026-08-20T21:53:45Z");
		expect(snap?.updatedAt).toBe("2026-08-20T16:58:14Z");
	});
	test("remaining fraction math: used 13.57% ⇒ 0.8643; clamped to [0, 1]", async () => {
		const dir = await v2Dir({
			"gemini-5h.json": v2File({ used: 13.57, label: "5h window" }),
			"gemini-weekly.json": v2File({ used: 4.01, label: "Weekly" }),
			"gemini-3p-5h.json": v2File({ used: 150, label: "3P 5h window" }),
			"gemini-3p-weekly.json": v2File({ used: -10, label: "3P Weekly" }),
		});
		const snap = parseSnapshotDir(dir);
		expect(snap?.pools.gemini.fiveHour).toBeCloseTo(0.8643, 10);
		expect(snap?.pools["3p"].fiveHour).toBe(0);
		expect(snap?.pools["3p"].weekly).toBe(1);
	});
	test("filename — not the per-file provider field — decides the pool", async () => {
		for (const t of [V2_GEMINI_5H, V2_GEMINI_WEEKLY, V2_3P_5H, V2_3P_WEEKLY])
			expect(JSON.parse(t).provider).toBe("gemini");
		const snap = parseSnapshotDir(await v2Dir()) as QuotaSnapshot;
		expect(snap.pools["3p"].resetTime).toBe("2026-08-20T21:53:45Z");
		expect(decidePool(snap, "Claude Sonnet 4.6", { now: FRESH })).toMatchObject({
			pool: "3p",
			allowed: true,
		});
	});
	test("missing weekly file degrades only that pool: decidePool grants the single stale attempt", async () => {
		const { "gemini-weekly.json": _omit, ...rest } = V2_ALL;
		const snap = parseSnapshotDir(await v2Dir(rest));
		expect(snap).not.toBeNull();
		expect(
			decidePool(snap as QuotaSnapshot, "Gemini 3.7 Flash (High)", { now: FRESH }),
		).toMatchObject({ pool: "gemini", allowed: true, reason: "stale_snapshot" });
		expect(
			decidePool(snap as QuotaSnapshot, "Claude Sonnet 4.6", { now: FRESH }),
		).toMatchObject({ pool: "3p", allowed: true, reason: "within_threshold" });
	});
	test("decidePool on captured v2 data: fresh ⇒ within_threshold, past reset ⇒ stale per pool", async () => {
		const snap = parseSnapshotDir(await v2Dir()) as QuotaSnapshot;
		expect(
			decidePool(snap, "Gemini 3.7 Flash (High)", { now: FRESH }),
		).toMatchObject({
			allowed: true,
			reason: "within_threshold",
			resetTime: "2026-08-20T21:14:05Z",
		});
		const afterGeminiReset = new Date("2026-08-20T21:30:00Z");
		expect(
			decidePool(snap, "Gemini 3.7 Flash (High)", { now: afterGeminiReset }),
		).toMatchObject({ allowed: true, reason: "stale_snapshot" });
		expect(
			decidePool(snap, "Claude Sonnet 4.6", { now: afterGeminiReset }),
		).toMatchObject({ pool: "3p", allowed: true, reason: "within_threshold" });
	});
	test("exhausted v2 percentages block the pool through the new reader", async () => {
		const dir = await v2Dir({
			"gemini-5h.json": v2File({ used: 99.9, resets_at: "2099-01-01T00:00:00Z" }),
			"gemini-weekly.json": v2File({ used: 0 }),
			"gemini-3p-5h.json": v2File({ used: 0 }),
			"gemini-3p-weekly.json": v2File({ used: 0 }),
		});
		const d = decidePool(
			parseSnapshotDir(dir) as QuotaSnapshot,
			"Gemini 3.7 Flash (High)",
		);
		expect(d).toMatchObject({
			pool: "gemini",
			allowed: false,
			reason: "threshold_exhausted",
		});
	});
	test("absent or empty directory yields null (fails closed to the stale path upstream)", async () => {
		expect(parseSnapshotDir("/tmp/agy-quota-v2-nope")).toBeNull();
		expect(parseSnapshotDir(await v2Dir({}))).toBeNull();
	});
});

describe("unit: spawn — timeout, workdir-only args, run.log, daily guard", () => {
	test("successful stub run: exit 0, log captured, run.log written in workdir", async () => {
		const dir = await mkdtemp("/tmp/agy-spawn-");
		const stub = `${dir}/stub.sh`;
		await Bun.write(
			stub,
			'#!/bin/sh\necho "agy says hi"\nprintf "%s" "$*" > args.txt\nexit 0\n',
		);
		Bun.spawnSync(["chmod", "+x", stub]);
		const r = await runAgy({
			bin: stub,
			prompt: "do it",
			workdir: dir,
			timeoutMs: 5000,
		});
		expect(r.exitCode).toBe(0);
		expect(r.timedOut).toBe(false);
		expect(r.log).toContain("agy says hi");
		expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
		expect(await Bun.file(`${dir}/run.log`).text()).toContain("agy says hi");
	});
	test("WORKDIR-ONLY: args contain the prompt, never an --add-dir repo path", async () => {
		const dir = await mkdtemp("/tmp/agy-spawn-");
		const stub = `${dir}/stub.sh`;
		await Bun.write(
			stub,
			'#!/bin/sh\nprintf "%s" "$*" > "$0.args"\ncat "$0.args" > /dev/null\nexit 0\n',
		);
		Bun.spawnSync(["chmod", "+x", stub]);
		await runAgy({
			bin: stub,
			prompt: "explore briefly",
			workdir: dir,
			timeoutMs: 5000,
		});
		const passed = await Bun.file(`${stub}.args`).text();
		expect(passed).toContain("explore briefly");
		// Containment invariant: every --add-dir target must be the workdir itself; the repo (or any other dir) is never exposed.
		const addDirs = passed
			.split(" ")
			.filter((_, i, a) => a[i - 1] === "--add-dir");
		expect(addDirs).toEqual([dir]);
		expect(passed).not.toContain("/home/bruno/Code");
	});
	test("stub exceeding timeoutMs is killed and flagged timedOut", async () => {
		const dir = await mkdtemp("/tmp/agy-spawn-");
		const stub = `${dir}/slow.sh`;
		await Bun.write(stub, "#!/bin/sh\nsleep 5\n");
		Bun.spawnSync(["chmod", "+x", stub]);
		const r = await runAgy({
			bin: stub,
			prompt: "x",
			workdir: dir,
			timeoutMs: 150,
		});
		expect(r.timedOut).toBe(true);
		expect(r.exitCode).not.toBe(0);
	});
	test("--model passthrough: appended when provided, absent when missing/empty", async () => {
		const dir = await mkdtemp("/tmp/agy-spawn-");
		const stub = `${dir}/stub.sh`;
		await Bun.write(stub, '#!/bin/sh\nprintf "%s" "$*" > "$0.args"\nexit 0\n');
		Bun.spawnSync(["chmod", "+x", stub]);
		await runAgy({
			bin: stub,
			prompt: "x",
			workdir: dir,
			timeoutMs: 5000,
			model: "gemini-3.8-flash-high",
		});
		expect(await Bun.file(`${stub}.args`).text()).toContain(
			"--model gemini-3.8-flash-high",
		);
		await runAgy({
			bin: stub,
			prompt: "x",
			workdir: dir,
			timeoutMs: 5000,
			model: "",
		});
		expect(await Bun.file(`${stub}.args`).text()).not.toContain("--model");
		await runAgy({ bin: stub, prompt: "x", workdir: dir, timeoutMs: 5000 });
		expect(await Bun.file(`${stub}.args`).text()).not.toContain("--model");
	});
	test("daily guard counts only conversation DBs from today", async () => {
		const dir = await mkdtemp("/tmp/agy-guard-");
		await Bun.write(`${dir}/a.db`, "x");
		await Bun.write(`${dir}/b.db`, "x");
		await Bun.write(`${dir}/notes.txt`, "x");
		const now = new Date();
		expect(countRecentConversations(dir, now)).toBe(2);
		expect(countRecentConversations(`${dir}/missing`, now)).toBe(0);
	});
});

describe("unit: spawn — buildAgyArgs derives the print-wait deadline", () => {
	test("600s budget yields --print-timeout 590s (fires before our spawnSync timeout)", () => {
		const args = buildAgyArgs({
			bin: "agy",
			prompt: "p",
			workdir: "/w",
			timeoutMs: 600_000,
		});
		const i = args.indexOf("--print-timeout");
		expect(i).toBeGreaterThan(-1);
		expect(args[i + 1]).toBe("590s");
	});
	test("tiny budgets clamp to the 1s floor", () => {
		const args = buildAgyArgs({
			bin: "agy",
			prompt: "p",
			workdir: "/w",
			timeoutMs: 5000,
		});
		const i = args.indexOf("--print-timeout");
		expect(args[i + 1]).toBe("1s");
	});
	test("flag order: after --dangerously-skip-permissions, value flags together, optional --model pair last", () => {
		expect(
			buildAgyArgs({
				bin: "agy",
				prompt: "p",
				workdir: "/w",
				timeoutMs: 630_000,
				model: "m1",
			}),
		).toEqual([
			"--print",
			"p",
			"--add-dir",
			"/w",
			"--dangerously-skip-permissions",
			"--print-timeout",
			"620s",
			"--output-format",
			"json",
			"--model",
			"m1",
		]);
		expect(
			buildAgyArgs({ bin: "agy", prompt: "p", workdir: "/w", timeoutMs: 600_000 }),
		).not.toContain("--model");
	});
	test("print-timeout never echoes the raw spawn timeout", () => {
		const args = buildAgyArgs({
			bin: "agy",
			prompt: "p",
			workdir: "/w",
			timeoutMs: 600_000,
		});
		expect(args.join(" ")).not.toContain("600000");
		expect(args.join(" ")).not.toContain("--print-timeout 600s");
	});
});

describe("unit: spawn — agy JSON envelope parsing (--output-format json)", () => {
	const envelope = {
		conversation_id: "0f7c1b2e-1111-4aaa-9bbb-2c2c2c2c2c2c",
		status: "ERROR",
		response: "",
		error: "timeout waiting for response",
		duration_seconds: 12,
		num_turns: 3,
		usage: {
			input_tokens: 10,
			output_tokens: 20,
			thinking_tokens: 0,
			cache_read_tokens: 5,
			total_tokens: 30,
		},
	};
	test("valid envelope object parses", () => {
		expect(parseAgyEnvelope(JSON.stringify(envelope))).toEqual(envelope);
	});
	test("trailing newline tolerated", () => {
		expect(parseAgyEnvelope(`${JSON.stringify(envelope)}\n`)).toEqual(envelope);
	});
	test("multi-line stdout parses the LAST non-empty line", () => {
		expect(
			parseAgyEnvelope(
				`agy: warming up\nnotice: something else\n${JSON.stringify(envelope)}`,
			),
		).toEqual(envelope);
	});
	test("object without a string status field yields null", () => {
		expect(
			parseAgyEnvelope('{"conversation_id":"x","usage":{"total_tokens":1}}'),
		).toBeNull();
		expect(parseAgyEnvelope('{"status":42}')).toBeNull();
	});
	test("garbage yields null", () => {
		expect(parseAgyEnvelope("not json at all")).toBeNull();
	});
	test("empty stdout yields null", () => {
		expect(parseAgyEnvelope("")).toBeNull();
		expect(parseAgyEnvelope("  \n \n")).toBeNull();
	});
});

describe("unit: spawn — buildAgyArgs output formats (json + stream-json) and resume flag", () => {
	const base = { bin: "agy", prompt: "p", workdir: "/w", timeoutMs: 600_000 };
	test("json format (default) keeps the committed argv shape", () => {
		expect(buildAgyArgs(base)).toEqual([
			"--print",
			"p",
			"--add-dir",
			"/w",
			"--dangerously-skip-permissions",
			"--print-timeout",
			"590s",
			"--output-format",
			"json",
		]);
	});
	test("stream-json variant swaps ONLY the output format", () => {
		expect(buildAgyArgs(base, "stream-json")).toEqual([
			"--print",
			"p",
			"--add-dir",
			"/w",
			"--dangerously-skip-permissions",
			"--print-timeout",
			"590s",
			"--output-format",
			"stream-json",
		]);
	});
	test("--conversation resume pair appended only when a resume id is provided", () => {
		expect(
			buildAgyArgs({ ...base, resumeConversationId: "conv-7" }, "stream-json"),
		).toEqual([
			"--print",
			"p",
			"--add-dir",
			"/w",
			"--dangerously-skip-permissions",
			"--print-timeout",
			"590s",
			"--output-format",
			"stream-json",
			"--conversation",
			"conv-7",
		]);
		expect(buildAgyArgs(base, "stream-json")).not.toContain("--conversation");
	});
	test("stall default is 10 minutes (evidence: real runs stream intermediate events)", () => {
		expect(DEFAULT_STALL_MS).toBe(600_000);
	});
});

describe("unit: spawn — stream-json NDJSON line extraction (pure)", () => {
	const initLine = JSON.stringify({
		event: "init",
		conversation_id: "0f7c1111-2222-4aaa-9bbb-2c2c2c2c2c2c",
		init: { cwd: "/w", tools: [] },
	});
	const envelope = {
		conversation_id: "0f7c1111-2222-4aaa-9bbb-2c2c2c2c2c2c",
		status: "SUCCESS",
		response: "done",
		num_turns: 1,
	};
	const resultLine = JSON.stringify({ event: "result", result: envelope });
	test("init line yields the early recovery conversationId and its event type", () => {
		expect(parseStreamLine(initLine)).toEqual({
			conversationId: "0f7c1111-2222-4aaa-9bbb-2c2c2c2c2c2c",
			event: "init",
		});
	});
	test("result line yields the envelope under the same validation as parseAgyEnvelope", () => {
		expect(parseStreamLine(resultLine)).toEqual({ envelope, event: "result" });
		expect(
			parseStreamLine(
				JSON.stringify({ event: "result", result: { no_status: true } }),
			),
		).toEqual({ event: "result" });
		expect(
			parseStreamLine(JSON.stringify({ event: "result", result: { status: 42 } })),
		).toEqual({ event: "result" });
	});
	test("non-JSON and empty lines are tolerated (nothing captured); step_update yields only its event type", () => {
		expect(parseStreamLine("agy: warning noise")).toEqual({});
		expect(
			parseStreamLine('{"event":"step_update","step_update":{"state":"ACTIVE"}}'),
		).toEqual({ event: "step_update" });
		expect(parseStreamLine("")).toEqual({});
	});
});

describe("unit: models-list — dynamic discovery via `agy models` (TSV)", () => {
	/** Real-shaped output captured from `agy models` (v1.1.28, 2026-09-09): one preamble line, then 14 TSV rows. */
	const REAL_OUTPUT = [
		"Fetching available models...",
		"gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
		"gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
		"gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
		"gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
		"gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)",
		"gemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
		"gemini-3.6-flash-high\tGemini 3.6 Flash (High)",
		"gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)",
		"gemini-3.6-flash-low\tGemini 3.6 Flash (Low)",
		"gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
		"gemini-3.1-pro-low\tGemini 3.1 Pro (Low)",
		"claude-sonnet-4-6\tClaude Sonnet 4.6",
		"claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
		"gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
		"",
	].join("\n");

	test("parses the real-shaped output: preamble skipped, all 14 models in order", () => {
		const models = parseAgyModelsOutput(REAL_OUTPUT);
		expect(models).toHaveLength(14);
		expect(models[0]).toEqual({ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" });
		expect(models[13]).toEqual({ id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" });
		expect(models.map((m) => m.id)).toContain("claude-opus-4-6-thinking");
	});

	test("skips blank, malformed (no tab), and empty-name lines; trims whitespace and CRLF", () => {
		const models = parseAgyModelsOutput(
			[
				"some preamble without tabs",
				"",
				"  \t  ",
				"m-1\tModel One",
				"\tm-2 has empty id? no — leading tab means empty id",
				"m-3-no-tab",
				"m-4\t   ",
				"m-5\tTrimmed Name  \r",
			].join("\n"),
		);
		expect(models).toEqual([
			{ id: "m-1", name: "Model One" },
			{ id: "m-5", name: "Trimmed Name" },
		]);
	});

	test("empty output parses to []", () => {
		expect(parseAgyModelsOutput("")).toEqual([]);
		expect(parseAgyModelsOutput("only a preamble line\n")).toEqual([]);
	});

	test("listAgyModels returns parsed models via the default spawn path", async () => {
		const dir = await mkdtemp("/tmp/agy-models-");
		const stub = `${dir}/agy-stub.sh`;
		await Bun.write(stub, `#!/bin/sh\nprintf '%s\\n' "id-1\tName One"\n`);
		Bun.spawnSync(["chmod", "+x", stub]);
		const models = await listAgyModels({ bin: stub });
		expect(models).toEqual([{ id: "id-1", name: "Name One" }]);
	});

	test("listAgyModels is tolerant: spawn error, nonzero exit, and empty output all yield [] (never throws)", async () => {
		const missing = await listAgyModels({ bin: "/nonexistent/agy-binary" });
		expect(missing).toEqual([]);

		const nonzero = await listAgyModels({
			bin: "agy",
			runner: () => ({ stdout: "boom", exitCode: 1 }),
		});
		expect(nonzero).toEqual([]);

		const empty = await listAgyModels({
			bin: "agy",
			runner: () => ({ stdout: "", exitCode: 0 }),
		});
		expect(empty).toEqual([]);

		const throwing = await listAgyModels({
			bin: "agy",
			runner: () => {
				throw new Error("injected failure");
			},
		});
		expect(throwing).toEqual([]);
	});

	test("listAgyModels is exported from the package index", () => {
		expect(listAgyModelsFromIndex).toBe(listAgyModels);
	});
});

describe("unit: spawn — async stream runner: stall watchdog, hard cap, init/result capture", () => {
	/** Minimal ChildProcess stand-in: readline wraps a real Readable; kill() fakes the close event. */
	function fakeChild() {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const child: any = new EventEmitter();
		child.stdout = new Readable({ read() {} });
		child.stderr = new Readable({ read() {} });
		child.killed = false;
		child.kill = () => {
			child.killed = true;
			queueMicrotask(() => child.emit("close", null, "SIGTERM"));
			return true;
		};
		return child;
	}
	const ndjson = (obj: unknown) => Buffer.from(`${JSON.stringify(obj)}\n`);
	const asSpawn = (child: unknown) => (() => child) as unknown as typeof spawn;

	test("stall watchdog: init captured, silence beyond stallMs kills with stalled=true, run.log keeps progress", async () => {
		const dir = await mkdtemp("/tmp/agy-stall-");
		const child = fakeChild();
		const p = runAgy({
			bin: "agy",
			prompt: "p",
			workdir: dir,
			timeoutMs: 30_000,
			stallMs: 60,
			spawnImpl: asSpawn(child),
		});
		child.stdout.push(ndjson({ event: "init", conversation_id: "conv-stall" }));
		const r = await p;
		expect(r.stalled).toBe(true);
		expect(r.conversationId).toBe("conv-stall");
		expect(r.timedOut).toBe(false);
		expect(r.exitCode).toBeNull();
		expect(await Bun.file(`${dir}/run.log`).text()).toContain('"event":"init"');
	});
	test("hard cap: timeoutMs kill wins when the watchdog is disabled (stallMs 0 is legal)", async () => {
		const dir = await mkdtemp("/tmp/agy-cap-");
		const child = fakeChild();
		const r = await runAgy({
			bin: "agy",
			prompt: "p",
			workdir: dir,
			timeoutMs: 80,
			stallMs: 0,
			spawnImpl: asSpawn(child),
		});
		expect(r.timedOut).toBe(true);
		expect(r.stalled).toBeUndefined();
	});
	test("result event parsed into the envelope; non-JSON lines skipped but logged", async () => {
		const dir = await mkdtemp("/tmp/agy-result-");
		const child = fakeChild();
		const envelope = {
			conversation_id: "conv-9",
			status: "SUCCESS",
			response: "ok",
		};
		const p = runAgy({
			bin: "agy",
			prompt: "p",
			workdir: dir,
			timeoutMs: 30_000,
			stallMs: 0,
			spawnImpl: asSpawn(child),
		});
		child.stdout.push(Buffer.from("noise line, not json\n"));
		child.stdout.push(ndjson({ event: "init", conversation_id: "conv-9" }));
		child.stdout.push(ndjson({ event: "result", result: envelope }));
		// Let readline drain the pushed lines BEFORE the process "exits".
		setTimeout(() => child.emit("close", 0, null), 10);
		const r = await p;
		expect(r.exitCode).toBe(0);
		expect(r.conversationId).toBe("conv-9");
		expect(r.envelope).toEqual(envelope);
		expect((await Bun.file(`${dir}/run.log`).text()).split("\n")).toContain(
			"noise line, not json",
		);
	});
	test("REAL spawn: slow stub killed by the watchdog still leaves its init line in run.log", async () => {
		const dir = await mkdtemp("/tmp/agy-stall-real-");
		const stub = `${dir}/stub.sh`;
		await Bun.write(
			stub,
			'#!/bin/sh\nprintf \'%s\\n\' \'{"event":"init","conversation_id":"conv-real"}\'\nsleep 5\n',
		);
		Bun.spawnSync(["chmod", "+x", stub]);
		const r = await runAgy({
			bin: stub,
			prompt: "p",
			workdir: dir,
			timeoutMs: 30_000,
			stallMs: 300,
		});
		expect(r.stalled).toBe(true);
		expect(r.conversationId).toBe("conv-real");
		expect(await Bun.file(`${dir}/run.log`).text()).toContain("conv-real");
	});
	test("progress: counts parsed NDJSON event lines and remembers the last event type", async () => {
		const dir = await mkdtemp("/tmp/agy-progress-");
		const child = fakeChild();
		const p = runAgy({
			bin: "agy",
			prompt: "p",
			workdir: dir,
			timeoutMs: 30_000,
			stallMs: 0,
			spawnImpl: asSpawn(child),
		});
		child.stdout.push(
			ndjson({ event: "init", conversation_id: "conv-progress" }),
		);
		child.stdout.push(
			ndjson({ event: "step_update", step_update: { state: "ACTIVE" } }),
		);
		child.stdout.push(Buffer.from("noise line, not json\n"));
		child.stdout.push(
			ndjson({ event: "result", result: { status: "SUCCESS", num_turns: 2 } }),
		);
		setTimeout(() => child.emit("close", 0, null), 10);
		const r = await p;
		expect(r.progress).toEqual({ events: 3, lastEvent: "result" });
		expect(r.envelope).toEqual({ status: "SUCCESS", num_turns: 2 });
		expect(r.conversationId).toBe("conv-progress");
	});
	test("progress: absent when no NDJSON event lines arrive (spawn error / silent child)", async () => {
		const dir = await mkdtemp("/tmp/agy-progress-none-");
		const child = fakeChild();
		const p = runAgy({
			bin: "agy",
			prompt: "p",
			workdir: dir,
			timeoutMs: 30_000,
			stallMs: 0,
			spawnImpl: asSpawn(child),
		});
		child.stderr?.push(Buffer.from("boom\n"));
		setTimeout(() => child.emit("close", 1, null), 10);
		const r = await p;
		expect(r.progress).toBeUndefined();
	});

	test("R2 logPath: stdout lines AND stderr chunks land at the custom target; <workdir>/run.log NOT created", async () => {
		const dir = await mkdtemp("/tmp/agy-logpath-");
		const logDir = `${dir}/logs`;
		mkdirSync(logDir);
		const custom = `${logDir}/custom-run.log`;
		const child = fakeChild();
		const p = runAgy({
			bin: "agy",
			prompt: "p",
			workdir: dir,
			timeoutMs: 30_000,
			stallMs: 0,
			logPath: custom,
			spawnImpl: asSpawn(child),
		});
		child.stdout.push(ndjson({ event: "init", conversation_id: "conv-log" }));
		child.stderr?.push(Buffer.from("stderr noise\n"));
		setTimeout(() => child.emit("close", 0, null), 10);
		const r = await p;
		expect(r.exitCode).toBe(0);
		const text = await Bun.file(custom).text();
		expect(text).toContain('"event":"init"');
		expect(text).toContain("stderr noise");
		expect(existsSync(`${dir}/run.log`)).toBe(false);
	});

	test("R2 default: logPath omitted keeps writing <workdir>/run.log", async () => {
		const dir = await mkdtemp("/tmp/agy-logpath-default-");
		const child = fakeChild();
		const p = runAgy({
			bin: "agy",
			prompt: "p",
			workdir: dir,
			timeoutMs: 30_000,
			stallMs: 0,
			spawnImpl: asSpawn(child),
		});
		child.stdout.push(ndjson({ event: "init", conversation_id: "conv-default" }));
		setTimeout(() => child.emit("close", 0, null), 10);
		await p;
		expect(await Bun.file(`${dir}/run.log`).text()).toContain('"event":"init"');
	});
});

describe("unit: messages — R11 divergence hashes (host-agnostic lift)", () => {
	function user(parts: PromptContent): PromptMessage {
		return { role: "user", content: parts };
	}

	test("messageHashes: stable across calls, 16 lowercase hex chars, distinct per content and role", () => {
		const msgs: PromptMessage[] = [
			{ role: "system", content: "sys" },
			user("one"),
			{ role: "assistant", content: [{ type: "text", text: "two" }] },
		];
		const first = messageHashes(msgs);
		expect(messageHashes(msgs)).toEqual(first);
		expect(first).toHaveLength(3);
		for (const h of first) expect(h).toMatch(/^[0-9a-f]{16}$/);
		expect(new Set(first).size).toBe(3);
	});

	test("messageHashes: order is carried by position — a reordered array hashes differently element-wise", () => {
		const msgs = [user("a"), { role: "assistant", content: "b" } as PromptMessage, user("c")];
		const h = messageHashes(msgs);
		const swapped = messageHashes([msgs[1], msgs[0], msgs[2]]);
		expect(swapped).not.toEqual(h);
	});

	test("hashesArePrefix table: linear continuation vs edited/deleted/reordered history", () => {
		const h = messageHashes([user("1"), { role: "assistant", content: "a" }, user("2"), user("3")]);
		const cases: Array<{ name: string; stored: string[]; incoming: string[]; want: boolean }> = [
			{ name: "stored prefix of a longer incoming array", stored: h.slice(0, 3), incoming: h, want: true },
			{ name: "identical arrays", stored: h, incoming: h, want: true },
			{ name: "empty stored is trivially linear", stored: [], incoming: h, want: true },
			{ name: "edited middle message", stored: [h[0], "deadbeefdeadbeef", h[2]], incoming: h, want: false },
			{ name: "stored longer than incoming (deletions)", stored: h, incoming: h.slice(0, 2), want: false },
			{ name: "reordered messages", stored: [h[1], h[0], h[2], h[3]], incoming: h, want: false },
		];
		for (const c of cases) expect(hashesArePrefix(c.stored, c.incoming), c.name).toBe(c.want);
	});
});

describe("unit: messages — R11 bounded seed rendering (host-agnostic lift)", () => {
	function user(parts: PromptContent): PromptMessage {
		return { role: "user", content: parts };
	}
	const seedHistory = (turns: number): PromptMessage[] => {
		const msgs: PromptMessage[] = [];
		for (let i = 0; i < turns; i++) {
			msgs.push(user(`question ${i}`));
			msgs.push({ role: "assistant", content: [{ type: "text", text: `answer ${i}` }] });
		}
		return msgs;
	};

	test("renders the last 20 text-bearing messages as User:/Assistant: lines inside the guarded block", () => {
		const { seed, warnings } = renderSeed(seedHistory(15)); // 30 text-bearing messages
		const lines = seed.split("\n");
		expect(lines[0]).toBe("--- Previous conversation (context restored after edits in the client) ---");
		expect(lines[lines.length - 1]).toBe("--- End of previous conversation ---");
		const rendered = lines.filter((l) => l.startsWith("User: ") || l.startsWith("Assistant: "));
		expect(rendered).toHaveLength(SEED_MAX_MESSAGES);
		expect(rendered[0]).toBe("User: question 5"); // last 20 of 30
		expect(rendered[rendered.length - 1]).toBe("Assistant: answer 14");
		expect(warnings).toEqual([]);
	});

	test("texts longer than SEED_MAX_CHARS are truncated to exactly 4000 chars", () => {
		const long = "x".repeat(SEED_MAX_CHARS + 500);
		const { seed } = renderSeed([user("q"), { role: "assistant", content: [{ type: "text", text: long }] }]);
		expect(seed).toContain(`Assistant: ${"x".repeat(SEED_MAX_CHARS)}\n`);
		expect(seed).not.toContain("x".repeat(SEED_MAX_CHARS + 1));
	});

	test("non-text parts are skipped with the existing warning text; textless messages are omitted", () => {
		const { seed, warnings } = renderSeed([
			user([{ type: "file", mediaType: "image/png", data: "bb" }]), // no text → omitted
			user([{ type: "text", text: "with tool" }, { type: "tool-result", toolCallId: "t" }]),
			{ role: "assistant", content: [{ type: "text", text: "kept" }] },
		]);
		expect(seed).toContain("User: with tool");
		expect(seed).toContain("Assistant: kept");
		expect(warnings.some((w) => w.includes("tool-result"))).toBe(true);
		expect(warnings.some((w) => w.includes("file"))).toBe(true);
	});

	test("no text-bearing messages → empty seed, non-text parts still warned", () => {
		const { seed, warnings } = renderSeed([user([{ type: "file", mediaType: "image/png", data: "bb" }])]);
		expect(seed).toBe("");
		expect(warnings).toHaveLength(1);
	});

	test("explicit k bound keeps only the last k text-bearing messages (seam used by host adapters)", () => {
		const { seed } = renderSeed(seedHistory(5), 4); // 10 text-bearing messages
		const rendered = seed
			.split("\n")
			.filter((l) => l.startsWith("User: ") || l.startsWith("Assistant: "));
		expect(rendered).toHaveLength(4);
		expect(rendered[0]).toBe("User: question 3");
		expect(rendered[rendered.length - 1]).toBe("Assistant: answer 4");
	});

	test("divergence helpers are exported from the package index (additive, R11)", () => {
		expect(messageHashesFromIndex).toBe(messageHashes);
		expect(hashesArePrefixFromIndex).toBe(hashesArePrefix);
		expect(renderSeedFromIndex).toBe(renderSeed);
	});
});
