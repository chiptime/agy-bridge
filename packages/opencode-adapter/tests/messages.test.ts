/**
 * Unit tests for prompt reduction (spec R5.s1–s3): a 5-turn history reduces
 * to the last user turn only, the system prompt is prepended exactly once and
 * only for new conversations, and non-text parts are dropped with warnings.
 */
import { describe, expect, test } from "bun:test";
import { mapMessages, type PromptContent, type PromptMessage } from "../src/messages";

function user(parts: PromptContent): PromptMessage {
	return { role: "user", content: parts };
}

describe("unit: messages — prompt reduction", () => {
	test("R5.s1: 5-turn history maps to the LAST user turn only", () => {
		const history: PromptMessage[] = [
			{ role: "system", content: "sys" },
			user("turn one question"),
			{ role: "assistant", content: [{ type: "text", text: "turn one answer" }] },
			user("turn two question"),
			{ role: "assistant", content: [{ type: "text", text: "turn two answer" }] },
			user("the final question"),
		];
		const { prompt, warnings } = mapMessages(history, { isNewConversation: false });
		expect(prompt).toBe("the final question");
		expect(warnings).toEqual([]);
	});

	test("R5.s2: new conversation prepends the system prompt exactly once", () => {
		const messages: PromptMessage[] = [
			{ role: "system", content: "You are terse." },
			user("hello"),
		];
		const { prompt } = mapMessages(messages, { isNewConversation: true });
		expect(prompt).toBe("You are terse.\n\nhello");
		expect(prompt.match(/You are terse\./g)?.length).toBe(1);
	});

	test("R5.s2 (negative): continuing conversation omits the system prompt entirely", () => {
		const messages: PromptMessage[] = [
			{ role: "system", content: "You are terse." },
			user("hello again"),
		];
		const { prompt } = mapMessages(messages, { isNewConversation: false });
		expect(prompt).toBe("hello again");
	});

	test("R5.s3: tool and file parts in the last user turn are dropped with warnings", () => {
		const messages: PromptMessage[] = [
			user([
				{ type: "text", text: "look at this" },
				{ type: "tool-result", toolCallId: "t1", output: { kind: "text", value: "x" } },
				{ type: "file", mediaType: "image/png", data: "bb" },
			]),
		];
		const { prompt, warnings } = mapMessages(messages, { isNewConversation: false });
		expect(prompt).toBe("look at this");
		expect(warnings.length).toBe(2);
		expect(warnings[0]).toContain("tool-result");
		expect(warnings[1]).toContain("file");
	});

	test("multiple text parts in the last user turn are concatenated with newlines", () => {
		const { prompt } = mapMessages(
			[user([{ type: "text", text: "part one" }, { type: "text", text: "part two" }])],
			{ isNewConversation: false },
		);
		expect(prompt).toBe("part one\npart two");
	});

	test("a last user turn with no text at all yields an empty prompt plus a warning", () => {
		const { prompt, warnings } = mapMessages(
			[user([{ type: "file", mediaType: "image/png", data: "bb" }])],
			{ isNewConversation: false },
		);
		expect(prompt).toBe("");
		expect(warnings.some((w) => w.includes("no text"))).toBe(true);
	});

	test("string system content is tolerated alongside array user content", () => {
		const { prompt } = mapMessages(
			[{ role: "system", content: 42 as never }, user("hi")],
			{ isNewConversation: true },
		);
		// Non-string system content is dropped, not stringified into the prompt.
		expect(prompt).toBe("hi");
	});
});
