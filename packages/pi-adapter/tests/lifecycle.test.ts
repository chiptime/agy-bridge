/**
 * Unit + integration tests for the lifecycle registry (spec R6): the
 * in-memory state the bridge keeps in front of the persisted session
 * store (binding read-cache, per-key single-flight lookup slots,
 * in-flight turn tracking) plus the 24h models discovery cache.
 *
 * pi fires `session_start` (reason startup|reload|new|resume|fork) and
 * `session_shutdown` (reason quit|reload|new|resume|fork) on /new,
 * /resume, /fork and /reload — the events carry NO session id, so both
 * handlers must clear ALL in-memory state for ANY reason and never
 * latch: state populates again after a recycle. The discovery cache is
 * the documented exception (it survives recycle; /reload's
 * session_start reason "reload" rebuilds it through the injected seam).
 * The integration row runs the REAL runTurn (fake spawn, file store)
 * with the registry wired through TurnDeps.state.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { Context, SimpleStreamOptions, UserMessage } from "@earendil-works/pi-ai";
import {
	createBridgeState,
	createLifecycle,
	DISCOVERY_TTL_MS,
	type BridgeState,
} from "../src/lifecycle";
import { openSessionStore, type SessionEntry, type SessionStore } from "../src/session-store";
import { runTurn, type TurnDeps, type TurnRequest } from "../src/turn";

// --- fixtures -----------------------------------------------------------------

const ENTRY: SessionEntry = { conversationId: "conv-7", hashes: ["h1", "h2", "h3"] };

/** Store whose getEntry parks on a gate the test settles by hand. */
function deferredStore() {
	let calls = 0;
	let settle!: (entry: SessionEntry | undefined) => void;
	const gate = new Promise<SessionEntry | undefined>((resolve) => {
		settle = resolve;
	});
	const store: SessionStore = {
		get: async () => undefined,
		getEntry: async () => {
			calls++;
			return gate;
		},
		bind: async () => undefined,
		rebind: async () => undefined,
		prune: async () => 0,
	};
	return { store, calls: () => calls, settle: (entry: SessionEntry | undefined) => settle(entry) };
}

/** A plain store answering instantly with a fixed entry per key. */
function fixedStore(entryFor: (key: string) => SessionEntry | undefined): { store: SessionStore; calls: () => number } {
	let calls = 0;
	return {
		calls: () => calls,
		store: {
			get: async (key: string) => entryFor(key)?.conversationId,
			getEntry: async (key: string) => {
				calls++;
				return entryFor(key);
			},
			bind: async () => undefined,
			rebind: async () => undefined,
			prune: async () => 0,
		},
	};
}

/** Populate every in-memory structure so a recycle has something to clear. */
function populate(state: BridgeState, store: SessionStore): Promise<unknown> {
	const pending = state.lookupBinding(store, "sess-active"); // occupies a lookup slot
	state.cacheBinding("sess-cached", ENTRY);
	state.beginTurn("sess-active", 1_000);
	return pending;
}

const startEvent = (reason: SessionStartEvent["reason"]): SessionStartEvent => ({
	type: "session_start",
	reason,
});
const shutdownEvent = (reason: SessionShutdownEvent["reason"]): SessionShutdownEvent => ({
	type: "session_shutdown",
	reason,
});

// --- recycle contract (R6) ------------------------------------------------------

describe("lifecycle recycle", () => {
	test("session_start clears all in-memory state; a late lookup settle cannot resurrect it", async () => {
		const state = createBridgeState();
		const { store, calls, settle } = deferredStore();
		const pending = populate(state, store);
		expect(state.snapshot()).toEqual({ cachedBindings: 1, pendingLookups: 1, inFlightTurns: 1 });

		await createLifecycle({ state }).onSessionStart(startEvent("new"));

		expect(state.snapshot()).toEqual({ cachedBindings: 0, pendingLookups: 0, inFlightTurns: 0 });
		expect(state.currentTurn("sess-active")).toBeUndefined();
		settle(ENTRY);
		await expect(pending).resolves.toBe(ENTRY); // the awaiter still gets its answer
		expect(state.snapshot().cachedBindings).toBe(0); // …but nothing repopulates the cache
		expect(calls()).toBe(1); // the post-recycle lookup below is a fresh store read
		await expect(state.lookupBinding(store, "sess-active")).resolves.toBe(ENTRY);
		expect(calls()).toBe(2);
	});

	test("session_shutdown clears all in-memory state", async () => {
		const state = createBridgeState();
		const { store } = deferredStore();
		void populate(state, store); // pending lookup left in flight on purpose
		expect(state.snapshot()).toEqual({ cachedBindings: 1, pendingLookups: 1, inFlightTurns: 1 });

		await createLifecycle({ state }).onSessionShutdown(shutdownEvent("quit"));

		expect(state.snapshot()).toEqual({ cachedBindings: 0, pendingLookups: 0, inFlightTurns: 0 });
	});

	test("every session_start reason clears state — never latches", async () => {
		for (const reason of ["startup", "reload", "new", "resume", "fork"] as const) {
			const state = createBridgeState();
			const { store } = deferredStore();
			void populate(state, store);
			await createLifecycle({ state }).onSessionStart(startEvent(reason));
			expect(state.snapshot()).toEqual({ cachedBindings: 0, pendingLookups: 0, inFlightTurns: 0 });
		}
	});

	test("every session_shutdown reason clears state", async () => {
		for (const reason of ["quit", "reload", "new", "resume", "fork"] as const) {
			const state = createBridgeState();
			const { store } = deferredStore();
			void populate(state, store);
			await createLifecycle({ state }).onSessionShutdown(shutdownEvent(reason));
			expect(state.snapshot()).toEqual({ cachedBindings: 0, pendingLookups: 0, inFlightTurns: 0 });
		}
	});

	test("state is reusable after a recycle — clearing never latches", async () => {
		const state = createBridgeState();
		const { store } = fixedStore(() => ENTRY);

		await createLifecycle({ state }).onSessionStart(startEvent("new"));
		state.cacheBinding("k", ENTRY);
		state.beginTurn("k", 5_000);
		expect(state.snapshot()).toEqual({ cachedBindings: 1, pendingLookups: 0, inFlightTurns: 1 });

		await createLifecycle({ state }).onSessionShutdown(shutdownEvent("quit"));
		expect(state.snapshot()).toEqual({ cachedBindings: 0, pendingLookups: 0, inFlightTurns: 0 });

		state.cacheBinding("k", ENTRY);
		await expect(state.lookupBinding(store, "k")).resolves.toBe(ENTRY);
		expect(state.snapshot()).toEqual({ cachedBindings: 1, pendingLookups: 0, inFlightTurns: 0 });
	});

	test("in-flight tokens: endTurn removes only its own registration", () => {
		const state = createBridgeState();
		const first = state.beginTurn("k", 1);
		const second = state.beginTurn("k", 2);
		state.endTurn("k", first); // superseded registration — must not drop the live one
		expect(state.currentTurn("k")).toBe(second);
		state.endTurn("k", second);
		expect(state.currentTurn("k")).toBeUndefined();
	});

	test("noteConversationId surfaces on the live in-flight turn", () => {
		const state = createBridgeState();
		state.beginTurn("k", 1);
		state.noteConversationId("k", "conv-9");
		expect(state.currentTurn("k")?.conversationId).toBe("conv-9");
	});
});

// --- discovery cache (R2: 24h TTL; survives recycle) ----------------------------

describe("discovery cache", () => {
	test("survives session recycle — rows and fetchedAt untouched", async () => {
		const state = createBridgeState();
		const rows = [{ id: "gemini-3.8-flash-high", name: "gemini-3.8-flash-high" }];
		state.setDiscovery(rows, 10_000);

		await createLifecycle({ state }).onSessionStart(startEvent("new"));
		await createLifecycle({ state }).onSessionShutdown(shutdownEvent("reload"));

		const snapshot = state.discoverySnapshot(12_000);
		expect(snapshot?.rows).toBe(rows);
		expect(snapshot?.fetchedAt).toBe(10_000);
		expect(snapshot?.ageMs).toBe(2_000);
	});

	test("freshness flips at the 24h TTL boundary; never-populated has no snapshot", () => {
		const state = createBridgeState();
		state.setDiscovery([{ id: "default", name: "default" }], 0);
		expect(state.discoverySnapshot(DISCOVERY_TTL_MS - 1)?.fresh).toBe(true);
		expect(state.discoverySnapshot(DISCOVERY_TTL_MS)?.fresh).toBe(false);

		expect(createBridgeState().discoverySnapshot()).toBeUndefined();
	});
});

// --- /reload rebuild (design #3) -------------------------------------------------

describe("reload rebuild", () => {
	test("session_start reason reload rebuilds discovery exactly once", async () => {
		const state = createBridgeState();
		let rebuilds = 0;
		await createLifecycle({
			state,
			rebuildDiscovery: () => {
				rebuilds++;
			},
		}).onSessionStart(startEvent("reload"));
		expect(rebuilds).toBe(1);
	});

	test("no other start reason and no shutdown reason rebuilds", async () => {
		for (const reason of ["startup", "new", "resume", "fork"] as const) {
			let rebuilds = 0;
			await createLifecycle({
				state: createBridgeState(),
				rebuildDiscovery: () => {
					rebuilds++;
				},
			}).onSessionStart(startEvent(reason));
			expect(rebuilds).toBe(0);
		}
		for (const reason of ["quit", "reload", "new", "resume", "fork"] as const) {
			let rebuilds = 0;
			await createLifecycle({
				state: createBridgeState(),
				rebuildDiscovery: () => {
					rebuilds++;
				},
			}).onSessionShutdown(shutdownEvent(reason));
			expect(rebuilds).toBe(0);
		}
	});
});

// --- v0.2 S2 R3: one-time startup notice -----------------------------------------

/** pi passes (event, ctx: ExtensionContext) — the stub only needs hasUI + ui.notify. */
function noticeCtx(notes: string[], hasUI = true): never {
	return { hasUI, ui: { notify: (msg: string) => notes.push(msg) } } as never;
}

describe("startup notice (v0.2 R3)", () => {
	test("fires once per install via ctx.ui.notify when hasUI — later session_start events never repeat it", async () => {
		const state = createBridgeState();
		const notes: string[] = [];
		const lifecycle = createLifecycle({ state, startupNotice: "agy-bridge: notice text" });
		await lifecycle.onSessionStart(startEvent("startup"), noticeCtx(notes));
		expect(notes).toEqual(["agy-bridge: notice text"]);
		await lifecycle.onSessionStart(startEvent("new"), noticeCtx(notes));
		await lifecycle.onSessionStart(startEvent("reload"), noticeCtx(notes));
		expect(notes).toEqual(["agy-bridge: notice text"]); // one-time guard latched
	});

	test("no UI → never notifies, never throws (hasUI false, ctx without ui, absent ctx)", async () => {
		const state = createBridgeState();
		const notes: string[] = [];
		const lifecycle = createLifecycle({ state, startupNotice: "n" });
		await lifecycle.onSessionStart(startEvent("startup"), noticeCtx(notes, false));
		await lifecycle.onSessionStart(startEvent("new"), { cwd: "/p" } as never); // no ui at all
		await lifecycle.onSessionStart(startEvent("reload")); // pi always passes ctx; defensive absence must not throw
		expect(notes).toEqual([]);
		expect(state.snapshot()).toEqual({ cachedBindings: 0, pendingLookups: 0, inFlightTurns: 0 }); // recycle semantics intact
	});

	test("no startupNotice dep → handlers notify nothing (v0.1 behavior preserved)", async () => {
		const state = createBridgeState();
		const notes: string[] = [];
		const ctx = noticeCtx(notes);
		await createLifecycle({ state }).onSessionStart(startEvent("startup"), ctx);
		await createLifecycle({ state }).onSessionShutdown(shutdownEvent("quit"));
		expect(notes).toEqual([]);
	});
});

// --- binding cache semantics ------------------------------------------------------

describe("binding cache", () => {
	test("single-flight per key; defined entries cached, further lookups skip the store", async () => {
		const state = createBridgeState();
		const { store, calls, settle } = deferredStore();
		const first = state.lookupBinding(store, "k");
		const second = state.lookupBinding(store, "k");
		settle(ENTRY);
		expect(await first).toBe(ENTRY);
		expect(await second).toBe(ENTRY);
		expect(calls()).toBe(1); // both awaiters shared ONE store read

		await expect(state.lookupBinding(store, "k")).resolves.toBe(ENTRY);
		expect(calls()).toBe(1); // cache hit — store untouched

		await expect(state.lookupBinding(store, "other")).resolves.toBe(ENTRY);
		expect(calls()).toBe(2); // a different key still consults the store
	});

	test("unbound lookups are not cached — each re-reads the store", async () => {
		const state = createBridgeState();
		const { store, calls } = fixedStore(() => undefined);
		await expect(state.lookupBinding(store, "k")).resolves.toBeUndefined();
		await expect(state.lookupBinding(store, "k")).resolves.toBeUndefined();
		expect(calls()).toBe(2);
	});

	test("dropBinding and cacheBinding keep the cache coherent", async () => {
		const state = createBridgeState();
		const { store, calls } = fixedStore((key) => (key === "k" ? ENTRY : undefined));
		await expect(state.lookupBinding(store, "k")).resolves.toBe(ENTRY);
		state.dropBinding("k");
		await expect(state.lookupBinding(store, "k")).resolves.toBe(ENTRY);
		expect(calls()).toBe(2); // dropped → fresh read, not the stale cache
	});
});

// --- integration: registry wired through runTurn ----------------------------------

describe("runTurn wiring", () => {
	test("in-flight tracked for the turn's lifetime; cached binding serves the next turn", async () => {
		const root = await mkdtemp(join(tmpdir(), "agy-pi-lifecycle-"));
		const fileStore = openSessionStore(join(root, "pi-sessions.json"));
		let getEntryCalls = 0;
		const store: SessionStore = {
			...fileStore,
			getEntry: async (key: string) => {
				getEntryCalls++;
				return fileStore.getEntry(key);
			},
		};
		const state = createBridgeState();
		const spawnArgs: string[][] = [];
		const children: EventEmitter[] = [];
		let releaseFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const deps: TurnDeps = {
			bin: "agy",
			store,
			timeoutMs: 30_000,
			logRoot: root,
			state,
			spawnFn: ((bin: string, args: string[]) => {
				spawnArgs.push(args);
				const child = new EventEmitter();
				const out = new Readable({ read() {} });
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(child as any).stdout = out;
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(child as any).stderr = new Readable({ read() {} });
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(child as any).stdin = new Writable({
					write(_chunk: Buffer, _enc: string, cb: (err?: Error | null) => void) {
						cb();
					},
				});
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(child as any).killed = false;
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(child as any).kill = () => true;
				children.push(child);
				const script = (conversationId: string) => {
					out.push(Buffer.from(`${JSON.stringify({ event: "init", conversation_id: conversationId })}\n`));
					out.push(
						Buffer.from(
							`${JSON.stringify({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "ok" } })}\n`,
						),
					);
					setTimeout(() => child.emit("close", 0, null), 5);
				};
				if (children.length === 1) {
					void firstGate.then(() => script("conv-w")); // first run held until observed
				} else {
					script("conv-w");
				}
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				return child as any;
			}) as never,
		};
		const options: SimpleStreamOptions = { sessionId: "sess-wired" };
		const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 1 } as UserMessage] };
		const request = (): TurnRequest => ({ context, options });

		const run = runTurn(deps, request());
		for (let i = 0; i < 100 && state.currentTurn("sess-wired") === undefined; i++) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		const inFlight = state.currentTurn("sess-wired");
		expect(inFlight).toBeDefined();
		expect(typeof inFlight?.startedAt).toBe("number");
		releaseFirst?.();

		const result = await run;
		expect(result.conversationId).toBe("conv-w");
		expect(state.currentTurn("sess-wired")).toBeUndefined();
		expect(state.snapshot().cachedBindings).toBe(1);
		const readsAfterFirstTurn = getEntryCalls;

		// Second turn, same session: the cached binding serves the divergence
		// lookup (store NOT read again) and the turn resumes linearly.
		const result2 = await runTurn(deps, request());
		expect(result2.conversationId).toBe("conv-w");
		expect(result2.resumed).toBe(true);
		const resumedFlag = spawnArgs[1]?.indexOf("--conversation");
		expect(resumedFlag).toBeGreaterThanOrEqual(0);
		expect(spawnArgs[1]?.[resumedFlag + 1]).toBe("conv-w");
		expect(getEntryCalls).toBe(readsAfterFirstTurn);
	});
});
