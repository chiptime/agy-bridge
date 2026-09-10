/**
 * Prompt reduction for agy turns (spec R5). agy owns the conversation, so the
 * adapter sends ONLY the last user turn; the system prompt is prepended
 * exactly once and only when the conversation is new (continuing runs resume
 * server-side state). Non-text parts cannot be forwarded to a CLI model
 * process and are dropped with a warning instead of silently vanishing.
 *
 * v1.1 divergence helpers live in the engine since the R11 lift
 * (packages/engine/src/messages.ts): messageHashes, hashesArePrefix,
 * renderSeed, the SEED_MAX_* bounds, and the Prompt* structural types. This
 * module RE-EXPORTS them so every existing importer compiles untouched; only
 * host-specific reduction (mapMessages, PromptMapping) is defined here.
 */
import { isTextPart, type PromptMessage } from "agy-bridge-engine";

export {
	messageHashes,
	hashesArePrefix,
	renderSeed,
	SEED_MAX_MESSAGES,
	SEED_MAX_CHARS,
} from "agy-bridge-engine";
export type {
	PromptTextPart,
	PromptPart,
	PromptContent,
	PromptMessage,
} from "agy-bridge-engine";

export interface PromptMapping {
	prompt: string;
	warnings: string[];
}

/**
 * Reduce a provider prompt to what agy should receive:
 * - prompt = the LAST user message's text parts, joined with newlines;
 * - system text is prepended (once, separated by a blank line) only when
 *   opts.isNewConversation is true;
 * - a non-empty opts.seed (v1.1 re-seeding) is inserted between the system
 *   text and the last user turn, blank-line separated — callers pair it
 *   with isNewConversation because a re-seed always starts a FRESH agy
 *   conversation;
 * - every non-text part inside the last user turn is dropped with a warning;
 * - history turns (assistant/tool/earlier user) are dropped by design.
 */
export function mapMessages(
	messages: PromptMessage[],
	opts: { isNewConversation: boolean; seed?: string },
): PromptMapping {
	const warnings: string[] = [];
	const systemText = messages
		.filter((m) => m.role === "system")
		.map((m) => (typeof m.content === "string" ? m.content.trim() : ""))
		.filter((s) => s !== "")
		.join("\n\n");

	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	let userText = "";
	if (typeof lastUser?.content === "string") {
		userText = lastUser.content;
	} else if (Array.isArray(lastUser?.content)) {
		const texts: string[] = [];
		for (const part of lastUser.content) {
			if (isTextPart(part)) {
				texts.push(part.text);
			} else {
				warnings.push(`dropped non-text part (type: ${String(part?.type)}) from the last user turn`);
			}
		}
		if (texts.length === 0) warnings.push("last user turn has no text parts");
		userText = texts.join("\n");
	}

	const sections: string[] = [];
	if (opts.isNewConversation && systemText !== "") sections.push(systemText);
	if (opts.seed !== undefined && opts.seed !== "") sections.push(opts.seed);
	sections.push(userText);
	return { prompt: sections.join("\n\n"), warnings };
}
