/**
 * Unit tests for the stdout tap (design D1/D2): a spawnImpl wrapper that
 * attaches a second 'data' listener on the child's stdout in the SAME
 * synchronous tick in which runAgyStream later attaches its readline — Node
 * then broadcasts every chunk to both consumers, so the live line tap loses
 * nothing while the engine keeps sole ownership of classification parsing.
 * The wrapper also retains the ChildProcess so abort can SIGTERM it; the
 * engine resolves SpawnRun normally and the tapped conversationId survives
 * as the resume handle.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { runAgyStream } from "agy-bridge-engine";
import { createTap } from "../src/stream-tap";

/** Minimal ChildProcess stand-in (engine asSpawn pattern): kill() fakes close. */
function fakeChild() {
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
	return child;
}
const ndjson = (obj: unknown) => Buffer.from(`${JSON.stringify(obj)}\n`);

async function runWith(child: unknown, spawnImpl: Parameters<typeof runAgyStream>[0]["spawnImpl"]) {
	const dir = await mkdtemp("/tmp/agy-tap-");
	return {
		dir,
		promise: runAgyStream({
			bin: "agy",
			prompt: "p",
			workdir: dir,
			timeoutMs: 30_000,
			stallMs: 0,
			spawnImpl,
		}),
	};
}

describe("unit: stream-tap — same-tick line tap (D1) and abort kill (D2)", () => {
	test("D1: the second data listener sees every line the engine sees; ids agree", async () => {
		const child = fakeChild();
		const lines: string[] = [];
		const tap = createTap((l) => lines.push(l), { spawnFn: () => child });
		const { promise } = await runWith(child, tap.spawnImpl);
		child.stdout.push(ndjson({ event: "init", conversation_id: "conv-tap" }));
		child.stdout.push(ndjson({ event: "step_update", step_update: { state: "ACTIVE" } }));
		child.stdout.push(ndjson({ event: "result", result: { status: "SUCCESS", response: "ok" } }));
		setTimeout(() => child.emit("close", 0, null), 10);
		const run = await promise;
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("conv-tap");
		expect(tap.conversationId).toBe("conv-tap");
		expect(run.conversationId).toBe("conv-tap");
		expect(run.envelope?.response).toBe("ok");
	});

	test("D1: a line split across chunks and two lines in one chunk reassemble exactly", async () => {
		const child = fakeChild();
		const lines: string[] = [];
		const tap = createTap((l) => lines.push(l), { spawnFn: () => child });
		const { promise } = await runWith(child, tap.spawnImpl);
		const whole = `{"event":"step_update","step_update":{"state":"ACTIVE"}}\n{"event":"step_update","step_update":{"state":"DONE"}}\n`;
		child.stdout.push(Buffer.from(whole.slice(0, 20)));
		child.stdout.push(Buffer.from(whole.slice(20)));
		setTimeout(() => child.emit("close", 0, null), 10);
		await promise;
		expect(lines).toHaveLength(2);
		expect(lines.every((l) => l.startsWith('{"event":"step_update"'))).toBe(true);
	});

	test("D2: abort() SIGTERMs the child; the tapped conversationId survives the kill", async () => {
		const child = fakeChild();
		const tap = createTap(undefined, { spawnFn: () => child });
		const { promise } = await runWith(child, tap.spawnImpl);
		child.stdout.push(ndjson({ event: "init", conversation_id: "conv-abort" }));
		await new Promise((r) => setTimeout(r, 5));
		tap.abort();
		expect(child.killed).toBe(true);
		const run = await promise;
		expect(run.conversationId).toBe("conv-abort");
		expect(tap.conversationId).toBe("conv-abort");
	});

	test("D2: an AbortSignal wired at creation kills the child when it fires", async () => {
		const child = fakeChild();
		const controller = new AbortController();
		const tap = createTap(undefined, { spawnFn: () => child, signal: controller.signal });
		const { promise } = await runWith(child, tap.spawnImpl);
		child.stdout.push(ndjson({ event: "init", conversation_id: "conv-sig" }));
		await new Promise((r) => setTimeout(r, 5));
		controller.abort();
		expect(child.killed).toBe(true);
		expect(tap.conversationId).toBe("conv-sig");
		await promise;
	});
});
