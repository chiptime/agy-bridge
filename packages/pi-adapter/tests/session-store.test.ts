/**
 * Unit tests for the pi session-map store (spec R5): pi session key
 * (`options.sessionId ?? cwd`) → agy conversation id in
 * `<stateDir>/pi-sessions.json`, guarded by in-process mutexes, a
 * cross-process O_EXCL lockfile (bounded wait, stale takeover), and atomic
 * temp+rename writes. Covers first-turn storage, stored → resume lookup,
 * failed-resume rebind-to-fresh, 50 concurrent writes always landing
 * complete JSON, >30d pruning on load and bind, corrupt/missing files
 * treated as empty, the v1.1 hash baselines, and the lockfile contract
 * (mutual exclusion across simulated processes, SessionStoreBusyError,
 * stale takeover after a crash, lock release on mid-mutation failure).
 * R6: persisted rows must survive pi lifecycle events — the store is a
 * file, so a recycled in-memory wrapper (a fresh store instance) still
 * reads its rows; only the 30d prune removes them.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { existsSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	askThreadKey,
	openPiSessionStore,
	openSessionStore,
	piSessionKey,
	SessionStoreBusyError,
	sessionKey,
} from "../src/session-store";

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function setup(): Promise<{ path: string; store: ReturnType<typeof openSessionStore> }> {
	const dir = await mkdtemp("/tmp/agy-pi-store-");
	const path = join(dir, "pi-sessions.json");
	return { path, store: openSessionStore(path) };
}

describe("unit: session-store — R5 key derivation and config wiring", () => {
	test("R5.s1 key: an explicit options.sessionId wins; undefined falls back to cwd", () => {
		expect(sessionKey("pi-session-1", "/repo")).toBe("pi-session-1");
		expect(sessionKey(undefined, "/repo")).toBe("/repo");
	});

	test("R5.s2 key uses ?? semantics: an empty sessionId is kept, not replaced by cwd", () => {
		expect(sessionKey("", "/repo")).toBe("");
	});

	test("openPiSessionStore opens <stateDir>/pi-sessions.json from the resolved config stateDir", async () => {
		const dir = await mkdtemp("/tmp/agy-pi-store-cfg-");
		const store = openPiSessionStore({ stateDir: dir });
		await store.bind("key-1", "conv-1");
		const raw = JSON.parse(readFileSync(join(dir, "pi-sessions.json"), "utf8"));
		expect(raw.sessions["key-1"].conversationId).toBe("conv-1");
	});

	test("R6: persisted rows survive lifecycle recycle — a fresh store instance over the same file reads the row", async () => {
		const { path } = await setup();
		const first = openSessionStore(path);
		await first.bind("key-survivor", "conv-survivor", ["h0"]);
		// A recycled in-memory wrapper is just a new openSessionStore call:
		// the FILE is the only state, so the row is still there.
		const recycled = openSessionStore(path);
		expect(await recycled.get("key-survivor")).toBe("conv-survivor");
		expect(await recycled.getEntry("key-survivor")).toEqual({
			conversationId: "conv-survivor",
			hashes: ["h0"],
		});
	});
});

describe("unit: session-store — R5 bind/get/rebind, atomic concurrent writes, prune", () => {
	test("R5.s3 first turn: bind stores the mapping; file is versioned JSON with updatedAt", async () => {
		const { path, store } = await setup();
		await store.bind("key-1", "conv-1");
		const raw = JSON.parse(readFileSync(path, "utf8"));
		expect(raw.version).toBe(1);
		expect(raw.sessions["key-1"].conversationId).toBe("conv-1");
		expect(typeof raw.sessions["key-1"].updatedAt).toBe("string");
		expect(await store.get("key-1")).toBe("conv-1");
	});

	test("R5.s4 stored session: get returns the conversationId the next turn resumes with", async () => {
		const { store } = await setup();
		await store.bind("key-2", "conv-2");
		expect(await store.get("key-2")).toBe("conv-2");
		expect(await store.get("never-bound")).toBeUndefined();
	});

	test("R5.s5 failed resume: rebind drops the mapping so the next turn runs fresh; bind replaces", async () => {
		const { path, store } = await setup();
		await store.bind("key-3", "conv-old");
		await store.bind("key-3", "conv-new");
		expect(await store.get("key-3")).toBe("conv-new");
		await store.rebind("key-3");
		expect(await store.get("key-3")).toBeUndefined();
		expect(JSON.parse(readFileSync(path, "utf8")).sessions["key-3"]).toBeUndefined();
	});

	test("R5.s6 50 concurrent Promise.all writes: file is always complete JSON with all entries", async () => {
		const { path, store } = await setup();
		await Promise.all(Array.from({ length: 50 }, (_, i) => store.bind(`key-${i}`, `conv-${i}`)));
		const raw = JSON.parse(readFileSync(path, "utf8"));
		expect(Object.keys(raw.sessions)).toHaveLength(50);
		for (let i = 0; i < 50; i++) expect(await store.get(`key-${i}`)).toBe(`conv-${i}`);
	});

	test("prune: entries older than 30 days are dropped on load and on bind", async () => {
		const dir = await mkdtemp("/tmp/agy-pi-store-prune-");
		const path = join(dir, "pi-sessions.json");
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				sessions: {
					"key-old": { conversationId: "conv-old", updatedAt: iso(-31 * DAY_MS) },
					"key-fresh": { conversationId: "conv-fresh", updatedAt: iso(-DAY_MS) },
				},
			}),
		);
		const store = openSessionStore(path);
		expect(await store.get("key-old")).toBeUndefined();
		expect(await store.get("key-fresh")).toBe("conv-fresh");
		await store.bind("key-new", "conv-new");
		const raw = JSON.parse(readFileSync(path, "utf8"));
		expect(raw.sessions["key-old"]).toBeUndefined();
		expect(Object.keys(raw.sessions).sort()).toEqual(["key-fresh", "key-new"]);
	});

	test("corrupt or missing file is treated as empty and replaced on the next write", async () => {
		const dir = await mkdtemp("/tmp/agy-pi-store-corrupt-");
		const path = join(dir, "pi-sessions.json");
		writeFileSync(path, "{not json");
		const store = openSessionStore(path);
		expect(await store.get("any")).toBeUndefined();
		await store.bind("key-x", "conv-x");
		expect(JSON.parse(readFileSync(path, "utf8")).sessions["key-x"].conversationId).toBe("conv-x");
	});
});

describe("unit: session-store — divergence baseline (hashes)", () => {
	test("bind stores the ordered hashes; getEntry returns the full entry; get stays the id sugar", async () => {
		const { path, store } = await setup();
		await store.bind("key-h", "conv-h", ["aa", "bb"]);
		const raw = JSON.parse(readFileSync(path, "utf8"));
		expect(raw.sessions["key-h"].hashes).toEqual(["aa", "bb"]);
		expect(await store.getEntry("key-h")).toEqual({ conversationId: "conv-h", hashes: ["aa", "bb"] });
		expect(await store.get("key-h")).toBe("conv-h");
	});

	test("pre-upgrade entry without hashes loads as the unknown baseline (hashes undefined)", async () => {
		const dir = await mkdtemp("/tmp/agy-pi-store-legacy-");
		const path = join(dir, "pi-sessions.json");
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				sessions: { "key-legacy": { conversationId: "conv-old", updatedAt: iso(-DAY_MS) } },
			}),
		);
		const store = openSessionStore(path);
		const entry = await store.getEntry("key-legacy");
		expect(entry?.conversationId).toBe("conv-old");
		expect(entry?.hashes).toBeUndefined();
		expect(await store.getEntry("never-bound")).toBeUndefined();
	});

	test("rebinding without hashes replaces the entry and drops stale hashes", async () => {
		const { store } = await setup();
		await store.bind("key-r", "conv-1", ["h0"]);
		await store.bind("key-r", "conv-2");
		const entry = await store.getEntry("key-r");
		expect(entry?.conversationId).toBe("conv-2");
		expect(entry?.hashes).toBeUndefined();
	});
});

describe("unit: session-store — cross-process lockfile (read-modify-write mutual exclusion)", () => {
	test("two store instances on the same file (simulated processes): concurrent binds of different keys both land", async () => {
		const dir = await mkdtemp("/tmp/agy-pi-store-xproc-");
		const path = join(dir, "pi-sessions.json");
		const first = openSessionStore(path);
		const second = openSessionStore(path);
		await Promise.all([first.bind("key-a", "conv-a"), second.bind("key-b", "conv-b")]);
		const raw = JSON.parse(readFileSync(path, "utf8"));
		expect(raw.sessions["key-a"].conversationId).toBe("conv-a");
		expect(raw.sessions["key-b"].conversationId).toBe("conv-b");
		expect(existsSync(`${path}.lock`)).toBe(false);
	});

	test("mutual exclusion: bind spins while a fresh foreign lock is held and proceeds once it is released", async () => {
		const { path, store } = await setup();
		const lockPath = `${path}.lock`;
		writeFileSync(lockPath, ""); // fresh mtime → held by a live process
		let finished = false;
		const bound = store.bind("key-w", "conv-w").then(() => {
			finished = true;
		});
		await sleep(40); // well inside the 3s bounded wait
		expect(finished).toBe(false);
		unlinkSync(lockPath); // the foreign holder releases
		await bound;
		expect(await store.get("key-w")).toBe("conv-w");
		expect(existsSync(lockPath)).toBe(false); // released its own lock
	});

	test("pure reads take the lock too: get waits for a fresh foreign lock and completes after release", async () => {
		const { path, store } = await setup();
		await store.bind("key-r", "conv-r");
		const lockPath = `${path}.lock`;
		writeFileSync(lockPath, "");
		let finished = false;
		const read = store.get("key-r").then((v) => {
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
		const dir = await mkdtemp("/tmp/agy-pi-store-busy-");
		const path = join(dir, "pi-sessions.json");
		const lockPath = `${path}.lock`;
		writeFileSync(lockPath, "");
		const store = openSessionStore(path, { lockWaitMs: 80 });
		const error = await store.bind("key-busy", "conv-busy").then(
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
		await store.bind("key-stale", "conv-stale");
		expect(Date.now() - started).toBeLessThan(2000); // no busy-wait out to the 3s bound
		expect(await store.get("key-stale")).toBe("conv-stale");
		expect(existsSync(lockPath)).toBe(false);
	});

	test("crash safety: a mid-mutation throw under the lock leaves the old file intact and releases the lock", async () => {
		const { path, store } = await setup();
		await store.bind("key-keep", "conv-keep");
		// A BigInt merges into the in-memory map but breaks JSON.stringify inside
		// persist — a deterministic crash between load and rename, under the lock.
		await expect(store.bind("key-boom", 10n as unknown as string)).rejects.toThrow();
		expect(existsSync(`${path}.lock`)).toBe(false);
		const raw = JSON.parse(readFileSync(path, "utf8")); // old state, still complete JSON
		expect(Object.keys(raw.sessions)).toEqual(["key-keep"]);
	});
});

// --- v0.3 R1/D1/D2: the :ask thread namespace ---------------------------------------

describe("unit: session-store — v0.3 :ask thread namespace (R1, D1, D2)", () => {
	test("askThreadKey: the thread key is `<sessionKey>:ask`", () => {
		expect(askThreadKey("s1")).toBe("s1:ask");
		expect(askThreadKey("/repo")).toBe("/repo:ask");
	});

	test("piSessionKey: the sessionManager id wins; an empty or absent id falls back to cwd", () => {
		expect(piSessionKey({ sessionManager: { getSessionId: () => "sess-9" }, cwd: "/repo" })).toBe("sess-9");
		expect(piSessionKey({ sessionManager: { getSessionId: () => "" }, cwd: "/repo" })).toBe("/repo");
		expect(piSessionKey({ cwd: "/repo" })).toBe("/repo");
	});

	test("provider row and thread row coexist in one store (disjoint :ask namespace)", async () => {
		const { store } = await setup();
		await store.bind("s1", "conv-provider", ["h0"]);
		await store.bind(askThreadKey("s1"), "conv-thread");
		expect(await store.get("s1")).toBe("conv-provider");
		expect(await store.get(askThreadKey("s1"))).toBe("conv-thread");
		expect(await store.getEntry("s1")).toEqual({ conversationId: "conv-provider", hashes: ["h0"] });
		expect(await store.getEntry(askThreadKey("s1"))).toEqual({ conversationId: "conv-thread" });
	});

	test("hash-less thread row round-trips via 2-arg bind: getEntry returns {conversationId} with NO hashes field", async () => {
		const { path, store } = await setup();
		await store.bind(askThreadKey("s1"), "conv-thread");
		const entry = await store.getEntry(askThreadKey("s1"));
		expect(entry).toEqual({ conversationId: "conv-thread" });
		expect(entry?.hashes).toBeUndefined();
		const raw = JSON.parse(readFileSync(path, "utf8"));
		// The store's canonical hash-less form is the ABSENT field, not null.
		expect("hashes" in raw.sessions["s1:ask"]).toBe(false);
		expect(raw.sessions["s1:ask"].conversationId).toBe("conv-thread");
	});

	test(`hand-edited literal "hashes": null degrades to the hash-less unknown baseline`, async () => {
		const dir = await mkdtemp("/tmp/agy-pi-store-nullhash-");
		const path = join(dir, "pi-sessions.json");
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				sessions: { "s1:ask": { conversationId: "conv-t", hashes: null, updatedAt: iso(-DAY_MS) } },
			}),
		);
		const store = openSessionStore(path);
		const entry = await store.getEntry("s1:ask");
		expect(entry).toEqual({ conversationId: "conv-t" });
		expect(entry?.hashes).toBeUndefined();
	});
});
