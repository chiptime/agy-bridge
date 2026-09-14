/**
 * Unit tests for the turn orchestrator (design D2/D5/D7, spec R6/R7/R9,
 * threat-matrix argv composition): quota gate before any spawn, workdir
 * authority, timeout → exactly ONE resume via the captured conversationId
 * (before any text part could exist), second failure → non-retryable
 * TurnError carrying logPath, abort kills the child and persists the id,
 * hostile model ids reach agy as ONE argv element, and exactly one
 * --add-dir equal to the child cwd. Runs use a fake spawnImpl (engine
 * asSpawn pattern) and a recording SessionStore wrapper.
 *
 * v1.1 divergence policy: BEFORE the timeout-resume machinery, the stored
 * hashes baseline decides resume vs fresh re-seed — a stored PREFIX of the
 * incoming hashes (or a pre-upgrade entry without hashes, adopted once) is
 * linear and resumes; anything else is divergence: NO --conversation, the
 * seedPrompt is sent instead, onDiverged fires, and the fresh conversation
 * id + incoming hashes become the new baseline.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, utimes } from "node:fs/promises";
import { join } from "node:path";
import { runTurn, TurnError, type TurnDeps } from "../src/turn";
import { openSessionStore, type SessionStore } from "../src/session-store";
import { AgyConfigError, resolveConfig } from "../src/config";

/** Placeholder baseline for tests with no stored session (any value works). */
const H1 = ["h0"];

/** Minimal ChildProcess stand-in: scripted NDJSON lines, then exit/close. */
function fakeChild(opts: { lines?: unknown[]; exit?: number | null; hold?: boolean }) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const child: any = new EventEmitter();
	child.stdout = new Readable({ read() {} });
	child.stderr = new Readable({ read() {} });
	const stdinChunks: Buffer[] = [];
	child.stdin = new Writable({
		write(chunk, _encoding, callback) {
			stdinChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			callback();
		},
	});
	child.stdinText = () => Buffer.concat(stdinChunks).toString("utf8");
	child.killed = false;
	child.kill = () => {
		child.killed = true;
		queueMicrotask(() => child.emit("close", null, "SIGTERM"));
		return true;
	};
	for (const line of opts.lines ?? []) {
		child.stdout.push(Buffer.from(`${JSON.stringify(line)}\n`));
	}
	if (!opts.hold) setTimeout(() => child.emit("close", opts.exit ?? 0, null), 10);
	return child;
}

const SUCCESS = (conversationId: string) => ({
	event: "result",
	result: { conversation_id: conversationId, status: "SUCCESS", response: "done" },
});

/** Recording store wrapper: real file store underneath, call log on top. */
function recordingStore(path: string): { store: SessionStore; calls: string[] } {
	const real = openSessionStore(path);
	const calls: string[] = [];
	return {
		calls,
		store: {
			get: (id) => real.get(id),
			getEntry: (id) => real.getEntry(id),
			resolve: (id, hashes) => real.resolve(id, hashes),
			bind: (id, conv, hashes) => {
				calls.push(`bind:${conv}`);
				return real.bind(id, conv, hashes);
			},
			rebind: (id, conversationId) => {
				calls.push("rebind");
				return real.rebind(id, conversationId);
			},
			prune: (now) => real.prune(now),
		},
	};
}

async function setup(spawnFn?: unknown, depsOverride: Partial<TurnDeps> = {}) {
	const root = await mkdtemp("/tmp/agy-turn-");
	const { store, calls } = recordingStore(join(root, "sessions.json"));
	const deps: TurnDeps = {
		bin: "agy",
		config: resolveConfig({ scratchRoot: root, timeoutMs: 30_000 }),
		store,
		spawnFn: spawnFn as never,
		...depsOverride,
	};
	return { root, store, calls, deps };
}

describe("unit: turn — argv authority, quota gate, resume-once, abort (D2/D5/D7)", () => {
	test("threat: hostile model id is ONE argv element; one --add-dir === cwd; stale scratch pruned", async () => {
		const { root, calls, deps } = await setup((_bin: string, args: string[], opts: { cwd: string }) => {
			calls.push("spawn");
			expect(opts.cwd.startsWith(join(root, "agy-run-"))).toBe(true);
			return fakeChild({ lines: [{ event: "init", conversation_id: "conv-ok" }, SUCCESS("conv-ok")], exit: 0 });
		});
		const stale = join(root, "agy-run-stale");
		mkdirSync(stale);
		writeFileSync(join(stale, "junk.txt"), "x");
		const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		await utimes(stale, old, old);
		const evil = `evil'; rm -rf ~ && echo "pwned";`;
		const result = await runTurn(deps, { prompt: "hi there", hashes: H1, modelArg: evil, sessionId: "sess-argv" });
		expect(result.classification.outcome).toBe("success");
		expect(deps.config.scratchRoot).toBe(root);
		expect(calls).toEqual(["spawn", "bind:conv-ok"]);
		expect(readdirSync(stale)).toEqual([]);
	});

	test("threat: exactly one --add-dir and it equals the child cwd; hostile id never split", async () => {
		const spawns: Array<{ args: string[]; cwd: string }> = [];
		const { deps } = await setup((_bin: string, args: string[], opts: { cwd: string }) => {
			spawns.push({ args, cwd: opts.cwd });
			return fakeChild({ lines: [{ event: "init", conversation_id: "c" }, SUCCESS("c")], exit: 0 });
		});
		const evil = `x"; DROP TABLE; 'quote space`;
		await runTurn(deps, { prompt: "p", hashes: H1, modelArg: evil, sessionId: "s" });
		const { args, cwd } = spawns[0];
		expect(args.filter((a) => a === "--add-dir")).toHaveLength(1);
		expect(args[args.indexOf("--add-dir") + 1]).toBe(cwd);
		expect(args[args.indexOf("--model") + 1]).toBe(evil);
		expect(args.includes(evil)).toBe(true);
	});

	test("D5: timeout → ONE resume with the captured id (before any second spawn completes), then success", async () => {
		const events: string[] = [];
		const spawns: string[][] = [];
		const { store, deps } = await setup((_bin: string, args: string[]) => {
			spawns.push(args);
			events.push("spawn");
			return spawns.length === 1
				? fakeChild({ lines: [{ event: "init", conversation_id: "conv-1" }], exit: 124 })
				: fakeChild({ lines: [{ event: "init", conversation_id: "conv-2" }, SUCCESS("conv-2")], exit: 0 });
		});
		const result = await runTurn(deps, {
			prompt: "p",
			hashes: H1,
			sessionId: "sess-resume",
			onResume: () => events.push("resume"),
		});
		expect(result.classification.outcome).toBe("success");
		expect(result.resumed).toBe(true);
		expect(spawns).toHaveLength(2);
		expect(spawns[1][spawns[1].indexOf("--conversation") + 1]).toBe("conv-1");
		expect(events).toEqual(["spawn", "resume", "spawn"]);
		expect(await store.get("sess-resume")).toBe("conv-2");
	});

	test("D5: second failure is terminal — non-retryable TurnError with logPath; failed resume rebinds", async () => {
		const { calls, deps } = await setup(() =>
			fakeChild({ lines: [{ event: "init", conversation_id: "conv-x" }], exit: 124 }),
		);
		let caught: TurnError | undefined;
		try {
			await runTurn(deps, { prompt: "p", hashes: H1, sessionId: "sess-twice" });
		} catch (err) {
			caught = err as TurnError;
		}
		expect(caught).toBeInstanceOf(TurnError);
		expect(caught?.mapping.retryable).toBe(false);
		expect(caught?.mapping.resume).toBe(false);
		expect(caught?.mapping.message).toContain("/run.log");
		expect(calls).toContain("rebind");
	});

	test("D7: quota gate blocked → quota_unavailable TurnError with resetTime, NO spawn; unreadable fails open", async () => {
		const snapDir = await mkdtemp("/tmp/agy-quota-");
		const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		writeFileSync(
			join(snapDir, "gemini-5h.json"),
			JSON.stringify({ used: 99, limit: 100, resets_at: future, fetched_at: future }),
		);
		writeFileSync(
			join(snapDir, "gemini-weekly.json"),
			JSON.stringify({ used: 1, limit: 100, resets_at: future, fetched_at: future }),
		);
		let spawned = 0;
		const blockedSetup = await setup(() => {
			spawned++;
			return fakeChild({ lines: [SUCCESS("c")], exit: 0 });
		});
		blockedSetup.deps.config = resolveConfig({
			scratchRoot: "/tmp",
			timeoutMs: 30_000,
			quotaSnapshotDir: snapDir,
		});
		let caught: TurnError | undefined;
		try {
		await runTurn(blockedSetup.deps, {
			prompt: "p",
			hashes: H1,
			modelArg: "gemini-3.8-flash-high",
			sessionId: "s",
		});
		} catch (err) {
			caught = err as TurnError;
		}
		expect(caught).toBeInstanceOf(TurnError);
		expect(caught?.mapping.message).toMatch(/quota/i);
		expect(caught?.mapping.message).toContain(future);
		expect(spawned).toBe(0);
		const open = await setup(() => {
			spawned++;
			return fakeChild({ lines: [SUCCESS("c")], exit: 0 });
		});
		open.deps.config = resolveConfig({ scratchRoot: "/tmp", timeoutMs: 30_000, quotaSnapshotDir: "/nonexistent-snapshot" });
		const ok = await runTurn(open.deps, { prompt: "p", hashes: H1, sessionId: "s2" });
		expect(ok.classification.outcome).toBe("success");
		expect(spawned).toBe(1);
	});

	test("D2: abort kills the child and persists the tapped conversationId, then rejects AbortError", async () => {
		const controller = new AbortController();
		const { store, deps } = await setup(() =>
			fakeChild({ lines: [{ event: "init", conversation_id: "conv-ab" }], hold: true }),
		);
		const promise = runTurn(deps, { prompt: "p", hashes: H1, sessionId: "sess-ab", signal: controller.signal });
		setTimeout(() => controller.abort(), 20);
		let name = "";
		await promise.catch((err: Error) => {
			name = err.name;
		});
		expect(name).toBe("AbortError");
		expect(await store.get("sess-ab")).toBe("conv-ab");
	});

	test("session mode: worktree is the cwd and the single --add-dir; invalid worktree never spawns", async () => {
		const worktree = await mkdtemp("/tmp/agy-turn-wt-");
		const spawns: Array<{ args: string[]; cwd: string }> = [];
		const { deps } = await setup((_bin: string, args: string[], opts: { cwd: string }) => {
			spawns.push({ args, cwd: opts.cwd });
			return fakeChild({ lines: [SUCCESS("c")], exit: 0 });
		});
		deps.config = resolveConfig({ workdirMode: "session", timeoutMs: 30_000 });
		const result = await runTurn({ ...deps, worktree }, { prompt: "p", hashes: H1, sessionId: "s" });
		expect(result.classification.outcome).toBe("success");
		expect(result.logPath).toBe(join(worktree, "run.log"));
		expect(spawns[0].cwd).toBe(worktree);
		expect(spawns[0].args[spawns[0].args.indexOf("--add-dir") + 1]).toBe(worktree);

		const missing = await setup(() => {
			throw new Error("must not spawn");
		});
		missing.deps.config = resolveConfig({ workdirMode: "session", timeoutMs: 30_000 });
		await expect(
			runTurn({ ...missing.deps, worktree: "relative/path" }, { prompt: "p", hashes: H1, sessionId: "s" }),
		).rejects.toThrow(AgyConfigError);
	});
});

describe("unit: turn — v1.1 divergence policy (resume vs fresh re-seed)", () => {
	test("linear continuation: stored hashes are a PREFIX of incoming → resume --conversation; success stores the incoming hashes", async () => {
		const spawns: string[][] = [];
		const { store, deps } = await setup((_bin: string, args: string[]) => {
			spawns.push(args);
			return fakeChild({ lines: [{ event: "init", conversation_id: "conv-next" }, SUCCESS("conv-next")], exit: 0 });
		});
		await store.bind("sess-lin", "conv-stored", ["h0", "h1"]);
		const result = await runTurn(deps, { prompt: "p", hashes: ["h0", "h1", "h2"], sessionId: "sess-lin" });
		expect(result.classification.outcome).toBe("success");
		expect(result.diverged).toBe(false);
		expect(spawns).toHaveLength(1);
		expect(spawns[0][spawns[0].indexOf("--conversation") + 1]).toBe("conv-stored");
		expect(await store.getEntry("sess-lin")).toEqual({
			conversationId: "conv-next",
			hashes: ["h0", "h1", "h2"],
		});
	});

	test("divergence: edited middle message → NO --conversation, the seedPrompt is sent, onDiverged fires, fresh id + incoming hashes bound", async () => {
		let lastChild: any;
		const spawns: string[][] = [];
		const events: string[] = [];
		const { store, deps } = await setup((_bin: string, args: string[]) => {
			spawns.push(args);
			lastChild = fakeChild({ lines: [{ event: "init", conversation_id: "conv-fresh" }, SUCCESS("conv-fresh")], exit: 0 });
			return lastChild;
		});
		await store.bind("sess-div", "conv-stale", ["h0", "h1"]);
		const result = await runTurn(deps, {
			prompt: "last turn only",
			seedPrompt: "--- Previous conversation ---\nseeded visible thread\n--- End ---\n\nlast turn only",
			hashes: ["h0", "EDITED", "h2"],
			sessionId: "sess-div",
			onDiverged: () => events.push("diverged"),
		});
		expect(result.diverged).toBe(true);
		expect(events).toEqual(["diverged"]);
		expect(spawns).toHaveLength(1);
		expect(spawns[0]).not.toContain("--conversation");
		// The prompt rides stdin as stream-json user event, never argv --print (promptViaStdin: true).
		expect(spawns[0]).not.toContain("--print");
		expect(lastChild.stdinText()).toContain("seeded visible thread");
		expect(await store.getEntry("sess-div")).toEqual({
			conversationId: "conv-fresh",
			hashes: ["h0", "EDITED", "h2"],
		});
	});

	test("unknown baseline: pre-upgrade entry without hashes ADOPTS the baseline — resume with --conversation, hashes stored after", async () => {
		const spawns: string[][] = [];
		const { store, deps } = await setup((_bin: string, args: string[]) => {
			spawns.push(args);
			return fakeChild({ lines: [{ event: "init", conversation_id: "conv-adopt" }, SUCCESS("conv-adopt")], exit: 0 });
		});
		await store.bind("sess-adopt", "conv-old"); // pre-upgrade entry: no hashes
		const result = await runTurn(deps, { prompt: "p", hashes: ["h0"], sessionId: "sess-adopt" });
		expect(result.diverged).toBe(false);
		expect(spawns[0][spawns[0].indexOf("--conversation") + 1]).toBe("conv-old");
		expect(await store.getEntry("sess-adopt")).toEqual({ conversationId: "conv-adopt", hashes: ["h0"] });
	});

	test("divergence keeps resume-once coherent: a timeout on the seeded run resumes the SEEDED conversation", async () => {
		const spawns: string[][] = [];
		const { store, deps } = await setup((_bin: string, args: string[]) => {
			spawns.push(args);
			return spawns.length === 1
				? fakeChild({ lines: [{ event: "init", conversation_id: "conv-seed-1" }], exit: 124 })
				: fakeChild({ lines: [{ event: "init", conversation_id: "conv-seed-2" }, SUCCESS("conv-seed-2")], exit: 0 });
		});
		await store.bind("sess-div2", "conv-stale", ["h0", "h1"]);
		const result = await runTurn(deps, {
			prompt: "last turn",
			seedPrompt: "SEEDED",
			hashes: ["h0", "EDITED"],
			sessionId: "sess-div2",
		});
		expect(result.diverged).toBe(true);
		expect(result.resumed).toBe(true);
		// The resume continues the fresh SEEDED conversation, not the stale one.
		expect(spawns[1][spawns[1].indexOf("--conversation") + 1]).toBe("conv-seed-1");
		expect(await store.getEntry("sess-div2")).toEqual({
			conversationId: "conv-seed-2",
			hashes: ["h0", "EDITED"],
		});
	});

	test("v2 multi-conversation: a diverged turn APPENDS a new binding instead of overwriting the old one", async () => {
		const { store, deps } = await setup(() =>
			fakeChild({ lines: [{ event: "init", conversation_id: "conv-side" }, SUCCESS("conv-side")], exit: 0 }),
		);
		await store.bind("sess-side", "conv-main", ["m0", "m1"]);
		const result = await runTurn(deps, {
			prompt: "side task",
			seedPrompt: "SEEDED SIDE",
			hashes: ["s0", "s1"],
			sessionId: "sess-side",
		});
		expect(result.diverged).toBe(true);
		// Both bindings survive: the main thread keeps its baseline, the side
		// conversation got its own entry.
		expect((await store.resolve("sess-side", ["m0", "m1", "m2"]))?.conversationId).toBe("conv-main");
		expect((await store.resolve("sess-side", ["s0", "s1", "s2"]))?.conversationId).toBe("conv-side");
	});

	test("v2 wiring: the turn fires store.prune() fire-and-forget next to pruneScratch", async () => {
		const root = await mkdtemp("/tmp/agy-turn-prune-");
		let pruned = 0;
		const real = openSessionStore(join(root, "sessions.json"));
		const store: SessionStore = {
			get: (id) => real.get(id),
			getEntry: (id) => real.getEntry(id),
			resolve: (id, hashes) => real.resolve(id, hashes),
			bind: (id, conv, hashes) => real.bind(id, conv, hashes),
			rebind: (id, conversationId) => real.rebind(id, conversationId),
			prune: (now) => {
				pruned++;
				return real.prune(now);
			},
		};
		const deps: TurnDeps = {
			bin: "agy",
			config: resolveConfig({ scratchRoot: root, timeoutMs: 30_000 }),
			store,
			spawnFn: (() =>
				fakeChild({ lines: [{ event: "init", conversation_id: "conv-p" }, SUCCESS("conv-p")], exit: 0 })) as never,
		};
		const result = await runTurn(deps, {
			prompt: "p",
			hashes: H1,
			sessionId: "sess-prune",
		});
		expect(result.classification.outcome).toBe("success");
		expect(pruned).toBe(1);
	});
});

describe("unit: turn — prompt transport (promptViaStdin)", () => {
	test("promptViaStdin default true: prompt travels on stdin as stream-json user event; argv omits --print", async () => {
		let lastChild: any;
		const spawns: string[][] = [];
		const { deps } = await setup((_bin: string, args: string[]) => {
			spawns.push(args);
			lastChild = fakeChild({ lines: [{ event: "init", conversation_id: "c-stdin" }, SUCCESS("c-stdin")], exit: 0 });
			return lastChild;
		});
		await runTurn(deps, { prompt: "massive prompt payload", hashes: H1, sessionId: "s-stdin" });
		expect(spawns).toHaveLength(1);
		expect(spawns[0]).not.toContain("--print");
		expect(spawns[0]).toContain("--input-format");
		expect(spawns[0][spawns[0].indexOf("--input-format") + 1]).toBe("stream-json");
		expect(spawns[0]).toContain("--output-format");
		expect(spawns[0][spawns[0].indexOf("--output-format") + 1]).toBe("stream-json");
		const sent = JSON.parse(lastChild.stdinText().trim());
		expect(sent).toEqual({ event: "user", message: { role: "user", content: "massive prompt payload" } });
	});

	test("promptViaStdin override false: legacy transport puts prompt on argv with --print", async () => {
		const spawns: string[][] = [];
		const { deps } = await setup((_bin: string, args: string[]) => {
			spawns.push(args);
			return fakeChild({ lines: [{ event: "init", conversation_id: "c-argv" }, SUCCESS("c-argv")], exit: 0 });
		}, { promptViaStdin: false });
		await runTurn(deps, { prompt: "legacy prompt payload", hashes: H1, sessionId: "s-argv" });
		expect(spawns).toHaveLength(1);
		expect(spawns[0]).toContain("--print");
		expect(spawns[0][spawns[0].indexOf("--print") + 1]).toBe("legacy prompt payload");
	});
});


describe("unit: turn — image attachment bridge (spec image-input R2/R3/R6, design D1/D4/D7)", () => {
	// PR 3: runTurn stages TurnRequest.attachments under the turn workdir
	// (fake spawnFn integration — the runtime harness for this slice),
	// deterministically prepends the inspection directive to the spawned
	// prompt, taps view_file step lines to flip attachmentsInspected, and
	// (session mode) prunes stale hash-named entries alongside staging.
	const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
	const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 9]);
	const GIF_BYTES = new Uint8Array([0x47, 0x49, 0x46, 8]);
	const hashOf = (bytes: Uint8Array): string =>
		createHash("sha256").update(bytes).digest("hex").slice(0, 16);
	/** Realistic envelope-shaped tool step_update line object (fakeChild JSON-encodes it). */
	const toolStep = (tool: string, path: string) => ({
		event: "step_update",
		step_update: { step_type: "tool", state: "ACTIVE", tool_name: tool, tool_info: { path } },
	});

	test("stages one image under <workdir>/.agy-attachments and prepends the deterministic directive (stdin transport)", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let lastChild: any;
		const spawns: Array<{ args: string[]; cwd: string }> = [];
		const { deps } = await setup((_bin: string, args: string[], opts: { cwd: string }) => {
			spawns.push({ args, cwd: opts.cwd });
			lastChild = fakeChild({ lines: [{ event: "init", conversation_id: "c-img" }, SUCCESS("c-img")], exit: 0 });
			return lastChild;
		});
		const result = await runTurn(deps, {
			prompt: "what is this",
			hashes: H1,
			sessionId: "s-img",
			attachments: [{ data: PNG_BYTES, mediaType: "image/png" }],
		});
		expect(result.classification.outcome).toBe("success");
		const rel = `.agy-attachments/${hashOf(PNG_BYTES)}.png`;
		// Exactly one staged file, on disk, inside the scratch workdir the
		// child also ran in (the --add-dir exposure).
		expect(result.stagedAttachments).toEqual([rel]);
		expect(existsSync(join(spawns[0].cwd, rel))).toBe(true);
		// No view_file ran: the turn reports NOT inspected.
		expect(result.attachmentsInspected).toBe(false);
		// Deterministic directive (D1): fixed literal + staged relative path,
		// prepended to the prompt body riding stdin.
		const sent = JSON.parse(lastChild.stdinText().trim());
		expect(sent.message.content).toBe(
			`[Attached user image: ${rel}]\nPlease inspect each attached image above with view_file before responding.\n\nwhat is this`,
		);
	});

	test("three images stage with distinct references and all three ride the directive (spec R2 multi-image)", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let lastChild: any;
		const spawns: Array<{ cwd: string }> = [];
		const { deps } = await setup((_bin: string, _args: string[], opts: { cwd: string }) => {
			spawns.push({ cwd: opts.cwd });
			lastChild = fakeChild({ lines: [{ event: "init", conversation_id: "c-multi" }, SUCCESS("c-multi")], exit: 0 });
			return lastChild;
		});
		const result = await runTurn(deps, {
			prompt: "compare these",
			hashes: H1,
			sessionId: "s-multi",
			attachments: [
				{ data: PNG_BYTES, mediaType: "image/png" },
				{ data: JPEG_BYTES, mediaType: "image/jpeg" },
				{ data: GIF_BYTES, mediaType: "image/gif" },
			],
		});
		expect(result.classification.outcome).toBe("success");
		const rels = [
			`.agy-attachments/${hashOf(PNG_BYTES)}.png`,
			`.agy-attachments/${hashOf(JPEG_BYTES)}.jpg`,
			`.agy-attachments/${hashOf(GIF_BYTES)}.gif`,
		];
		expect(result.stagedAttachments).toEqual(rels);
		expect(new Set(result.stagedAttachments).size).toBe(3);
		for (const rel of rels) expect(existsSync(join(spawns[0].cwd, rel))).toBe(true);
		const content = JSON.parse(lastChild.stdinText().trim()).message.content as string;
		for (const rel of rels) expect(content).toContain(`[Attached user image: ${rel}]`);
		expect(content.endsWith("\n\ncompare these")).toBe(true);
	});

	test("a view_file step referencing the staged filename flips attachmentsInspected; other tools or paths do not", async () => {
		const pngRel = `.agy-attachments/${hashOf(PNG_BYTES)}.png`;
		const cases: Array<{ name: string; lines: unknown[]; want: boolean }> = [
			{
				name: "bash step never flips",
				lines: [{ event: "init", conversation_id: "c" }, toolStep("bash", "ls"), SUCCESS("c")],
				want: false,
			},
			{
				name: "view_file on an UNRELATED path never flips",
				lines: [{ event: "init", conversation_id: "c" }, toolStep("view_file", "src/other.ts"), SUCCESS("c")],
				want: false,
			},
			{
				name: "view_file referencing the staged basename flips",
				lines: [{ event: "init", conversation_id: "c" }, toolStep("view_file", pngRel), SUCCESS("c")],
				want: true,
			},
		];
		for (const c of cases) {
			const { deps } = await setup(() => fakeChild({ lines: c.lines, exit: 0 }));
			const result = await runTurn(deps, {
				prompt: "p",
				hashes: H1,
				sessionId: `s-flip-${c.name.replace(/\W+/g, "-")}`,
				attachments: [{ data: PNG_BYTES, mediaType: "image/png" }],
			});
			expect(result.classification.outcome, c.name).toBe("success");
			expect(result.attachmentsInspected, c.name).toBe(c.want);
		}
	});

	test("turns without attachments: no staged paths reported and inspection vacuously true", async () => {
		const { deps } = await setup(() => fakeChild({ lines: [{ event: "init", conversation_id: "c" }, SUCCESS("c")], exit: 0 }));
		const result = await runTurn(deps, { prompt: "p", hashes: H1, sessionId: "s-plain" });
		expect(result.classification.outcome).toBe("success");
		expect(result.stagedAttachments).toBeUndefined();
		expect(result.attachmentsInspected).toBe(true);
	});

	test("session mode: stale hash-named entries are pruned while the freshly staged file survives (spec R6 lifecycle)", async () => {
		const worktree = await mkdtemp("/tmp/agy-turn-att-");
		mkdirSync(join(worktree, ".agy-attachments"), { recursive: true });
		const staleRel = ".agy-attachments/deadbeefdeadbeef.png";
		writeFileSync(join(worktree, staleRel), "old");
		const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		await utimes(join(worktree, staleRel), old, old);
		const { deps } = await setup((_bin: string, _args: string[], _opts: { cwd: string }) =>
			fakeChild({ lines: [{ event: "init", conversation_id: "c-live" }, SUCCESS("c-live")], exit: 0 }),
		);
		deps.config = resolveConfig({ workdirMode: "session", timeoutMs: 30_000 });
		const result = await runTurn({ ...deps, worktree }, {
			prompt: "p",
			hashes: H1,
			sessionId: "s-live",
			attachments: [{ data: PNG_BYTES, mediaType: "image/png" }],
		});
		expect(result.classification.outcome).toBe("success");
		expect(existsSync(join(worktree, staleRel))).toBe(false);
		expect(existsSync(join(worktree, ".agy-attachments", `${hashOf(PNG_BYTES)}.png`))).toBe(true);
	});

	test("argv transport (--print): the directive rides the prompt value, never stdin", async () => {
		const spawns: string[][] = [];
		const { deps } = await setup((_bin: string, args: string[]) => {
			spawns.push(args);
			return fakeChild({ lines: [{ event: "init", conversation_id: "c-argv2" }, SUCCESS("c-argv2")], exit: 0 });
		}, { promptViaStdin: false });
		const rel = `.agy-attachments/${hashOf(PNG_BYTES)}.png`;
		await runTurn(deps, {
			prompt: "what is this",
			hashes: H1,
			sessionId: "s-argv2",
			attachments: [{ data: PNG_BYTES, mediaType: "image/png" }],
		});
		expect(spawns[0]).toContain("--print");
		expect(spawns[0][spawns[0].indexOf("--print") + 1]).toBe(
			`[Attached user image: ${rel}]\nPlease inspect each attached image above with view_file before responding.\n\nwhat is this`,
		);
	});

	test("divergence re-seed: the directive precedes the seedPrompt body (D1 — always delivered)", async () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		let lastChild: any;
		const { store, deps } = await setup(() => {
			lastChild = fakeChild({ lines: [{ event: "init", conversation_id: "c-seedy" }, SUCCESS("c-seedy")], exit: 0 });
			return lastChild;
		});
		await store.bind("s-seedy", "conv-stale", ["h0", "h1"]);
		const rel = `.agy-attachments/${hashOf(PNG_BYTES)}.png`;
		const result = await runTurn(deps, {
			prompt: "new turn",
			seedPrompt: "--- Previous conversation ---\nUser: old\n--- End ---\n\nnew turn",
			hashes: ["h0", "EDITED"],
			sessionId: "s-seedy",
			attachments: [{ data: PNG_BYTES, mediaType: "image/png" }],
		});
		expect(result.diverged).toBe(true);
		const content = JSON.parse(lastChild.stdinText().trim()).message.content as string;
		expect(content.startsWith(`[Attached user image: ${rel}]`)).toBe(true);
		expect(content).toContain("--- Previous conversation ---");
		expect(content.endsWith("\n\nnew turn")).toBe(true);
	});
});
