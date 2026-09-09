/**
 * Prompt reduction for agy turns (spec R5). agy owns the conversation, so the
 * adapter sends ONLY the last user turn; the system prompt is prepended
 * exactly once and only when the conversation is new (continuing runs resume
 * server-side state). Non-text parts cannot be forwarded to a CLI model
 * process and are dropped with a warning instead of silently vanishing.
 *
 * v1.1 divergence detection: because opencode re-sends the FULL message
 * array every turn, the adapter can compare what it is about to forward
 * against what it already forwarded (per-message hashes) and detect when the
 * visible thread was edited/deleted/reordered — in which case the prompt
 * becomes a bounded SEED of the visible thread and a FRESH agy conversation
 * is started (turn.ts owns that decision; this module owns hashing and seed
 * rendering).
 *
 * Structural types: intentionally compatible with both LanguageModelV2 and
 * LanguageModelV3 prompt messages; the runtime wires the real provider types
 * in language-model.ts.
 */
import { createHash } from "node:crypto";

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

/**
 * Seed-rendering bounds (v1.1): at most the last 20 text-bearing messages
 * are rendered, and each rendered text is truncated to 4000 chars. Bounds
 * keep a pathological visible thread (hundreds of huge messages) from
 * producing an unbounded prompt for the re-seeded turn.
 */
export const SEED_MAX_MESSAGES = 20;
export const SEED_MAX_CHARS = 4000;

const SEED_HEADER = "--- Previous conversation (context restored after edits in the client) ---";
const SEED_FOOTER = "--- End of previous conversation ---";

function isTextPart(p: PromptPart): p is PromptTextPart {
	return p.type === "text" && typeof p["text"] === "string";
}

/**
 * Ordered per-message identity of the forwarded prompt array (v1.1): the
 * first 16 hex chars of sha256(JSON.stringify(message)). Deliberately
 * byte-level conservative — ANY change to a message (text, part order,
 * metadata) yields a different hash and therefore counts as divergence.
 */
export function messageHashes(messages: PromptMessage[]): string[] {
	return messages.map((m) => createHash("sha256").update(JSON.stringify(m)).digest("hex").slice(0, 16));
}

/**
 * Linear-continuation check (v1.1): true when the stored baseline hashes are
 * an element-wise PREFIX of the incoming hashes. Empty stored hashes are
 * trivially linear; a stored array longer than the incoming one means
 * messages were deleted, which is divergence.
 */
export function hashesArePrefix(stored: string[], incoming: string[]): boolean {
	if (stored.length > incoming.length) return false;
	return stored.every((h, i) => h === incoming[i]);
}

/**
 * Render the visible thread for a re-seeded turn (v1.1): the last `k`
 * (default SEED_MAX_MESSAGES) text-bearing user/assistant messages as
 * "User: …"/"Assistant: …" lines inside a guarded block, each text truncated
 * to SEED_MAX_CHARS. System and tool messages are skipped (the system text
 * is prepended separately by mapMessages); non-text parts are dropped with
 * the existing warning text, pointed at the seeded history. Returns an empty
 * seed when no history message carries text.
 */
export function renderSeed(
	messages: PromptMessage[],
	k: number = SEED_MAX_MESSAGES,
): { seed: string; warnings: string[] } {
	const warnings: string[] = [];
	const rendered: Array<{ label: "User" | "Assistant"; text: string }> = [];
	for (const m of messages) {
		if (m.role !== "user" && m.role !== "assistant") continue;
		const texts: string[] = [];
		if (typeof m.content === "string") {
			texts.push(m.content);
		} else if (Array.isArray(m.content)) {
			for (const part of m.content) {
				if (isTextPart(part)) texts.push(part.text);
				else warnings.push(`dropped non-text part (type: ${String(part?.type)}) from a seeded history message`);
			}
		}
		const text = texts.join("\n");
		if (text === "") continue;
		rendered.push({
			label: m.role === "user" ? "User" : "Assistant",
			text: text.length > SEED_MAX_CHARS ? text.slice(0, SEED_MAX_CHARS) : text,
		});
	}
	const kept = rendered.slice(-k);
	if (kept.length === 0) return { seed: "", warnings };
	const body = kept.map((r) => `${r.label}: ${r.text}`).join("\n");
	return { seed: `${SEED_HEADER}\n${body}\n${SEED_FOOTER}`, warnings };
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
