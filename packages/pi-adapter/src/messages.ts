/**
 * Prompt mapping for pi turns (spec R4): pi hands the provider a Context
 * (a systemPrompt field plus the FULL visible thread every turn); agy owns
 * the conversation, so the adapter sends ONLY the last user turn, the
 * system text is prepended exactly once and only when the conversation is
 * new (continuing runs resume server-side state), and the divergence
 * re-seed block (engine renderSeed, rendered by the stream layer from the
 * incoming history) is inserted between the system text and the user turn.
 * Non-text parts (images) cannot be forwarded to a CLI model process and
 * are dropped with a warning instead of silently vanishing.
 *
 * toPromptMessages adapts pi's Message union onto the engine's
 * PromptMessage shape (toolResult → role "tool") so the lifted divergence
 * helpers (messageHashes / hashesArePrefix / renderSeed) operate on the
 * same array the hashes were derived from.
 */
import { isTextPart, type PromptContent, type PromptMessage, type PromptPart } from "agy-bridge-engine";
import type { Context, Message } from "@earendil-works/pi-ai";

export interface PiPromptMapping {
	prompt: string;
	warnings: string[];
}

/**
 * pi Message[] → engine PromptMessage[]: user/assistant pass through
 * structurally; toolResult narrows to the engine's "tool" role with its
 * content blocks intact (hash identity only needs role + content).
 */
export function toPromptMessages(messages: readonly Message[]): PromptMessage[] {
	// Content needs a boundary cast: pi's content parts are closed unions
	// without index signatures, while PromptPart is an open {type: string}
	// shape. Only role + content are read downstream (hashing and seed
	// rendering), and renderSeed re-validates text parts at runtime.
	return messages.map((m) =>
		m.role === "toolResult"
			? { role: "tool" as const, content: m.content as unknown as PromptContent }
			: { role: m.role, content: m.content as unknown as PromptContent },
	);
}

/**
 * Reduce a pi Context to what agy should receive:
 * - prompt = the LAST user message's text parts, joined with newlines;
 * - the system text (context.systemPrompt) is prepended (blank-line
 *   separated) only when opts.isNewConversation is true;
 * - a non-empty opts.seed (R7 re-seeding) is inserted between the system
 *   text and the last user turn — callers pair it with isNewConversation
 *   because a re-seed always starts a FRESH agy conversation;
 * - every non-text part inside the last user turn is dropped with a
 *   warning; a text-less last user turn warns too;
 * - history turns (assistant/toolResult/earlier user) are dropped by
 *   design.
 */
export function mapPiPrompt(
	context: Context,
	opts: { isNewConversation: boolean; seed?: string },
): PiPromptMapping {
	const warnings: string[] = [];
	const systemText = context.systemPrompt?.trim() ?? "";

	const lastUser = [...context.messages].reverse().find((m) => m.role === "user");
	let userText = "";
	if (lastUser !== undefined) {
		// Boundary cast (mirrors the opencode adapter): pi's content parts are
		// a closed union without index signatures; the text guard below
		// validates shapes at runtime.
		const content = lastUser.content as PromptContent;
		if (typeof content === "string") {
			userText = content;
		} else {
			const texts: string[] = [];
			for (const part of content as PromptPart[]) {
				if (isTextPart(part)) {
					texts.push(part.text);
				} else {
					warnings.push(`dropped non-text part (type: ${String(part?.type)}) from the last user turn`);
				}
			}
			if (texts.length === 0) warnings.push("last user turn has no text parts");
			userText = texts.join("\n");
		}
	}

	const sections: string[] = [];
	if (opts.isNewConversation && systemText !== "") sections.push(systemText);
	if (opts.seed !== undefined && opts.seed !== "") sections.push(opts.seed);
	// Unlike the opencode sibling, an empty user section is skipped too: a
	// text-less last turn must not leave trailing blank separators after the
	// system/seed blocks.
	if (userText !== "") sections.push(userText);
	return { prompt: sections.join("\n\n"), warnings };
}
