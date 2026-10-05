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
	/**
	 * True when the reported failure IS this call's one recovery attempt
	 * (timeout-recovery PRD slice 2): the caller (turn.ts) already spent the
	 * call's recovery budget and this classification is that attempt's own
	 * outcome. Computed once in turn.ts — this module never re-derives
	 * recovery eligibility from `resumed` alone, which conflates ordinary
	 * conversation continuation (D5/R7) with recovery-budget consumption.
	 */
	recoveryAttempted?: boolean;
	/**
	 * True when recovery was never attempted specifically because this
	 * call's initial attempt continued an existing conversation and the
	 * slice-3 safety restriction (no verified evidence of agy CLI
	 * interrupted-turn resume semantics) currently blocks automatic
	 * recovery for that case. Lets the terminal message name a policy
	 * decision instead of implying an attempt was made and failed.
	 */
	recoveryBlockedByPolicy?: boolean;
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
	if (c.outcome === "termination_unconfirmed") {
		// Bounded-termination chain forced settlement: the child ignored
		// SIGTERM and SIGKILL (or every kill attempt threw) and never
		// confirmed death before the settle deadline. Checked BEFORE the
		// timeout family: without this branch the outcome would silently
		// fall through to the unmapped-family message below. Never retryable
		// (the host cannot know what state the remote conversation is in)
		// and never resumable — the honest report names the trigger, the
		// unconfirmed local termination, and the partial-side-effects risk.
		const trigger = c.reason.startsWith("termination_unconfirmed_")
			? c.reason.slice("termination_unconfirmed_".length)
			: "unknown";
		return {
			retryable: false,
			resume: false,
			message: withLog(
				ctx,
				`agy termination could not be confirmed locally (trigger: ${trigger}) — the process ignored every termination signal, remote work may still be running, and side effects may be partial`,
			),
		};
	}
	if (c.outcome === "timeout") {
		// Honest, distinct denial reasons (timeout-recovery PRD slice 2,
		// "Actionable terminal errors"): turn.ts is the single source of
		// truth for WHY recovery did or did not happen — these two ctx
		// facts are consumed here, never re-derived from `resumed`, which
		// is true both for an ordinary continuation's very first attempt
		// AND for the recovery attempt itself and therefore cannot tell
		// them apart on its own.
		if (ctx.recoveryAttempted) {
			// This call already spent its one recovery attempt and THIS
			// classification is that attempt's own failure. A second
			// timeout never authorizes a third spawn.
			return {
				retryable: false,
				resume: false,
				message: withLog(
					ctx,
					"agy timed out and could not be resumed — the one recovery attempt already ran and failed",
				),
			};
		}
		if (ctx.recoveryBlockedByPolicy) {
			// Recovery was never attempted: this call continued an existing
			// conversation, and automatic recovery for that case is
			// restricted pending verified agy CLI resume-safety evidence
			// (timeout-recovery PRD slice 3). Never phrase this as an
			// attempted-and-failed resume.
			return {
				retryable: false,
				resume: false,
				message: withLog(
					ctx,
					"agy timed out and could not be resumed — automatic recovery is currently restricted to new conversations pending verified agy CLI resume safety (timeout-recovery PRD slice 3)",
				),
			};
		}
		const canResume = !ctx.resumed && ctx.conversationId !== undefined;
		if (canResume) {
			return {
				retryable: false,
				resume: true,
				message: `agy timed out mid-turn; resuming conversation ${ctx.conversationId}`,
			};
		}
		if (ctx.conversationId === undefined) {
			return {
				retryable: false,
				resume: false,
				message: withLog(ctx, "agy timed out and could not be resumed — no usable conversation id was captured"),
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
		if (c.reason === "interrupted" || ctx.detail === "interrupted") {
			return {
				retryable: false,
				resume: true,
				message: withLog(
					ctx,
					"agy turn was interrupted internally by agy; send another prompt or 'continue' to resume this conversation",
				),
			};
		}
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
