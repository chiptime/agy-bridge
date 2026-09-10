/**
 * Error-taxonomy mapping for pi (specs R3, R8). The engine decides WHAT
 * happened (classifyRun); this module decides how the failure finalizes a
 * pi turn — the AssistantMessageEventStream error terminal
 * ({type:"error", reason:"error"|"aborted"}) — plus the retryability the
 * host can act on, the timeout family's resume-once marker
 * (resumeEligible + the run.log path), and user-facing guidance text.
 * The resume ORCHESTRATION itself lives in turn.ts (R8); this table only
 * tags eligibility. Abort is not a classification (it is a host signal),
 * so it gets its own mapping: the tapped child was SIGTERMed and the
 * stream finalizes reason "aborted" (design §6).
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

/** Reason field of the stream's {type:"error"} terminal: engine failures finalize "error"; an abort finalizes "aborted". */
export type FinalizeReason = "error" | "aborted";

export interface ErrorMapping {
	/** Host retry semantics: true means the turn may simply be re-run. */
	retryable: boolean;
	/** R8 resume-once: a first timeout with a captured conversationId may resume via --conversation exactly once. */
	resumeEligible: boolean;
	/** The reason of the pi error terminal this mapping finalizes with. */
	finalize: FinalizeReason;
	message: string;
}

const withLog = (ctx: ErrorContext, text: string): string =>
	`${text} Full log: ${ctx.logPath}`;

/**
 * Map a failed run's Classification onto pi error semantics: ENOENT →
 * install guidance; outage → retryable; timeout family → resume exactly
 * once via the captured conversationId, then terminal with the log path;
 * auth → re-auth guidance; quota → reset time; task failure → agy's
 * error text.
 */
export function mapClassification(c: Classification, ctx: ErrorContext): ErrorMapping {
	// ENOENT is engine-classified as transient_unavailable/agy_absent; the
	// adapter treats a missing binary as an install problem, not an outage.
	if (c.reason === "agy_absent") {
		return {
			retryable: false,
			resumeEligible: false,
			finalize: "error",
			message: "agy is not installed or not on PATH — install agy to use this provider.",
		};
	}
	if (c.outcome === "transient_unavailable") {
		return { retryable: true, resumeEligible: false, finalize: "error", message: "agy provider is temporarily unavailable" };
	}
	if (c.outcome === "timeout") {
		const resumeEligible = !ctx.resumed && ctx.conversationId !== undefined;
		if (resumeEligible) {
			return {
				retryable: false,
				resumeEligible: true,
				finalize: "error",
				message: `agy timed out mid-turn; resuming conversation ${ctx.conversationId}`,
			};
		}
		return {
			retryable: false,
			resumeEligible: false,
			finalize: "error",
			message: withLog(ctx, "agy timed out and could not be resumed"),
		};
	}
	if (c.outcome === "auth_captcha") {
		return {
			retryable: false,
			resumeEligible: false,
			finalize: "error",
			message: withLog(ctx, "agy needs re-authentication — sign in again (run agy interactively)"),
		};
	}
	if (c.outcome === "quota_unavailable") {
		const reset = ctx.resetTime ? ` until ${ctx.resetTime}` : "";
		return {
			retryable: false,
			resumeEligible: false,
			finalize: "error",
			message: withLog(ctx, `agy quota exhausted${reset}`),
		};
	}
	if (c.outcome === "task_failure") {
		return {
			retryable: false,
			resumeEligible: false,
			finalize: "error",
			message: withLog(ctx, `agy task failed: ${ctx.detail ?? c.reason}`),
		};
	}
	// artifact_validation_failure — and any unmapped family, defensively.
	return {
		retryable: false,
		resumeEligible: false,
		finalize: "error",
		message: withLog(ctx, `agy returned an empty or invalid response (${c.reason})`),
	};
}

/**
 * Abort mapping (R3, design §6): options.signal SIGTERMed the child; the
 * tapped conversationId was already persisted via store.bind. The stream
 * finalizes {type:"error", reason:"aborted"} — never retryable, never
 * resume-eligible (the user cancelled).
 */
export function mapAbort(): ErrorMapping {
	return {
		retryable: false,
		resumeEligible: false,
		finalize: "aborted",
		message: "agy turn aborted",
	};
}
