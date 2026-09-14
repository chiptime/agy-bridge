/**
 * Unit tests for prompt reduction (spec R5.s1–s3): a 5-turn history reduces
 * to the last user turn only, the system prompt is prepended exactly once and
 * only for new conversations, and non-text parts are dropped with warnings.
 *
 * v1.1 divergence helpers: ordered per-message content hashes (linear-
 * continuation detection against the stored baseline) and bounded seed
 * rendering (history re-seeding after client-side edits). Hashes are the
 * first 16 hex chars of sha256(JSON.stringify(message)); the seed block
 * renders the last 20 text-bearing messages, each truncated to 4000 chars.
 */
import { describe, expect, test } from "bun:test";
import {
	hashesArePrefix,
	mapMessages,
	messageHashes,
	renderSeed,
	SEED_MAX_CHARS,
	SEED_MAX_MESSAGES,
	type PromptContent,
	type PromptMessage,
} from "../src/messages";

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

	test("v1.1 seed opt: inserted between the system text and the last user turn, blank-line separated", () => {
		const { prompt, warnings } = mapMessages(
			[{ role: "system", content: "sys" }, user("the new question")],
			{ isNewConversation: true, seed: "SEED BLOCK" },
		);
		expect(prompt).toBe("sys\n\nSEED BLOCK\n\nthe new question");
		expect(warnings).toEqual([]);
	});

	test("v1.1 seed opt: without any system text the seed sits directly above the last user turn", () => {
		const { prompt } = mapMessages([user("q")], { isNewConversation: true, seed: "SEED" });
		expect(prompt).toBe("SEED\n\nq");
	});

	test("v1.1 seed opt: empty seed is ignored (behaves like the plain reduction)", () => {
		const { prompt } = mapMessages([{ role: "system", content: "sys" }, user("q")], {
			isNewConversation: true,
			seed: "",
		});
		expect(prompt).toBe("sys\n\nq");
	});
});

describe("unit: messages — v1.1 divergence hashes", () => {
	test("messageHashes: stable across calls, 16 lowercase hex chars, distinct per content and role", () => {
		const msgs: PromptMessage[] = [
			{ role: "system", content: "sys" },
			user("one"),
			{ role: "assistant", content: [{ type: "text", text: "two" }] },
		];
		const first = messageHashes(msgs);
		expect(messageHashes(msgs)).toEqual(first);
		expect(first).toHaveLength(3);
		for (const h of first) expect(h).toMatch(/^[0-9a-f]{16}$/);
		expect(new Set(first).size).toBe(3);
	});

	test("messageHashes: order is carried by position — a reordered array hashes differently element-wise", () => {
		const msgs = [user("a"), { role: "assistant", content: "b" } as PromptMessage, user("c")];
		const h = messageHashes(msgs);
		const swapped = messageHashes([msgs[1], msgs[0], msgs[2]]);
		expect(swapped).not.toEqual(h);
	});

	test("hashesArePrefix table: linear continuation vs edited/deleted/reordered history", () => {
		const h = messageHashes([user("1"), { role: "assistant", content: "a" }, user("2"), user("3")]);
		const cases: Array<{ name: string; stored: string[]; incoming: string[]; want: boolean }> = [
			{ name: "stored prefix of a longer incoming array", stored: h.slice(0, 3), incoming: h, want: true },
			{ name: "identical arrays", stored: h, incoming: h, want: true },
			{ name: "empty stored is trivially linear", stored: [], incoming: h, want: true },
			{ name: "edited middle message", stored: [h[0], "deadbeefdeadbeef", h[2]], incoming: h, want: false },
			{ name: "stored longer than incoming (deletions)", stored: h, incoming: h.slice(0, 2), want: false },
			{ name: "reordered messages", stored: [h[1], h[0], h[2], h[3]], incoming: h, want: false },
		];
		for (const c of cases) expect(hashesArePrefix(c.stored, c.incoming), c.name).toBe(c.want);
	});
});

describe("unit: messages — v1.1 seed rendering", () => {
	const seedHistory = (turns: number): PromptMessage[] => {
		const msgs: PromptMessage[] = [];
		for (let i = 0; i < turns; i++) {
			msgs.push(user(`question ${i}`));
			msgs.push({ role: "assistant", content: [{ type: "text", text: `answer ${i}` }] });
		}
		return msgs;
	};

	test("renders the last 20 text-bearing messages as User:/Assistant: lines inside the guarded block", () => {
		const { seed, warnings } = renderSeed(seedHistory(15)); // 30 text-bearing messages
		const lines = seed.split("\n");
		expect(lines[0]).toBe("--- Previous conversation (context restored after edits in the client) ---");
		expect(lines[lines.length - 1]).toBe("--- End of previous conversation ---");
		const rendered = lines.filter((l) => l.startsWith("User: ") || l.startsWith("Assistant: "));
		expect(rendered).toHaveLength(SEED_MAX_MESSAGES);
		expect(rendered[0]).toBe("User: question 5"); // last 20 of 30
		expect(rendered[rendered.length - 1]).toBe("Assistant: answer 14");
		expect(warnings).toEqual([]);
	});

	test("texts longer than SEED_MAX_CHARS are truncated to exactly 4000 chars", () => {
		const long = "x".repeat(SEED_MAX_CHARS + 500);
		const { seed } = renderSeed([user("q"), { role: "assistant", content: [{ type: "text", text: long }] }]);
		expect(seed).toContain(`Assistant: ${"x".repeat(SEED_MAX_CHARS)}\n`);
		expect(seed).not.toContain("x".repeat(SEED_MAX_CHARS + 1));
	});

	test("non-text parts are skipped with the existing warning text; textless messages are omitted", () => {
		const { seed, warnings } = renderSeed([
			// image/* parts now placeholder (design D6) — use a genuinely unsupported type here
			user([{ type: "file", mediaType: "application/pdf", data: "bb" }]), // no text → omitted
			user([{ type: "text", text: "with tool" }, { type: "tool-result", toolCallId: "t" }]),
			{ role: "assistant", content: [{ type: "text", text: "kept" }] },
		]);
		expect(seed).toContain("User: with tool");
		expect(seed).toContain("Assistant: kept");
		expect(warnings.some((w) => w.includes("tool-result"))).toBe(true);
		expect(warnings.some((w) => w.includes("file"))).toBe(true);
	});

	test("no text-bearing messages → empty seed, non-text parts still warned", () => {
		const { seed, warnings } = renderSeed([user([{ type: "file", mediaType: "application/pdf", data: "bb" }])]);
		expect(seed).toBe("");
		expect(warnings).toHaveLength(1);
	});
});
