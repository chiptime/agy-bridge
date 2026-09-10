/**
 * Unit tests for pi prompt mapping (spec R4, R7): pi hands the provider a
 * Context (systemPrompt + full visible thread); agy owns the conversation,
 * so the prompt reduces to the LAST user turn, the system text is prepended
 * exactly ONCE and only on a new conversation, and the divergence re-seed
 * block (engine renderSeed, rendered by the stream layer) sits BETWEEN the
 * system text and the user turn. Non-text parts (images) cannot reach a CLI
 * model process and are dropped with a warning. toPromptMessages adapts
 * pi's Message union onto the engine's PromptMessage shape (toolResult →
 * "tool") so messageHashes/renderSeed operate on the incoming history.
 */
import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Context, Message, UserMessage } from "@earendil-works/pi-ai";
import { messageHashes } from "agy-bridge-engine";
import { mapPiPrompt, toPromptMessages } from "../src/messages";

function userMsg(content: UserMessage["content"], timestamp = 1): UserMessage {
	return { role: "user", content, timestamp };
}

function assistantMsg(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "pi-messages",
		provider: "agy",
		model: "default",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

function toolResultMsg(text: string): Message {
	return {
		role: "toolResult",
		toolCallId: "tc-1",
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	};
}

describe("unit: messages — pi Context → agy prompt (R4)", () => {
	test("reduces to the LAST user turn: earlier user and assistant turns are dropped", () => {
		const context: Context = {
			messages: [
				userMsg("first question"),
				assistantMsg("first answer"),
				userMsg([{ type: "text", text: "second" }, { type: "text", text: "question" }]),
			],
		};
		const { prompt, warnings } = mapPiPrompt(context, { isNewConversation: true });
		expect(prompt).toBe("second\nquestion");
		expect(warnings).toEqual([]);
	});

	test("string user content passes through verbatim", () => {
		const context: Context = { messages: [userMsg("plain hello")] };
		const { prompt } = mapPiPrompt(context, { isNewConversation: false });
		expect(prompt).toBe("plain hello");
	});

	test("new conversation: system prompt is prepended once, blank-line separated", () => {
		const context: Context = { systemPrompt: "You are agy.", messages: [userMsg("hi")] };
		const { prompt } = mapPiPrompt(context, { isNewConversation: true });
		expect(prompt).toBe("You are agy.\n\nhi");
	});

	test("continuing conversation: system prompt is NOT prepended", () => {
		const context: Context = { systemPrompt: "You are agy.", messages: [userMsg("hi")] };
		const { prompt } = mapPiPrompt(context, { isNewConversation: false });
		expect(prompt).toBe("hi");
		expect(prompt).not.toContain("You are agy.");
	});

	test("re-seed block sits BETWEEN the system text and the user turn", () => {
		const seed = "--- Previous conversation ---\nUser: a\nAssistant: b\n--- End ---";
		const context: Context = { systemPrompt: "SYS", messages: [userMsg("turn")] };
		const { prompt } = mapPiPrompt(context, { isNewConversation: true, seed });
		const sysAt = prompt.indexOf("SYS");
		const seedAt = prompt.indexOf("User: a");
		const userAt = prompt.indexOf("turn");
		expect(sysAt).toBeGreaterThanOrEqual(0);
		expect(seedAt).toBeGreaterThan(sysAt);
		expect(userAt).toBeGreaterThan(seedAt);
	});

	test("seed without system text: seed directly precedes the user turn", () => {
		const context: Context = { messages: [userMsg("turn")] };
		const { prompt } = mapPiPrompt(context, { isNewConversation: true, seed: "SEED-BLOCK" });
		expect(prompt).toBe("SEED-BLOCK\n\nturn");
	});

	test("non-text part in the last user turn is dropped with a warning naming the type", () => {
		const context: Context = {
			messages: [userMsg([{ type: "text", text: "look" }, { type: "image", data: "b64", mimeType: "image/png" }])],
		};
		const { prompt, warnings } = mapPiPrompt(context, { isNewConversation: false });
		expect(prompt).toBe("look");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("image");
	});

	test("last user turn with NO text parts: warning issued, other sections still compose", () => {
		const context: Context = {
			systemPrompt: "SYS",
			messages: [userMsg([{ type: "image", data: "b64", mimeType: "image/png" }])],
		};
		const { prompt, warnings } = mapPiPrompt(context, { isNewConversation: true });
		expect(prompt).toBe("SYS");
		expect(warnings.some((w) => w.includes("no text parts"))).toBe(true);
	});

	test("empty system prompt is treated as absent (no leading blank block)", () => {
		const context: Context = { systemPrompt: "   ", messages: [userMsg("hi")] };
		const { prompt } = mapPiPrompt(context, { isNewConversation: true });
		expect(prompt).toBe("hi");
	});

	test("empty seed is skipped", () => {
		const context: Context = { messages: [userMsg("hi")] };
		const { prompt } = mapPiPrompt(context, { isNewConversation: true, seed: "" });
		expect(prompt).toBe("hi");
	});
});

describe("unit: messages — toPromptMessages (pi Message union → engine PromptMessage)", () => {
	test("toolResult maps to role 'tool'; user/assistant pass through", () => {
		const converted = toPromptMessages([userMsg("q"), assistantMsg("a"), toolResultMsg("out")]);
		expect(converted.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
		expect(converted[0].content).toBe("q");
		expect(converted[2].content).toEqual([{ type: "text", text: "out" }]);
	});

	test("one hash per message, in order (feeds the divergence baseline)", () => {
		const converted = toPromptMessages([userMsg("q1"), assistantMsg("a1"), userMsg("q2")]);
		const hashes = messageHashes(converted);
		expect(hashes).toHaveLength(3);
		expect(new Set(hashes).size).toBe(3);
	});
});
