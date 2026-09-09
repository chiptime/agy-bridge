/**
 * Unit tests for the session-map store (spec R7): opencode session id → agy
 * conversation id mapping in `<state>/agy-bridge/opencode-sessions.json`,
 * guarded by a process-wide mutex + per-session keyed mutexes and written
 * atomically (temp file + rename). Covers first-turn storage, stored →
 * resume lookup, failed-resume rebind-to-fresh, 50 concurrent writes always
 * landing complete JSON, >30d pruning on load and bind, and corrupt/missing
 * files being treated as empty. A second suite covers the cross-process
 * lockfile: every opencode instance is a separate OS process, so all
 * read-modify-write cycles serialize through `<state-file>.lock` — mutual
 * exclusion, bounded wait (SessionStoreBusyError), stale takeover after a
 * crash, and lock release on both success and mid-mutation failure.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { existsSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSessionStore, SessionStoreBusyError } from "../src/session-store";

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function setup(): Promise<{ path: string; store: ReturnType<typeof openSessionStore> }> {
	const dir = await mkdtemp("/tmp/agy-store-");
	const path = join(dir, "opencode-sessions.json");
	return { path, store: openSessionStore(path) };
}

describe("unit: session-store — R7 bind/get/rebind, atomic concurrent writes, prune", () => {
	test("R7.s1 first turn: bind stores the mapping; file is versioned JSON with updatedAt", async () => {
		const { path, store } = await setup();
		await store.bind("sess-1", "conv-1");
		const raw = JSON.parse(readFileSync(path, "utf8"));
		expect(raw.version).toBe(1);
		expect(raw.sessions["sess-1"].conversationId).toBe("conv-1");
		expect(typeof raw.sessions["sess-1"].updatedAt).toBe("string");
		expect(await store.get("sess-1")).toBe("conv-1");
	});

	test("R7.s2 stored session: get returns the conversationId the next turn resumes with", async () => {
		const { store } = await setup();
		await store.bind("sess-2", "conv-2");
		expect(await store.get("sess-2")).toBe("conv-2");
		expect(await store.get("never-bound")).toBeUndefined();
	});

	test("R7.s3 failed resume: rebind drops the mapping so the next turn runs fresh; bind replaces", async () => {
		const { path, store } = await setup();
		await store.bind("sess-3", "conv-old");
		await store.bind("sess-3", "conv-new");
		expect(await store.get("sess-3")).toBe("conv-new");
		await store.rebind("sess-3");
		expect(await store.get("sess-3")).toBeUndefined();
		expect(JSON.parse(readFileSync(path, "utf8")).sessions["sess-3"]).toBeUndefined();
	});

	test("R7.s4 50 concurrent Promise.all writes: file is always complete JSON with all entries", async () => {
		const { path, store } = await setup();
		await Promise.all(
			Array.from({ length: 50 }, (_, i) => store.bind(`sess-${i}`, `conv-${i}`)),
		);
		const raw = JSON.parse(readFileSync(path, "utf8"));
		expect(Object.keys(raw.sessions)).toHaveLength(50);
		for (let i = 0; i < 50; i++) expect(await store.get(`sess-${i}`)).toBe(`conv-${i}`);
	});

	test("prune: entries older than 30 days are dropped on load and on bind", async () => {
		const dir = await mkdtemp("/tmp/agy-store-prune-");
		const path = join(dir, "opencode-sessions.json");
		const stale = JSON.stringify({
			version: 1,
			sessions: {
				"sess-old": { conversationId: "conv-old", updatedAt: iso(-31 * DAY_MS) },
				"sess-fresh": { conversationId: "conv-fresh", updatedAt: iso(-DAY_MS) },
			},
		});
		const { writeFileSync } = await import("node:fs");
		writeFileSync(path, stale);
		const store = openSessionStore(path);
		expect(await store.get("sess-old")).toBeUndefined();
		expect(await store.get("sess-fresh")).toBe("conv-fresh");
		await store.bind("sess-new", "conv-new");
		const raw = JSON.parse(readFileSync(path, "utf8"));
		expect(raw.sessions["sess-old"]).toBeUndefined();
		expect(Object.keys(raw.sessions).sort()).toEqual(["sess-fresh", "sess-new"]);
	});

	test("corrupt or missing file is treated as empty and replaced on the next write", async () => {
		const dir = await mkdtemp("/tmp/agy-store-corrupt-");
		const path = join(dir, "opencode-sessions.json");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(path, "{not json");
		const store = openSessionStore(path);
		expect(await store.get("any")).toBeUndefined();
		await store.bind("sess-x", "conv-x");
		expect(JSON.parse(readFileSync(path, "utf8")).sessions["sess-x"].conversationId).toBe("conv-x");
	});
});

describe("unit: session-store — v1.1 divergence baseline (hashes)", () => {
	test("bind stores the ordered hashes; getEntry returns the full entry; get stays the id sugar", async () => {
		const { path, store } = await setup();
		await store.bind("sess-h", "conv-h", ["aa", "bb"]);
		const raw = JSON.parse(readFileSync(path, "utf8"));
		expect(raw.sessions["sess-h"].hashes).toEqual(["aa", "bb"]);
		expect(await store.getEntry("sess-h")).toEqual({ conversationId: "conv-h", hashes: ["aa", "bb"] });
		expect(await store.get("sess-h")).toBe("conv-h");
	});

	test("pre-upgrade entry without hashes loads as the unknown baseline (hashes undefined)", async () => {
		const dir = await mkdtemp("/tmp/agy-store-legacy-");
		const path = join(dir, "opencode-sessions.json");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				sessions: { "sess-legacy": { conversationId: "conv-old", updatedAt: iso(-DAY_MS) } },
			}),
		);
		const store = openSessionStore(path);
		const entry = await store.getEntry("sess-legacy");
		expect(entry?.conversationId).toBe("conv-old");
		expect(entry?.hashes).toBeUndefined();
		expect(await store.getEntry("never-bound")).toBeUndefined();
	});

	test("rebinding without hashes replaces the entry and drops stale hashes", async () => {
		const { store } = await setup();
		await store.bind("sess-r", "conv-1", ["h0"]);
		await store.bind("sess-r", "conv-2");
		const entry = await store.getEntry("sess-r");
		expect(entry?.conversationId).toBe("conv-2");
		expect(entry?.hashes).toBeUndefined();
	});
});

describe("unit: session-store — cross-process lockfile (read-modify-write mutual exclusion)", () => {
	test("two store instances on the same file (simulated processes): concurrent binds of different sessions both land", async () => {
		const dir = await mkdtemp("/tmp/agy-store-xproc-");
		const path = join(dir, "opencode-sessions.json");
		const first = openSessionStore(path);
		const second = openSessionStore(path);
		await Promise.all([first.bind("sess-a", "conv-a"), second.bind("sess-b", "conv-b")]);
		const raw = JSON.parse(readFileSync(path, "utf8"));
		expect(raw.sessions["sess-a"].conversationId).toBe("conv-a");
		expect(raw.sessions["sess-b"].conversationId).toBe("conv-b");
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	test("mutual exclusion: bind spins while a fresh foreign lock is held and proceeds once it is released", async () => {
		const { path, store } = await setup();
		const lockPath = `${path}.lock`;
		writeFileSync(lockPath, ""); // fresh mtime → held by a live process
		let finished = false;
		const bound = store.bind("sess-w", "conv-w").then(() => {
			finished = true;
		});
		await sleep(40); // well inside the 3s bounded wait
		expect(finished).toBe(false);
		unlinkSync(lockPath); // the foreign holder releases
		await bound;
		expect(await store.get("sess-w")).toBe("conv-w");
		expect(existsSync(lockPath)).toBe(false); // released its own lock
	});

	test("pure reads take the lock too: get waits for a fresh foreign lock and completes after release", async () => {
		const { path, store } = await setup();
		await store.bind("sess-r", "conv-r");
		const lockPath = `${path}.lock`;
		writeFileSync(lockPath, "");
		let finished = false;
		const read = store.get("sess-r").then((v) => {
			finished = true;
			return v;
		});
		await sleep(40);
		expect(finished).toBe(false);
		unlinkSync(lockPath);
		expect(await read).toBe("conv-r");
		expect(existsSync(lockPath)).toBe(false);
	});

	test("busy: fresh foreign lock held past the bounded wait → SessionStoreBusyError naming the lock; foreign lock untouched", async () => {
		const dir = await mkdtemp("/tmp/agy-store-busy-");
		const path = join(dir, "opencode-sessions.json");
		const lockPath = `${path}.lock`;
		writeFileSync(lockPath, "");
		const store = openSessionStore(path, { lockWaitMs: 80 });
		const error = await store.bind("sess-busy", "conv-busy").then(
			() => undefined,
			(err) => err,
		);
		expect(error).toBeInstanceOf(SessionStoreBusyError);
		expect((error as Error).message).toContain(lockPath);
		expect(existsSync(lockPath)).toBe(true); // belongs to the other holder — not ours to delete
	});

	test("stale takeover: a lock aged beyond the stale window is unlinked and acquisition succeeds immediately", async () => {
		const { path, store } = await setup();
		const lockPath = `${path}.lock`;
		writeFileSync(lockPath, "");
		const aged = new Date(Date.now() - 4000);
		utimesSync(lockPath, aged, aged);
		const started = Date.now();
		await store.bind("sess-stale", "conv-stale");
		expect(Date.now() - started).toBeLessThan(2000); // no busy-wait out to the 3s bound
		expect(await store.get("sess-stale")).toBe("conv-stale");
		expect(existsSync(lockPath)).toBe(false);
	});

	test("crash safety: a mid-mutation throw under the lock leaves the old file intact and releases the lock", async () => {
		const { path, store } = await setup();
		await store.bind("sess-keep", "conv-keep");
		// A BigInt merges into the in-memory map but breaks JSON.stringify inside
		// persist — a deterministic crash between load and rename, under the lock.
		await expect(store.bind("sess-boom", 10n as unknown as string)).rejects.toThrow();
		expect(existsSync(`${path}.lock`)).toBe(false);
		const raw = JSON.parse(readFileSync(path, "utf8")); // old state, still complete JSON
		expect(Object.keys(raw.sessions)).toEqual(["sess-keep"]);
	});
});
