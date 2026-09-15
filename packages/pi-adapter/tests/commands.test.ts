/**
 * Unit tests for the /agy command builders (spec R10): /agy status
 * reports bridge state (config summary without secrets, discovered
 * model count + discovery-cache age, the current session's binding
 * with its baseline size, in-flight turn), /agy clear drops the
 * current session's PERSISTED binding row (R5 key `sessionId ?? cwd`,
 * read from the command context) plus the in-memory registry entry,
 * and any other subcommand (including none) prints usage help.
 *
 * createAgyCommand returns the builder pi's registerCommand consumes
 * (description + handler); registration itself is D4's factory job.
 * Runs against a real file-backed store in a tmp dir and the real
 * lifecycle registry, with a stubbed ExtensionCommandContext.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AGY_USAGE_LINES, buildStatusLines, createAgyCommand, type AgyCommandDeps } from "../src/commands";
import { createBridgeState, DISCOVERY_TTL_MS, type BridgeState } from "../src/lifecycle";
import { openSessionStore } from "../src/session-store";

// --- fixtures -----------------------------------------------------------------

const ROWS = [
	{ id: "gemini-3.8-flash-high", name: "gemini-3.8-flash-high" },
	{ id: "gemini-3.8-flash-medium", name: "gemini-3.8-flash-medium" },
	{ id: "gemini-3.8-flash-low", name: "gemini-3.8-flash-low" },
];

interface Setup {
	deps: AgyCommandDeps;
	state: BridgeState;
	notifications: { message: string; type?: string }[];
	ctx: ExtensionCommandContext;
}

async function setup(
	opts: { sessionId?: string; cwd?: string; now?: () => number; state?: BridgeState; imageInput?: boolean } = {},
): Promise<Setup> {
	const root = await mkdtemp(join(tmpdir(), "agy-pi-cmds-"));
	const store = openSessionStore(join(root, "pi-sessions.json"));
	const state = opts.state ?? createBridgeState();
	const notifications: { message: string; type?: string }[] = [];
	const ctx = {
		ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
		cwd: opts.cwd ?? "/proj",
		sessionManager: { getSessionId: () => opts.sessionId ?? "sess-1" },
	} as unknown as ExtensionCommandContext;
	const deps: AgyCommandDeps = {
		bin: "/usr/bin/agy",
		timeoutMs: 30_000,
		stateDir: join(root, "state"),
		store,
		state,
		imageInput: opts.imageInput ?? false,
		...(opts.now !== undefined ? { now: opts.now } : {}),
	};
	return { deps, state, notifications, ctx };
}

// --- status ---------------------------------------------------------------------

describe("/agy status", () => {
	test("bound session: config summary, model count + cache age, binding with baseline, idle", async () => {
		const { deps } = await setup({ now: () => 20_000 });
		await deps.store.bind("sess-1", "conv-7", ["h1", "h2", "h3"]);
		deps.state.setDiscovery(ROWS, 18_000); // 2.0s old at now=20_000

		const lines = await buildStatusLines(deps, "sess-1");

		expect(lines.join("\n")).toContain("bin: /usr/bin/agy (timeout 30s)");
		expect(lines.join("\n")).toContain(`state: ${deps.stateDir}`);
		expect(lines.join("\n")).toContain("models: 3 discovered, cache 2.0s old (fresh)");
		expect(lines.join("\n")).toContain("session: conv-7 (3 hashes)");
		expect(lines.join("\n")).toContain("thread: none");
		expect(lines.join("\n")).toContain("turn: idle");
	});

	test("unbound session reports none", async () => {
		const { deps } = await setup();
		deps.state.setDiscovery(ROWS);
		const lines = await buildStatusLines(deps, "sess-1");
		expect(lines.join("\n")).toContain("session: none");
		expect(lines.join("\n")).toContain("thread: none");
	});

	test("hash-less binding reports an unknown baseline", async () => {
		const { deps } = await setup();
		await deps.store.bind("sess-1", "conv-legacy");
		const lines = await buildStatusLines(deps, "sess-1");
		expect(lines.join("\n")).toContain("session: conv-legacy (unknown baseline)");
		expect(lines.join("\n")).toContain("thread: none");
	});

	test("stale discovery cache and no cache are distinguishable", async () => {
		const stale = await setup({ now: () => DISCOVERY_TTL_MS + 5_000 });
		stale.deps.state.setDiscovery(ROWS, 0);
		expect((await buildStatusLines(stale.deps, "sess-1")).join("\n")).toContain("(stale)");

		const empty = await setup({ now: () => 1_000 });
		expect((await buildStatusLines(empty.deps, "sess-1")).join("\n")).toContain("models: no discovery cache");
	});

	test("in-flight turn is reported with its age", async () => {
		const { deps } = await setup({ now: () => 32_000 });
		deps.state.setDiscovery(ROWS);
		deps.state.beginTurn("sess-1", 20_000); // 12.0s in flight at now=32_000
		const lines = await buildStatusLines(deps, "sess-1");
		expect(lines.join("\n")).toContain("turn: in flight (12.0s)");
	});

	// --- pi-image-input: capability visibility in /agy status -------------------------

	test("images: enabled — reports the resolved imageInput flag truthfully", async () => {
		const { deps } = await setup({ imageInput: true });
		deps.state.setDiscovery(ROWS);
		const lines = await buildStatusLines(deps, "sess-1");
		expect(lines.join("\n")).toContain("images: enabled");
	});

	test("images: disabled — carries the enable hint naming both config paths", async () => {
		const { deps } = await setup({ imageInput: false });
		deps.state.setDiscovery(ROWS);
		const lines = await buildStatusLines(deps, "sess-1");
		const imagesLine = lines.find((l) => l.includes("images:"));
		expect(imagesLine).toBeDefined();
		expect(imagesLine).toBe(
			"  images: disabled — enable with imageInput: true in .pi/agy-bridge.json (project) or ~/.pi/agent/agy-bridge.json (global)",
		);
		// The images line sits in the config summary block, right after bin.
		const joined = lines.join("\n");
		expect(joined.indexOf("bin:")).toBeLessThan(joined.indexOf("images:"));
		expect(joined.indexOf("images:")).toBeLessThan(joined.indexOf("state:"));
	});

	test("handler dispatches status and notifies the joined lines", async () => {
		const { deps, ctx, notifications } = await setup({ now: () => 1_000 });
		await deps.store.bind("sess-1", "conv-7", ["h1"]);
		deps.state.setDiscovery(ROWS);
		const command = createAgyCommand(deps);
		expect(command.description).toBeTruthy();
		await command.handler("status", ctx);
		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.message).toContain("session: conv-7 (1 hashes)");
		expect(notifications[0]?.message).toContain("thread: none");
	});
});

// --- clear ------------------------------------------------------------------------

describe("/agy clear", () => {
	test("clears the persisted row for `sessionId ?? cwd` AND the thread row, plus both in-memory cache entries", async () => {
		const { deps, ctx, state, notifications } = await setup({ sessionId: "sess-1" });
		await deps.store.bind("sess-1", "conv-7", ["h1"]);
		await deps.store.bind("sess-1:ask", "conv-thread"); // v0.3: the thread row shares the session's fate
		await deps.store.bind("sess-other", "conv-9", ["h2"]); // sibling session must survive
		state.cacheBinding("sess-1", { conversationId: "conv-7", hashes: ["h1"] });
		state.cacheBinding("sess-1:ask", { conversationId: "conv-thread" });
		await state.lookupBinding(deps.store, "sess-other");

		await createAgyCommand(deps).handler("clear", ctx);

		await expect(deps.store.getEntry("sess-1")).resolves.toBeUndefined();
		await expect(deps.store.getEntry("sess-1:ask")).resolves.toBeUndefined();
		await expect(deps.store.getEntry("sess-other")).resolves.toEqual({
			conversationId: "conv-9",
			hashes: ["h2"],
		});
		// Only the sibling session's cache entry survives — BOTH sess-1 entries dropped.
		expect(state.snapshot().cachedBindings).toBe(1);
		await expect(state.lookupBinding(deps.store, "sess-1")).resolves.toBeUndefined();
		// Notify names whichever existed — here, both.
		expect(notifications[0]?.message).toContain("conv-7");
		expect(notifications[0]?.message).toContain("conv-thread");
	});

	test("falls back to the cwd key when the session has no id (thread row cleared too)", async () => {
		const { deps, ctx } = await setup({ sessionId: "", cwd: "/proj" });
		await deps.store.bind("/proj", "conv-cwd");
		await deps.store.bind("/proj:ask", "conv-cwd-thread");
		await createAgyCommand(deps).handler("clear", ctx);
		await expect(deps.store.getEntry("/proj")).resolves.toBeUndefined();
		await expect(deps.store.getEntry("/proj:ask")).resolves.toBeUndefined();
	});

	test("clearing an unbound session reports honestly and does not throw", async () => {
		const { deps, ctx, notifications } = await setup();
		await createAgyCommand(deps).handler("clear", ctx);
		expect(notifications[0]?.message).toContain("no agy binding");
	});
});

// --- v0.3 R5: thread binding visibility (D4/D5) -------------------------------------

describe("v0.3 R5: thread binding visibility", () => {
	test("status: bound thread shows `thread: <id> (resume-always)` between session and turn; never a hash count", async () => {
		const { deps } = await setup();
		await deps.store.bind("sess-1", "conv-7", ["h1"]);
		await deps.store.bind("sess-1:ask", "conv-thread");
		const lines = await buildStatusLines(deps, "sess-1");
		const threadLine = lines.find((l) => l.includes("thread:"));
		expect(threadLine).toBe("  thread: conv-thread (resume-always)"); // exact line, hash count impossible
		const joined = lines.join("\n");
		expect(joined).toContain("session: conv-7 (1 hashes)");
		// Order: the thread line sits BETWEEN the session and turn lines.
		expect(joined.indexOf("session: conv-7")).toBeLessThan(joined.indexOf("thread: conv-thread"));
		expect(joined.indexOf("thread: conv-thread")).toBeLessThan(joined.indexOf("turn:"));
	});

	test("clear with ONLY a thread row: the thread binding is cleared and named (session untouched)", async () => {
		const { deps, ctx, state, notifications } = await setup({ sessionId: "sess-1" });
		await deps.store.bind("sess-1:ask", "conv-thread");
		state.cacheBinding("sess-1:ask", { conversationId: "conv-thread" });
		await createAgyCommand(deps).handler("clear", ctx);
		await expect(deps.store.getEntry("sess-1:ask")).resolves.toBeUndefined();
		await expect(deps.store.getEntry("sess-1")).resolves.toBeUndefined(); // never bound — still absent
		expect(state.snapshot().cachedBindings).toBe(0);
		expect(notifications[0]?.message).toContain("conv-thread");
	});
});

// --- usage -------------------------------------------------------------------------

describe("/agy usage", () => {
	test("unknown subcommand prints usage help", async () => {
		const { deps, ctx, notifications } = await setup();
		await createAgyCommand(deps).handler("destroy-everything", ctx);
		expect(notifications[0]?.message).toBe(AGY_USAGE_LINES.join("\n"));
		expect(notifications[0]?.message).toContain("status");
		expect(notifications[0]?.message).toContain("clear");
		expect(deps.state.snapshot().inFlightTurns).toBe(0); // usage never mutates state
	});

	test("bare /agy (no subcommand) prints usage help too", async () => {
		const { deps, ctx, notifications } = await setup();
		await createAgyCommand(deps).handler("", ctx);
		expect(notifications[0]?.message).toBe(AGY_USAGE_LINES.join("\n"));
	});

	test("extra words after a known subcommand are ignored", async () => {
		const { deps, ctx, notifications } = await setup({ now: () => 1_000 });
		deps.state.setDiscovery(ROWS);
		await createAgyCommand(deps).handler("status --verbose please", ctx);
		expect(notifications[0]?.message).toContain("models: 3 discovered");
	});
});
