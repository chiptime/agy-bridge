/**
 * Adapter-level wiring tests for the shared per-conversation exclusion
 * lock (timeout-recovery PRD concurrency matrix): a pi runTurn that will
 * RESUME a bound conversation holds <stateDir>/conversation-locks across
 * the attempt loop, so a second request for the SAME conversation fails
 * fast with a typed, NON-retryable TurnError before any spawn — the host
 * (which retries on a visible "(retryable)" marker) can never barge into
 * a busy conversation.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Context, UserMessage } from "@earendil-works/pi-ai";
import { acquireConversationLock, messageHashes } from "agy-bridge-engine";
import { runTurn, TurnError, type TurnDeps, type TurnRequest } from "../src/turn";
import { openSessionStore } from "../src/session-store";

function userMsg(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: 1 };
}

/** Minimal success child (same shape as turn.test.ts's fakeChild, local to keep this file standalone). */
function fakeSuccessChild(conversationId: string) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const child: any = new EventEmitter();
	child.stdout = new Readable({ read() {} });
	child.stderr = new Readable({ read() {} });
	child.killed = false;
	child.kill = () => true;
	child.stdout.push(Buffer.from(`${JSON.stringify({ event: "init", conversation_id: conversationId })}\n`));
	child.stdout.push(
		Buffer.from(
			`${JSON.stringify({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "done" } })}\n`,
		),
	);
	setTimeout(() => child.emit("close", 0, null), 10);
	return child;
}

describe("unit: conversation-lock adapter wiring (pi runTurn)", () => {
	test("a turn resuming a busy conversation throws the non-retryable busy TurnError with ZERO spawns", async () => {
		const root = await mkdtemp(join(tmpdir(), "agy-pi-lock-"));
		const store = openSessionStore(join(root, "pi-sessions.json"));
		let spawns = 0;
		const deps: TurnDeps = {
			bin: "agy",
			store,
			timeoutMs: 30_000,
			logRoot: root,
			stateDir: root,
			spawnFn: (() => {
				spawns++;
				throw new Error("must never spawn into a busy conversation");
			}) as never,
		};
		const hashes = messageHashes([{ role: "user", content: "q" }]);
		await store.bind("s-lock", "conv-held", hashes);
		// Hold the exact lock the turn will try to take: the same conversation
		// id under the same lock dir the adapter derives from deps.stateDir.
		const lockDir = join(root, "agy-bridge", "conversation-locks");
		const lock = await acquireConversationLock(lockDir, "conv-held", { waitMs: 50, pollMs: 5 });
		let caught: unknown;
		try {
			const req: TurnRequest = {
				context: { messages: [userMsg("q")] } as unknown as Context,
				options: { sessionId: "s-lock" },
			};
			await runTurn(deps, req);
		} catch (err) {
			caught = err;
		}
		lock.release();
		expect(caught).toBeInstanceOf(TurnError);
		const turnError = caught as TurnError;
		expect(turnError.mapping.retryable).toBe(false);
		expect(turnError.mapping.resumeEligible).toBe(false);
		expect(turnError.mapping.finalize).toBe("error");
		expect(turnError.mapping.message).toMatch(/another agy request is active for this conversation/i);
		// No "(retryable)" marker may ever appear — pi's host regex-matches it
		// for its own retry policy and must not auto-retry into a busy
		// conversation.
		expect(turnError.message).not.toContain("(retryable)");
		expect(spawns).toBe(0);
	});

	test("a FRESH conversation (no binding) takes no lock: success even while an unrelated lock is held", async () => {
		const root = await mkdtemp(join(tmpdir(), "agy-pi-lock-fresh-"));
		const store = openSessionStore(join(root, "pi-sessions.json"));
		const deps: TurnDeps = {
			bin: "agy",
			store,
			timeoutMs: 30_000,
			logRoot: root,
			stateDir: root,
			spawnFn: (() => fakeSuccessChild("conv-fresh-run")) as never,
		};
		const lockDir = join(root, "agy-bridge", "conversation-locks");
		const lock = await acquireConversationLock(lockDir, "conv-unrelated", { waitMs: 50, pollMs: 5 });
		try {
			const result = await runTurn(deps, {
				context: { messages: [userMsg("q")] } as unknown as Context,
				options: { sessionId: "s-fresh" },
			});
			expect(result.classification.outcome).toBe("success");
		} finally {
			lock.release();
		}
	});
});
