/**
 * Unit tests for step-update narration (specs R3, R10): every live
 * step_update payload from agy's NDJSON stream renders as ONE compact
 * human-readable line (always \n-terminated) — tool ACTIVE/DONE/ERROR,
 * agent_response done/progress, user_input — while anything unexpected
 * (unknown step_type or state, missing tool_name, non-numeric duration,
 * hostile getters) degrades to the tolerant compact-JSON summary. Ported
 * from the proven opencode-adapter formatter; the function NEVER throws.
 */
import { describe, expect, test } from "bun:test";
import { formatStepUpdate } from "../src/progress";

describe("unit: progress — formatStepUpdate narration (R3, R10)", () => {
	test("tool ACTIVE narrates the tool name", () => {
		expect(formatStepUpdate({ step_type: "tool", state: "ACTIVE", tool_name: "ls" })).toBe("▸ tool ls…\n");
	});

	test("tool DONE with a finite duration renders it with one decimal", () => {
		expect(formatStepUpdate({ step_type: "tool", state: "DONE", tool_name: "grep", duration_seconds: 0.28 })).toBe(
			"✓ grep (0.3s)\n",
		);
	});

	test("tool DONE without a duration omits the parenthetical", () => {
		expect(formatStepUpdate({ step_type: "tool", state: "DONE", tool_name: "grep" })).toBe("✓ grep\n");
	});

	test("non-finite durations are treated as absent (NaN / Infinity)", () => {
		expect(formatStepUpdate({ step_type: "tool", state: "DONE", tool_name: "a", duration_seconds: NaN })).toBe("✓ a\n");
		expect(formatStepUpdate({ step_type: "tool", state: "DONE", tool_name: "b", duration_seconds: Infinity })).toBe(
			"✓ b\n",
		);
	});

	test("tool ERROR narrates the failure", () => {
		expect(formatStepUpdate({ step_type: "tool", state: "ERROR", tool_name: "edit_file" })).toBe("✗ edit_file failed\n");
	});

	test("tool with a missing/empty tool_name degrades to compact JSON", () => {
		const out = formatStepUpdate({ step_type: "tool", state: "ACTIVE" });
		expect(out).toBe(JSON.stringify({ step_type: "tool", state: "ACTIVE" }) + "\n");
	});

	test("unknown tool state degrades to compact JSON", () => {
		const step = { step_type: "tool", state: "WEIRD", tool_name: "ls" };
		expect(formatStepUpdate(step)).toBe(`${JSON.stringify(step)}\n`);
	});

	test("agent_response DONE with duration", () => {
		expect(formatStepUpdate({ step_type: "agent_response", state: "DONE", duration_seconds: 12.34 })).toBe(
			"● response (12.3s)\n",
		);
	});

	test("agent_response in any other state narrates progress", () => {
		expect(formatStepUpdate({ step_type: "agent_response", state: "ACTIVE" })).toBe("▸ response…\n");
	});

	test("user_input narrates the prompt", () => {
		expect(formatStepUpdate({ step_type: "user_input", state: "DONE" })).toBe("▸ prompt\n");
	});

	test("unknown step_type degrades to compact JSON of the payload", () => {
		const step = { step_type: "checkpoint", state: "DONE", checkpoint_id: "cp-1" };
		expect(formatStepUpdate(step)).toBe(`${JSON.stringify(step)}\n`);
	});

	test("empty payload degrades to the (step update) placeholder", () => {
		expect(formatStepUpdate({})).toBe("(step update)\n");
	});

	test("NEVER throws: hostile getters collapse to the placeholder", () => {
		const hostile: Record<string, unknown> = {};
		Object.defineProperty(hostile, "step_type", {
			get(): string {
				throw new Error("boom");
			},
			enumerable: true,
		});
		expect(formatStepUpdate(hostile)).toBe("(step update)\n");
	});
});
