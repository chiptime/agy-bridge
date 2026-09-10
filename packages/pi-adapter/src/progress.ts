/**
 * Step-update narration for pi progress (specs R3, R10): one live
 * step_update payload from agy's NDJSON stream → ONE compact
 * human-readable line (always \n-terminated) surfaced as a thinking delta
 * in the stream bridge (stream-simple.ts) and readable via onUpdate on
 * long delegations. Anything unexpected — unknown step_type or state,
 * missing tool_name, non-numeric duration, hostile getters — degrades to
 * the tolerant compact-JSON summary; this function NEVER throws. Ported
 * verbatim in behavior from the proven opencode-adapter formatter.
 */

/** Compact-JSON tail; guarded so the formatter can never throw, even on
 *  hostile payloads (a throwing getter inside JSON.stringify is caught). */
function fallbackSummary(step: Record<string, unknown>): string {
	try {
		const compact = JSON.stringify(step);
		return `${compact === "{}" ? "(step update)" : compact}\n`;
	} catch {
		return "(step update)\n";
	}
}

/** Finite duration rendered with exactly one decimal ("0.28" → "0.3s"). */
function duration1s(durationSeconds: number): string {
	return `${durationSeconds.toFixed(1)}s`;
}

/**
 * One live step_update payload → a human-readable progress line (always
 * \n-terminated): tool start/done/error, response done/progress, prompt.
 * Anything unexpected degrades to the tolerant compact-JSON summary; this
 * function NEVER throws.
 */
export function formatStepUpdate(step: Record<string, unknown>): string {
	try {
		const stepType = step["step_type"];
		const state = step["state"];
		const toolName = step["tool_name"];
		const rawDuration = step["duration_seconds"];
		const duration = typeof rawDuration === "number" && Number.isFinite(rawDuration) ? rawDuration : undefined;
		if (stepType === "tool") {
			if (typeof toolName !== "string" || toolName === "") return fallbackSummary(step);
			if (state === "ACTIVE") return `▸ tool ${toolName}…\n`;
			if (state === "DONE") return duration !== undefined ? `✓ ${toolName} (${duration1s(duration)})\n` : `✓ ${toolName}\n`;
			if (state === "ERROR") return `✗ ${toolName} failed\n`;
			return fallbackSummary(step);
		}
		if (stepType === "agent_response") {
			if (state === "DONE") return duration !== undefined ? `● response (${duration1s(duration)})\n` : "● response\n";
			return "▸ response…\n";
		}
		if (stepType === "user_input") {
			return "▸ prompt\n";
		}
		return fallbackSummary(step);
	} catch {
		return fallbackSummary(step);
	}
}
