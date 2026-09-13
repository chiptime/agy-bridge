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
		expect(raw.version).toBe(2);
		expect(raw.sessions["sess-1"][0].conversationId).toBe("conv-1");
		expect(typeof raw.sessions["sess-1"][0].updatedAt).toBe("string");
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
		expect(JSON.parse(readFileSync(path, "utf8")).sessions["sess-x"][0].conversationId).toBe("conv-x");
	});
});

describe("unit: session-store — v1.1 divergence baseline (hashes)", () => {
	test("bind stores the ordered hashes; getEntry returns the full entry; get stays the id sugar", async () => {
		const { path, store } = await setup();
		await store.bind("sess-h", "conv-h", ["aa", "bb"]);
		const raw = JSON.parse(readFileSync(path, "utf8"));
		expect(raw.sessions["sess-h"][0].hashes).toEqual(["aa", "bb"]);
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

describe("unit: session-store — schema v2 multi-conversation bindings", () => {
	/** Store with an advancing clock so updatedAt ordering is deterministic. */
	async function setupClock(): Promise<{ path: string; store: ReturnType<typeof openSessionStore>; tick: () => void }> {
		const dir = await mkdtemp("/tmp/agy-store-v2-");
		const path = join(dir, "opencode-sessions.json");
		let t = Date.now();
		const store = openSessionStore(path, { now: () => t });
		return { path, store, tick: () => (t += 1000) };
	}

	test("migration v1→v2: a v1 file loads wrapped as a single-element list; next write persists version 2", async () => {
		const dir = await mkdtemp("/tmp/agy-store-mig-");
		const path = join(dir, "opencode-sessions.json");
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				sessions: {
					"sess-m": { conversationId: "conv-m", updatedAt: iso(-DAY_MS) },
					"sess-hm": { conversationId: "conv-hm", hashes: ["h0"], updatedAt: iso(-DAY_MS) },
				},
			}),
		);
		const store = openSessionStore(path);
		const plain = await store.getEntry("sess-m");
		expect(plain?.conversationId).toBe("conv-m");
		expect(plain?.hashes).toBeUndefined();
		const hashed = await store.getEntry("sess-hm");
		expect(hashed).toEqual({ conversationId: "conv-hm", hashes: ["h0"] });
		expect(await store.get("sess-m")).toBe("conv-m");
		await store.bind("sess-new", "conv-new");
		const raw = JSON.parse(readFileSync(path, "utf8"));
		expect(raw.version).toBe(2);
		expect(raw.sessions["sess-m"]).toEqual([{ conversationId: "conv-m", updatedAt: iso(-DAY_MS) }]);
	});

	test("migration tolerance: malformed entries degrade to an empty store; unknown version too", async () => {
		const dir = await mkdtemp("/tmp/agy-store-migbad-");
		const path = join(dir, "opencode-sessions.json");
		writeFileSync(path, JSON.stringify({ version: 1, sessions: { bad: { nope: true }, ok: { conversationId: 42 } } }));
		const store = openSessionStore(path);
		expect(await store.get("bad")).toBeUndefined();
		expect(await store.get("ok")).toBeUndefined();
		writeFileSync(path, JSON.stringify({ version: 99, sessions: { x: [] } }));
		expect(await store.get("x")).toBeUndefined();
	});

	test("resolve: exact-prefix pick — the binding whose hashes are a prefix of incoming wins", async () => {
		const { store } = await setup();
		await store.bind("sess-r", "conv-main", ["h0", "h1", "h2"]);
		await store.bind("sess-r", "conv-side", ["s0", "s1"]);
		const hit = await store.resolve("sess-r", ["h0", "h1", "h2", "h3"]);
		expect(hit?.conversationId).toBe("conv-main");
		const side = await store.resolve("sess-r", ["s0", "s1", "s2"]);
		expect(side?.conversationId).toBe("conv-side");
	});

	test("resolve: adopt-once — a binding without hashes matches when no prefix does", async () => {
		const { store } = await setup();
		await store.bind("sess-a", "conv-legacy");
		await store.bind("sess-a", "conv-other", ["x0"]);
		const hit = await store.resolve("sess-a", ["unrelated"]);
		expect(hit).toEqual({ conversationId: "conv-legacy" });
	});

	test("resolve: no match → undefined (fresh conversation)", async () => {
		const { store } = await setup();
		expect(await store.resolve("sess-empty", ["h0"])).toBeUndefined();
		await store.bind("sess-nomatch", "conv-1", ["a0"]);
		await store.bind("sess-nomatch", "conv-2", ["b0"]);
		expect(await store.resolve("sess-nomatch", ["zz"])).toBeUndefined();
	});

	test("bind upsert-by-conversationId updates the binding in place (list length unchanged)", async () => {
		const { path, store, tick } = await setupClock();
		await store.bind("sess-u", "conv-1", ["h0"]);
		tick();
		await store.bind("sess-u", "conv-1", ["h0", "h1"]);
		tick();
		await store.bind("sess-u", "conv-1");
		const raw = JSON.parse(readFileSync(path, "utf8"));
		expect(raw.sessions["sess-u"]).toHaveLength(1);
		expect(await store.getEntry("sess-u")).toEqual({ conversationId: "conv-1" });
	});

	test("bind linear continuation: a binding whose hashes are a prefix of the new ones is REPLACED, not appended", async () => {
		const { path, store, tick } = await setupClock();
		await store.bind("sess-lin", "conv-parent", ["h0", "h1"]);
		tick();
		await store.bind("sess-lin", "conv-child", ["h0", "h1", "h2"]);
		const raw = JSON.parse(readFileSync(path, "utf8"));
		expect(raw.sessions["sess-lin"]).toHaveLength(1);
		expect(await store.getEntry("sess-lin")).toEqual({ conversationId: "conv-child", hashes: ["h0", "h1", "h2"] });
	});

	test("bind unrelated conversation APPENDS a second binding; the first is untouched", async () => {
		const { store } = await setup();
		await store.bind("sess-multi", "conv-main", ["h0", "h1"]);
		await store.bind("sess-multi", "conv-side", ["s0"]);
		expect(await store.getEntry("sess-multi")).toEqual({ conversationId: "conv-side", hashes: ["s0"] });
		expect((await store.resolve("sess-multi", ["h0", "h1", "h2"]))?.conversationId).toBe("conv-main");
	});

	test("bind caps the list at 3 per session, evicting the oldest by updatedAt", async () => {
		const { path, store, tick } = await setupClock();
		await store.bind("sess-cap", "conv-1", ["a0"]);
		tick();
		await store.bind("sess-cap", "conv-2", ["b0"]);
		tick();
		await store.bind("sess-cap", "conv-3", ["c0"]);
		tick();
		await store.bind("sess-cap", "conv-4", ["d0"]);
		const raw = JSON.parse(readFileSync(path, "utf8"));
		expect(raw.sessions["sess-cap"]).toHaveLength(3);
		const ids = raw.sessions["sess-cap"].map((e: { conversationId: string }) => e.conversationId);
		expect(ids).toEqual(["conv-2", "conv-3", "conv-4"]);
		expect(await store.resolve("sess-cap", ["a0", "a1"])).toBeUndefined(); // evicted
		expect((await store.resolve("sess-cap", ["d0", "d1"]))?.conversationId).toBe("conv-4");
	});

	test("rebind with a conversationId drops ONLY that binding", async () => {
		const { store } = await setup();
		await store.bind("sess-rb", "conv-main", ["h0", "h1"]);
		await store.bind("sess-rb", "conv-side", ["s0"]);
		await store.rebind("sess-rb", "conv-side");
		expect(await store.resolve("sess-rb", ["s0", "s1"])).toBeUndefined();
		expect((await store.resolve("sess-rb", ["h0", "h1", "h2"]))?.conversationId).toBe("conv-main");
		await store.rebind("sess-rb", "conv-never-existed"); // no-op, no throw
		expect(await store.get("sess-rb")).toBe("conv-main");
	});

	test("prune on v2: stale bindings are dropped per-binding and emptied sessions removed", async () => {
		const dir = await mkdtemp("/tmp/agy-store-prune2-");
		const path = join(dir, "opencode-sessions.json");
		writeFileSync(
			path,
			JSON.stringify({
				version: 2,
				sessions: {
					"sess-p1": [
						{ conversationId: "conv-old", hashes: ["h0"], updatedAt: iso(-31 * DAY_MS) },
						{ conversationId: "conv-fresh", hashes: ["h1"], updatedAt: iso(-DAY_MS) },
					],
					"sess-p2": [{ conversationId: "conv-ancient", updatedAt: iso(-40 * DAY_MS) }],
				},
			}),
		);
		const store = openSessionStore(path);
		const pruned = await store.prune();
		expect(pruned).toBe(2);
		const raw = JSON.parse(readFileSync(path, "utf8"));
		expect(raw.sessions["sess-p1"]).toHaveLength(1);
		expect(raw.sessions["sess-p1"][0].conversationId).toBe("conv-fresh");
		expect(raw.sessions["sess-p2"]).toBeUndefined();
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
		expect(raw.sessions["sess-a"][0].conversationId).toBe("conv-a");
		expect(raw.sessions["sess-b"][0].conversationId).toBe("conv-b");
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
