/**
 * Host-agnostic divergence helpers (engine lift, R11): ordered per-message
 * content hashes, linear-continuation (prefix) detection against a stored
 * baseline, and bounded seed rendering for the re-seeded turn that follows
 * client-side history edits. Host adapters (opencode, pi) import these;
 * host-specific prompt reduction (mapMessages and friends) stays in each
 * adapter package. Nothing here may import a host adapter.
 *
 * Structural types: intentionally compatible with both LanguageModelV2 and
 * LanguageModelV3 prompt messages; hosts wire their real provider types in.
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

/**
 * Compact placeholder for image parts in seeded history (spec image-input
 * R5, design D6): prior image context must be represented so it is not
 * silently dropped, but NEVER re-embedded as raw payloads.
 */
const IMAGE_SEED_PLACEHOLDER = "[user attached an image — not re-embedded]";

export function isTextPart(p: PromptPart): p is PromptTextPart {
	return p.type === "text" && typeof p["text"] === "string";
}

/**
 * Shape-tolerant image detection for seeded history (design D6): a part is
 * an image when its type says so OR its mediaType starts with "image/" —
 * hosts deliver slightly different part shapes for the same attachment.
 */
function isImagePart(p: PromptPart): boolean {
	if (p.type === "image" || p.type === "image-url") return true;
	const mt = p["mediaType"];
	return typeof mt === "string" && mt.toLowerCase().startsWith("image/");
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
 * to SEED_MAX_CHARS. System and tool messages are skipped (the host prepends
 * the system text separately). Image parts render the compact placeholder
 * (design D6, spec image-input R5) — the placeholder counts as content, so
 * an image-only turn still appears in the seed; other non-text parts are
 * dropped with a warning, pointed at the seeded history. Returns an empty
 * seed when no history message carries text or an image.
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
				else if (isImagePart(part)) texts.push(IMAGE_SEED_PLACEHOLDER);
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
