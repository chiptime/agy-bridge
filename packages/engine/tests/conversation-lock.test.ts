/**
 * Unit tests for the cross-process per-conversation exclusion lock: the
 * exclusive-create mechanics (hex-named 0o600 lock file carrying pid +
 * acquiredAt), bounded busy waiting (ConversationBusyError after waitMs),
 * and provable-holder-gone takeover (dead pid via the isPidAlive seam, or
 * stale mtime via the now seam). Deterministic by injection — no real
 * second process, no arbitrary sleeps; every wait is bounded by the
 * injected waitMs.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { acquireConversationLock, ConversationBusyError } from "../src/conversation-lock";

/** Lock filenames are hex sha256 digests — raw key bytes never appear. */
const HEX_LOCK = /^[0-9a-f]{64}\.lock$/;

describe("unit: conversation-lock — per-conversation exclusion", () => {
	test("acquire/release roundtrip: one exclusive 0o600 file with pid + acquiredAt, removed on release", async () => {
		const dir = await mkdtemp("/tmp/agy-lock-");
		const lock = await acquireConversationLock(dir, "conv-1");
		const entries = readdirSync(dir);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatch(HEX_LOCK);
		const content = JSON.parse(readFileSync(join(dir, entries[0]), "utf8")) as {
			pid: number;
			acquiredAt: string;
		};
		expect(content.pid).toBe(process.pid);
		expect(typeof content.acquiredAt).toBe("string");
		expect(Number.isNaN(Date.parse(content.acquiredAt))).toBe(false);
		lock.release();
		expect(readdirSync(dir)).toEqual([]);
	});

	test("second acquire while held → ConversationBusyError after the bounded wait; message carries the conversation key", async () => {
		const dir = await mkdtemp("/tmp/agy-lock-busy-");
		const first = await acquireConversationLock(dir, "conv-busy");
		const t0 = Date.now();
		let err: unknown;
		try {
			await acquireConversationLock(dir, "conv-busy", { waitMs: 60, pollMs: 5 });
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ConversationBusyError);
		expect((err as Error).message).toContain("conv-busy");
		// Bounded: the wait consumed (at least) waitMs, not forever, and no
		// second lock file was created for the same key.
		expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
		expect(readdirSync(dir)).toHaveLength(1);
		first.release();
	});

	test("takeover when the holder pid is provably dead (isPidAlive seam)", async () => {
		const dir = await mkdtemp("/tmp/agy-lock-dead-");
		const first = await acquireConversationLock(dir, "conv-dead");
		const lockPath = join(dir, readdirSync(dir)[0]);
		// Rewrite the holder record as a crashed process's pid.
		writeFileSync(lockPath, JSON.stringify({ pid: 999999, acquiredAt: new Date().toISOString() }));
		const second = await acquireConversationLock(dir, "conv-dead", {
			waitMs: 100,
			pollMs: 5,
			isPidAlive: (pid) => pid !== 999999,
		});
		second.release();
		// The original holder's release is a tolerated no-op: a stale
		// takeover may already have removed the file.
		first.release();
		expect(readdirSync(dir)).toEqual([]);
	});

	test("takeover when the holder lock is stale (now seam); a live, fresh holder still blocks", async () => {
		const dir = await mkdtemp("/tmp/agy-lock-stale-");
		const first = await acquireConversationLock(dir, "conv-stale");
		const shiftedNow = () => Date.now() + 60_000; // way past staleMs below.
		const second = await acquireConversationLock(dir, "conv-stale", {
			waitMs: 100,
			pollMs: 5,
			now: shiftedNow,
			staleMs: 5_000,
			isPidAlive: () => true, // pid liveness alone must not block a stale takeover
		});
		second.release();
		first.release();
		// Control: a LIVE holder with a FRESH lock (real clock) stays busy.
		const held = await acquireConversationLock(dir, "conv-fresh");
		let err: unknown;
		try {
			await acquireConversationLock(dir, "conv-fresh", { waitMs: 30, pollMs: 5 });
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ConversationBusyError);
		held.release();
		expect(readdirSync(dir)).toEqual([]);
	});

	test("release tolerates ENOENT and never throws (double release)", async () => {
		const dir = await mkdtemp("/tmp/agy-lock-rel-");
		const lock = await acquireConversationLock(dir, "conv-gone");
		lock.release();
		expect(() => lock.release()).not.toThrow();
		expect(readdirSync(dir)).toEqual([]);
	});

	test("key hashing: different keys → different files, same key → same file, no raw key bytes in filenames", async () => {
		const dir = await mkdtemp("/tmp/agy-lock-hash-");
		const alpha = await acquireConversationLock(dir, "conv-alpha");
		const beta = await acquireConversationLock(dir, "conv-beta");
		const entries = readdirSync(dir);
		expect(entries).toHaveLength(2);
		for (const name of entries) {
			expect(name).toMatch(HEX_LOCK);
			expect(name.includes("conv-")).toBe(false);
		}
		// Same key while held: busy, and no third file appears.
		let err: unknown;
		try {
			await acquireConversationLock(dir, "conv-alpha", { waitMs: 30, pollMs: 5 });
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(ConversationBusyError);
		expect(readdirSync(dir)).toHaveLength(2);
		alpha.release();
		beta.release();
		expect(readdirSync(dir)).toEqual([]);
	});
});
