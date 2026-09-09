/**
 * Unit tests for error-taxonomy mapping (spec R6): every classifyRun family
 * maps to provider behavior — ENOENT guidance, retryable outage, the timeout
 * family's resume-once semantics (second failure non-retryable with the
 * run.log path), auth guidance, quota resetTime, and agy error text.
 */
import { describe, expect, test } from "bun:test";
import { mapClassification } from "../src/errors";
import type { Classification } from "agy-bridge-engine";

const ctx = { logPath: "/w/run.log" };

describe("unit: errors — classifyRun family to provider semantics", () => {
	test("ENOENT (agy_absent): non-retryable, no resume, install guidance", () => {
		const m = mapClassification({ outcome: "transient_unavailable", reason: "agy_absent" }, ctx);
		expect(m.retryable).toBe(false);
		expect(m.resume).toBe(false);
		expect(m.message).toMatch(/install agy/i);
	});

	test("provider outage: retryable", () => {
		const m = mapClassification({ outcome: "transient_unavailable", reason: "provider_outage" }, ctx);
		expect(m.retryable).toBe(true);
		expect(m.resume).toBe(false);
	});

	test.each(["timeout", "stall_detected", "agy_print_wait_timeout"])(
		"timeout family (%s): first failure with a captured conversationId maps to resume-once",
		(reason) => {
			const m = mapClassification({ outcome: "timeout", reason } as Classification, {
				...ctx,
				conversationId: "conv-1",
			});
			expect(m.resume).toBe(true);
			expect(m.retryable).toBe(false);
			expect(m.message).toContain("conv-1");
		},
	);

	test("timeout on the resume attempt: non-retryable, message carries the run.log path", () => {
		const m = mapClassification({ outcome: "timeout", reason: "agy_print_wait_timeout" }, {
			...ctx,
			conversationId: "conv-1",
			resumed: true,
		});
		expect(m.resume).toBe(false);
		expect(m.retryable).toBe(false);
		expect(m.message).toContain("/w/run.log");
	});

	test("timeout without a captured conversationId cannot resume: non-retryable with log path", () => {
		const m = mapClassification({ outcome: "timeout", reason: "timeout" }, ctx);
		expect(m.resume).toBe(false);
		expect(m.retryable).toBe(false);
		expect(m.message).toContain("/w/run.log");
	});

	test("auth_captcha: non-retryable with re-auth guidance", () => {
		const m = mapClassification({ outcome: "auth_captcha", reason: "auth_or_captcha" }, ctx);
		expect(m.retryable).toBe(false);
		expect(m.resume).toBe(false);
		expect(m.message).toMatch(/re-auth|sign in|authenticate/i);
	});

	test("quota_unavailable: non-retryable, message includes the reset time", () => {
		const m = mapClassification({ outcome: "quota_unavailable", reason: "quota_exhausted" }, {
			...ctx,
			resetTime: "2026-09-09T14:00:00Z",
		});
		expect(m.retryable).toBe(false);
		expect(m.message).toContain("2026-09-09T14:00:00Z");
	});

	test("task_failure: non-retryable, message carries the agy error text", () => {
		const m = mapClassification({ outcome: "task_failure", reason: "nonzero_exit" }, {
			...ctx,
			detail: "agy failed to plan the task",
		});
		expect(m.retryable).toBe(false);
		expect(m.resume).toBe(false);
		expect(m.message).toContain("agy failed to plan the task");
	});

	test("artifact_validation_failure: non-retryable validation message", () => {
		const m = mapClassification(
			{ outcome: "artifact_validation_failure", reason: "artifact_missing_or_empty" },
			ctx,
		);
		expect(m.retryable).toBe(false);
		expect(m.resume).toBe(false);
		expect(m.message).toMatch(/empty|invalid/i);
	});
});
