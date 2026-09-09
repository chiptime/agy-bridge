/**
 * Unit tests for the turn orchestrator (design D2/D5/D7, spec R6/R7/R9,
 * threat-matrix argv composition): quota gate before any spawn, workdir
 * authority, timeout → exactly ONE resume via the captured conversationId
 * (before any text part could exist), second failure → non-retryable
 * TurnError carrying logPath, abort kills the child and persists the id,
 * hostile model ids reach agy as ONE argv element, and exactly one
 * --add-dir equal to the child cwd. Runs use a fake spawnImpl (engine
 * asSpawn pattern) and a recording SessionStore wrapper.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, utimes } from "node:fs/promises";
import { join } from "node:path";
import { runTurn, TurnError, type TurnDeps } from "../src/turn";
import { openSessionStore, type SessionStore } from "../src/session-store";
import { AgyConfigError, resolveConfig } from "../src/config";

/** Minimal ChildProcess stand-in: scripted NDJSON lines, then exit/close. */
function fakeChild(opts: { lines?: unknown[]; exit?: number | null; hold?: boolean }) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const child: any = new EventEmitter();
	child.stdout = new Readable({ read() {} });
	child.stderr = new Readable({ read() {} });
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
			bind: (id, conv) => {
				calls.push(`bind:${conv}`);
				return real.bind(id, conv);
			},
			rebind: (id) => {
				calls.push("rebind");
				return real.rebind(id);
			},
			prune: (now) => real.prune(now),
		},
	};
}

async function setup(spawnFn?: unknown) {
	const root = await mkdtemp("/tmp/agy-turn-");
	const { store, calls } = recordingStore(join(root, "sessions.json"));
	const deps: TurnDeps = {
		bin: "agy",
		config: resolveConfig({ scratchRoot: root, timeoutMs: 30_000 }),
		store,
		spawnFn: spawnFn as never,
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
		const result = await runTurn(deps, { prompt: "hi there", modelArg: evil, sessionId: "sess-argv" });
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
		await runTurn(deps, { prompt: "p", modelArg: evil, sessionId: "s" });
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
			await runTurn(deps, { prompt: "p", sessionId: "sess-twice" });
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
		const ok = await runTurn(open.deps, { prompt: "p", sessionId: "s2" });
		expect(ok.classification.outcome).toBe("success");
		expect(spawned).toBe(1);
	});

	test("D2: abort kills the child and persists the tapped conversationId, then rejects AbortError", async () => {
		const controller = new AbortController();
		const { store, deps } = await setup(() =>
			fakeChild({ lines: [{ event: "init", conversation_id: "conv-ab" }], hold: true }),
		);
		const promise = runTurn(deps, { prompt: "p", sessionId: "sess-ab", signal: controller.signal });
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
		const result = await runTurn({ ...deps, worktree }, { prompt: "p", sessionId: "s" });
		expect(result.classification.outcome).toBe("success");
		expect(result.logPath).toBe(join(worktree, "run.log"));
		expect(spawns[0].cwd).toBe(worktree);
		expect(spawns[0].args[spawns[0].args.indexOf("--add-dir") + 1]).toBe(worktree);

		const missing = await setup(() => {
			throw new Error("must not spawn");
		});
		missing.deps.config = resolveConfig({ workdirMode: "session", timeoutMs: 30_000 });
		await expect(
			runTurn({ ...missing.deps, worktree: "relative/path" }, { prompt: "p", sessionId: "s" }),
		).rejects.toThrow(AgyConfigError);
	});
});
