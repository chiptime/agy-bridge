/**
 * Prompt reduction for agy turns (spec R5). agy owns the conversation, so the
 * adapter sends ONLY the last user turn; the system prompt is prepended
 * exactly once and only when the conversation is new (continuing runs resume
 * server-side state). Non-text parts cannot be forwarded to a CLI model
 * process and are dropped with a warning instead of silently vanishing.
 *
 * Structural types: intentionally compatible with both LanguageModelV2 and
 * LanguageModelV3 prompt messages; the runtime wires the real provider types
 * in language-model.ts.
 */
export interface PromptTextPart {
	type: "text";
	text: string;
	[key: string]: unknown;
}
export interface PromptPart {
	type: string;
	[key: string]: unknown;
}
export type PromptContent = string | PromptPart[];
export interface PromptMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: PromptContent;
}

export interface PromptMapping {
	prompt: string;
	warnings: string[];
}

function isTextPart(p: PromptPart): p is PromptTextPart {
	return p.type === "text" && typeof p["text"] === "string";
}

/**
 * Reduce a provider prompt to what agy should receive:
 * - prompt = the LAST user message's text parts, joined with newlines;
 * - system text is prepended (once, separated by a blank line) only when
 *   opts.isNewConversation is true;
 * - every non-text part inside the last user turn is dropped with a warning;
 * - history turns (assistant/tool/earlier user) are dropped by design.
 */
export function mapMessages(
	messages: PromptMessage[],
	opts: { isNewConversation: boolean },
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

	const prompt =
		opts.isNewConversation && systemText !== "" ? `${systemText}\n\n${userText}` : userText;
	return { prompt, warnings };
}
