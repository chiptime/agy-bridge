/**
 * Error-taxonomy mapping (spec R6). The engine decides WHAT happened; this
 * module decides what the provider tells opencode: retryability, the timeout
 * family's resume-once policy (a first timeout with a captured conversationId
 * may resume; the resume attempt failing again — or a timeout with no id — is
 * terminal and points at run.log), and user-facing guidance text.
 */
import type { Classification } from "agy-bridge-engine";

export interface ErrorContext {
	/** Absolute path of this run's log (always present; produced by the runtime). */
	logPath: string;
	/** Conversation id captured from the run's output, when one was seen. */
	conversationId?: string;
	/** True when THIS run was already the one resume attempt. */
	resumed?: boolean;
	/** Quota reset time from the pool decision (quota_unavailable). */
	resetTime?: string;
	/** agy's own error text (envelope error or log tail). */
	detail?: string;
}

export interface ErrorMapping {
	retryable: boolean;
	resume: boolean;
	message: string;
}

const withLog = (ctx: ErrorContext, text: string): string =>
	`${text} Full log: ${ctx.logPath}`;

/**
 * Map a failed run's Classification onto provider error semantics (R6 table):
 * ENOENT → install guidance; outage → retryable; timeout family → resume
 * exactly once via the captured conversationId, then terminal with the log
 * path; auth → re-auth guidance; quota → reset time; task failure → agy's
 * error text.
 */
export function mapClassification(c: Classification, ctx: ErrorContext): ErrorMapping {
	// ENOENT is engine-classified as transient_unavailable/agy_absent; the
	// adapter treats a missing binary as an install problem, not an outage.
	if (c.reason === "agy_absent") {
		return {
			retryable: false,
			resume: false,
			message: "agy is not installed or not on PATH — install agy to use this provider.",
		};
	}
	if (c.outcome === "transient_unavailable") {
		return { retryable: true, resume: false, message: "agy provider is temporarily unavailable" };
	}
	if (c.outcome === "timeout") {
		const canResume = !ctx.resumed && ctx.conversationId !== undefined;
		if (canResume) {
			return {
				retryable: false,
				resume: true,
				message: `agy timed out mid-turn; resuming conversation ${ctx.conversationId}`,
			};
		}
		return {
			retryable: false,
			resume: false,
			message: withLog(ctx, "agy timed out and could not be resumed"),
		};
	}
	if (c.outcome === "auth_captcha") {
		return {
			retryable: false,
			resume: false,
			message: withLog(ctx, "agy needs re-authentication — sign in again (run agy interactively)"),
		};
	}
	if (c.outcome === "quota_unavailable") {
		const reset = ctx.resetTime ? ` until ${ctx.resetTime}` : "";
		return {
			retryable: false,
			resume: false,
			message: withLog(ctx, `agy quota exhausted${reset}`),
		};
	}
	if (c.outcome === "task_failure") {
		return {
			retryable: false,
			resume: false,
			message: withLog(ctx, `agy task failed: ${ctx.detail ?? c.reason}`),
		};
	}
	// artifact_validation_failure — and any unmapped family, defensively.
	return {
		retryable: false,
		resume: false,
		message: withLog(ctx, `agy returned an empty or invalid response (${c.reason})`),
	};
}
