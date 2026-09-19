/**
 * Adapter-level wiring tests for the shared per-conversation exclusion
 * lock (timeout-recovery PRD concurrency matrix): a runTurn that will
 * RESUME a bound conversation holds <stateDir>/conversation-locks across
 * the attempt loop, so a second request for the SAME conversation fails
 * fast with a typed, NON-retryable TurnError before any spawn — pi-style
 * host auto-retry can never barge into a busy conversation.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { acquireConversationLock } from "agy-bridge-engine";
import { runTurn, TurnError, type TurnDeps } from "../src/turn";
import { openSessionStore } from "../src/session-store";
import { resolveConfig } from "../src/config";

const H1 = ["h0"];

/** Minimal success child (same shape as turn.test.ts's fakeChild, local to keep this file standalone). */
function fakeSuccessChild(conversationId: string) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const child: any = new EventEmitter();
	child.stdout = new Readable({ read() {} });
	child.stderr = new Readable({ read() {} });
	child.stdin = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		},
	});
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

describe("unit: conversation-lock adapter wiring (opencode runTurn)", () => {
	test("a turn resuming a busy conversation throws the non-retryable busy TurnError with ZERO spawns", async () => {
		const root = await mkdtemp("/tmp/agy-oc-lock-");
		const store = openSessionStore(join(root, "sessions.json"));
		let spawns = 0;
		const deps: TurnDeps = {
			bin: "agy",
			config: resolveConfig({ scratchRoot: root, stateDir: root, timeoutMs: 30_000 }),
			store,
			spawnFn: (() => {
				spawns++;
				throw new Error("must never spawn into a busy conversation");
			}) as never,
		};
		await store.bind("sess-lock", "conv-held", H1);
		// Hold the exact lock the turn will try to take: the same conversation
		// id under the same lock dir the adapter derives from config.stateDir.
		const lockDir = join(root, "agy-bridge", "conversation-locks");
		const lock = await acquireConversationLock(lockDir, "conv-held", { waitMs: 50, pollMs: 5 });
		let caught: unknown;
		try {
			await runTurn(deps, { prompt: "p", hashes: H1, sessionId: "sess-lock" });
		} catch (err) {
			caught = err;
		}
		lock.release();
		expect(caught).toBeInstanceOf(TurnError);
		const turnError = caught as TurnError;
		expect(turnError.mapping.retryable).toBe(false);
		expect(turnError.mapping.resume).toBe(false);
		expect(turnError.mapping.message).toMatch(/another agy request is active for this conversation/i);
		// No "(retryable)"-style marker may ever appear — the host must not
		// auto-retry into a busy conversation.
		expect(turnError.message).not.toContain("(retryable)");
		expect(spawns).toBe(0);
	});

	test("a FRESH conversation (no binding) takes no lock: success even while an unrelated lock is held", async () => {
		const root = await mkdtemp("/tmp/agy-oc-lock-fresh-");
		const store = openSessionStore(join(root, "sessions.json"));
		const deps: TurnDeps = {
			bin: "agy",
			config: resolveConfig({ scratchRoot: root, stateDir: root, timeoutMs: 30_000 }),
			store,
			spawnFn: (() => fakeSuccessChild("conv-fresh-run")) as never,
		};
		const lockDir = join(root, "agy-bridge", "conversation-locks");
		const lock = await acquireConversationLock(lockDir, "conv-unrelated", { waitMs: 50, pollMs: 5 });
		try {
			const result = await runTurn(deps, { prompt: "p", hashes: H1, sessionId: "sess-fresh" });
			expect(result.classification.outcome).toBe("success");
		} finally {
			lock.release();
		}
	});
});
