/**
 * Integration tests for the streamSimple event bridge (spec R3): the pi
 * StreamFunction contract — SYNCHRONOUS stream return, an async IIFE
 * driving exactly one engine turn (resume-once aside), and the
 * AssistantMessageEvent protocol over ONE shared mutated partial
 * (contentIndex 0 = thinking from formatStepUpdate'd step_updates,
 * contentIndex 1 = text from the result envelope). Covers the full event
 * sequence for a scripted NDJSON run, usage mapping, divergence re-seed
 * vs linear resume vs hash-less adoption (R7), resume-once on the timeout
 * family (R8), error terminals preserving retryability (mapClassification),
 * abort via options.signal killing the tapped child while preserving the
 * conversationId, and the session-store key derivation (options.sessionId
 * ?? cwd). Runs use a fake spawn (ChildProcess stand-in) and a real
 * file-backed session store in a tmp dir.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	UserMessage,
} from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import { messageHashes } from "agy-bridge-engine";
import { createStreamSimple } from "../src/stream-simple";
import { openSessionStore, type SessionStore } from "../src/session-store";

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

const MODEL: Model<Api> = {
	id: "default",
	name: "default",
	api: "agy-stream-json" as Api,
	provider: "agy",
	baseUrl: "agy://local",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
};

const USAGE_ENVELOPE = {
	input_tokens: 10,
	output_tokens: 20,
	thinking_tokens: 5,
	cache_read_tokens: 2,
	total_tokens: 30,
};

const STEP_TOOL_ACTIVE = { event: "step_update", step_update: { step_type: "tool", state: "ACTIVE", tool_name: "ls" } };
const STEP_RESPONSE = { event: "step_update", step_update: { step_type: "agent_response", state: "DONE", duration_seconds: 1.5 } };

const SUCCESS = (conversationId: string, response = "all done") => ({
	event: "result",
	result: { conversation_id: conversationId, status: "SUCCESS", response, usage: USAGE_ENVELOPE },
});

/** Minimal ChildProcess stand-in: scripted NDJSON lines, then exit/close. */
function fakeChild(opts: { lines?: unknown[]; exit?: number | null; hold?: boolean; rawLines?: string[] }) {
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
}

async function setup(spawnFn?: (rec: SpawnRecord) => unknown, opts: { workdir?: string } = {}) {
	const root = await mkdtemp(join(tmpdir(), "agy-pi-stream-"));
	const store = openSessionStore(join(root, "pi-sessions.json"));
	const spawns: SpawnRecord[] = [];
	const deps = {
		bin: "agy",
		store,
		timeoutMs: 30_000,
		...(opts.workdir !== undefined ? { workdir: opts.workdir } : {}),
		logRoot: root,
		spawnFn: ((bin: string, args: string[], io: { cwd: string }) => {
			const rec: SpawnRecord = { bin, args, cwd: io.cwd, child: undefined as never };
			spawns.push(rec);
			rec.child = spawnFn ? spawnFn(rec) : fakeChild({ lines: [SUCCESS("conv-1")] });
			return rec.child;
		}) as never,
	};
	const fn = createStreamSimple(deps);
	const drain = async (context: Context, options?: SimpleStreamOptions): Promise<AssistantMessageEvent[]> => {
		const stream = fn(MODEL, context, options) as AssistantMessageEventStream;
		// R3: the stream is returned SYNCHRONOUSLY — never a Promise.
		expect(stream).toBeDefined();
		expect((stream as unknown as { then?: unknown }).then).toBeUndefined();
		expect(typeof (stream as unknown as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function");
		const events: AssistantMessageEvent[] = [];
		for await (const ev of stream) events.push(ev);
		return events;
	};
	return { root, store, spawns, deps, drain };
}

const types = (events: AssistantMessageEvent[]) => events.map((e) => e.type);

// --- tests --------------------------------------------------------------------

describe("integration: streamSimple — event protocol (R3)", () => {
	test("synchronous return: not a Promise, async-iterable AssistantMessageEventStream", async () => {
		const { drain } = await setup();
		const context: Context = { messages: [userMsg("hi")] };
		const events = await drain(context, { sessionId: "s" });
		expect(types(events).at(-1)).toBe("done");
	});

	test("full scripted run: start → thinking(0, formatStepUpdate) → text(1, envelope) → done{stop}+usage; ONE shared mutated partial", async () => {
		const { drain } = await setup(() =>
			fakeChild({
				lines: [
					{ event: "init", conversation_id: "conv-9" },
					STEP_TOOL_ACTIVE,
					STEP_RESPONSE,
					SUCCESS("conv-9", "the answer"),
				],
				exit: 0,
			}),
		);
		const context: Context = { messages: [userMsg("hi")] };
		const events = await drain(context, { sessionId: "s-seq" });
		expect(types(events)).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"done",
		]);
		const thinkingStart = events[1] as Extract<AssistantMessageEvent, { type: "thinking_start" }>;
		const textStart = events[5] as Extract<AssistantMessageEvent, { type: "text_start" }>;
		expect(thinkingStart.contentIndex).toBe(0);
		expect(textStart.contentIndex).toBe(1);
		expect((events[2] as Extract<AssistantMessageEvent, { type: "thinking_delta" }>).delta).toBe("▸ tool ls…\n");
		expect((events[3] as Extract<AssistantMessageEvent, { type: "thinking_delta" }>).delta).toBe("● response (1.5s)\n");
		expect((events[6] as Extract<AssistantMessageEvent, { type: "text_delta" }>).delta).toBe("the answer");
		const done = events.at(-1) as Extract<AssistantMessageEvent, { type: "done" }>;
		expect(done.reason).toBe("stop");
		// ONE shared partial: the start event's partial IS the done message.
		const start = events[0] as Extract<AssistantMessageEvent, { type: "start" }>;
		expect(done.message).toBe(start.partial);
		expect(done.message.content[0]).toEqual({ type: "thinking", thinking: "▸ tool ls…\n● response (1.5s)\n" });
		expect(done.message.content[1]).toEqual({ type: "text", text: "the answer" });
		expect(done.message.stopReason).toBe("stop");
		// Usage maps from the envelope; cost stays zero.
		expect(done.message.usage.input).toBe(10);
		expect(done.message.usage.output).toBe(20);
		expect(done.message.usage.cacheRead).toBe(2);
		expect(done.message.usage.totalTokens).toBe(30);
		expect(done.message.usage.reasoning).toBe(5);
		expect(done.message.usage.cost.total).toBe(0);
	});

	test("no step_updates: no thinking block, text opens at contentIndex 0", async () => {
		const { drain } = await setup(() => fakeChild({ lines: [SUCCESS("conv-plain", "short")], exit: 0 }));
		const events = await drain({ messages: [userMsg("q")] }, { sessionId: "s-plain" });
		expect(types(events)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect((events[1] as Extract<AssistantMessageEvent, { type: "text_start" }>).contentIndex).toBe(0);
	});

	test("CRLF responses normalize to LF with no trailing whitespace", async () => {
		const { drain } = await setup(() => fakeChild({ lines: [SUCCESS("c", "a\r\nb\r\n\r\n")], exit: 0 }));
		const events = await drain({ messages: [userMsg("q")] }, { sessionId: "s-crlf" });
		expect((events[2] as Extract<AssistantMessageEvent, { type: "text_delta" }>).delta).toBe("a\nb");
	});

	test("empty response classifies terminal: error, not a fake success", async () => {
		const { drain } = await setup(() => fakeChild({ lines: [SUCCESS("c", "  ")], exit: 0 }));
		const events = await drain({ messages: [userMsg("q")] }, { sessionId: "s-empty" });
		const last = events.at(-1);
		expect(last?.type).toBe("error");
		if (last?.type === "error") {
			expect(last.reason).toBe("error");
			expect(last.error.errorMessage ?? "").toMatch(/empty|invalid/i);
		}
	});
});

describe("integration: streamSimple — session key, workdir, log containment", () => {
	test("options.sessionId keys the store; child cwd = deps.workdir; run.log lives under logRoot scratch, never the cwd", async () => {
		const workdir = await mkdtemp(join(tmpdir(), "agy-pi-wd-"));
		const { root, store, spawns, drain } = await setup(
			() => fakeChild({ lines: [{ event: "init", conversation_id: "conv-k" }, SUCCESS("conv-k")], exit: 0 }),
			{ workdir },
		);
		await drain({ messages: [userMsg("q")] }, { sessionId: "sess-key" });
		expect(await store.get("sess-key")).toBe("conv-k");
		expect(spawns[0].cwd).toBe(workdir);
		expect(spawns[0].args[spawns[0].args.indexOf("--add-dir") + 1]).toBe(workdir);
		// Log containment: a fresh agy-run-* dir under logRoot holds run.log.
		const scratch = readdirSync(root).filter((d) => d.startsWith("agy-run-"));
		expect(scratch.length).toBeGreaterThanOrEqual(1);
		expect(existsSync(join(root, scratch[0], "run.log"))).toBe(true);
		expect(readdirSync(workdir)).toEqual([]);
	});

	test("no sessionId: the cwd (options.cwd) is the store key", async () => {
		const { store, drain } = await setup(() =>
			fakeChild({ lines: [{ event: "init", conversation_id: "conv-cwd" }, SUCCESS("conv-cwd")], exit: 0 }),
		);
		await drain({ messages: [userMsg("q")] }, { cwd: "/tmp/pi-cwd-key" } as SimpleStreamOptions);
		expect(await store.get("/tmp/pi-cwd-key")).toBe("conv-cwd");
	});

	test("default child cwd is options.cwd when no deps.workdir is set", async () => {
		const { spawns, drain } = await setup(() => fakeChild({ lines: [SUCCESS("c")], exit: 0 }));
		await drain({ messages: [userMsg("q")] }, { cwd: "/tmp/pi-default-cwd" } as SimpleStreamOptions);
		expect(spawns[0].cwd).toBe("/tmp/pi-default-cwd");
	});
});

describe("integration: streamSimple — divergence policy (R7) + system-once (R4)", () => {
	test("fresh conversation: system text rides the prompt; success binds conversationId + incoming hashes", async () => {
		const { store, spawns, drain } = await setup(() =>
			fakeChild({ lines: [{ event: "init", conversation_id: "conv-a" }, SUCCESS("conv-a")], exit: 0 }),
		);
		const context: Context = { systemPrompt: "SYS-ONCE", messages: [userMsg("first")] };
		await drain(context, { sessionId: "s-fresh" });
		const prompt = spawns[0].args[spawns[0].args.indexOf("--print") + 1];
		expect(prompt).toBe("SYS-ONCE\n\nfirst");
		expect(spawns[0].args).not.toContain("--conversation");
		const entry = await store.getEntry("s-fresh");
		expect(entry?.conversationId).toBe("conv-a");
		expect(entry?.hashes).toEqual(messageHashes([{ role: "user", content: "first" }]));
	});

	test("linear continuation: stored hashes are a prefix → --conversation resume, NO system text", async () => {
		const { store, spawns, drain } = await setup(() =>
			fakeChild({ lines: [{ event: "init", conversation_id: "conv-next" }, SUCCESS("conv-next")], exit: 0 }),
		);
		const first: Context = { systemPrompt: "SYS-ONCE", messages: [userMsg("first")] };
		await drain(first, { sessionId: "s-lin" });
		const second: Context = {
			systemPrompt: "SYS-ONCE",
			messages: [userMsg("first"), assistantMsg("reply"), userMsg("second")],
		};
		await drain(second, { sessionId: "s-lin" });
		expect(spawns[1].args[spawns[1].args.indexOf("--conversation") + 1]).toBe("conv-next");
		const prompt2 = spawns[1].args[spawns[1].args.indexOf("--print") + 1];
		expect(prompt2).toBe("second");
		expect(prompt2).not.toContain("SYS-ONCE");
		expect((await store.getEntry("s-lin"))?.conversationId).toBe("conv-next");
	});

	test("divergence: edited history → NO --conversation, system + engine seed + last user in the prompt, fresh baseline stored", async () => {
		const { store, spawns, drain } = await setup(() =>
			fakeChild({ lines: [{ event: "init", conversation_id: "conv-fresh" }, SUCCESS("conv-fresh")], exit: 0 }),
		);
		const divergent: Context = {
			systemPrompt: "SYS-DIV",
			messages: [userMsg("old question"), assistantMsg("old answer"), userMsg("new question")],
		};
		const incomingHashes = messageHashes([
			{ role: "user", content: "old question" },
			{ role: "assistant", content: [{ type: "text", text: "old answer" }] },
			{ role: "user", content: "new question" },
		]);
		// Pre-bind a NON-prefix baseline (simulating an edited earlier turn).
		await store.bind("s-div", "conv-stale", ["deadbeef"]);
		await drain(divergent, { sessionId: "s-div" });
		expect(spawns[0].args).not.toContain("--conversation");
		const prompt = spawns[0].args[spawns[0].args.indexOf("--print") + 1];
		const sysAt = prompt.indexOf("SYS-DIV");
		const seedAt = prompt.indexOf("User: old question");
		const userAt = prompt.indexOf("new question");
		expect(sysAt).toBeGreaterThanOrEqual(0);
		expect(seedAt).toBeGreaterThan(sysAt);
		expect(userAt).toBeGreaterThan(seedAt);
		expect(prompt).toContain("Previous conversation");
		expect(await store.getEntry("s-div")).toEqual({ conversationId: "conv-fresh", hashes: incomingHashes });
	});

	test("hash-less entry adopts once: --conversation resume without system text, then a baseline is stored", async () => {
		const { store, spawns, drain } = await setup(() =>
			fakeChild({ lines: [{ event: "init", conversation_id: "conv-adopt" }, SUCCESS("conv-adopt")], exit: 0 }),
		);
		await store.bind("s-adopt", "conv-old"); // pre-upgrade entry: no hashes
		const context: Context = { systemPrompt: "SYS-ADOPT", messages: [userMsg("next")] };
		await drain(context, { sessionId: "s-adopt" });
		expect(spawns[0].args[spawns[0].args.indexOf("--conversation") + 1]).toBe("conv-old");
		const prompt = spawns[0].args[spawns[0].args.indexOf("--print") + 1];
		expect(prompt).toBe("next");
		expect(await store.getEntry("s-adopt")).toEqual({
			conversationId: "conv-adopt",
			hashes: messageHashes([{ role: "user", content: "next" }]),
		});
	});
});

describe("integration: streamSimple — resume-once, error terminals, abort (R8, R3)", () => {
	test("timeout → exactly ONE resume with the captured id, then success binds the resumed conversation", async () => {
		let attempt = 0;
		const { store, spawns, drain } = await setup(() =>
			++attempt === 1
				? fakeChild({ lines: [{ event: "init", conversation_id: "conv-1" }], exit: 124 })
				: fakeChild({ lines: [{ event: "init", conversation_id: "conv-2" }, SUCCESS("conv-2")], exit: 0 }),
		);
		const events = await drain({ messages: [userMsg("q")] }, { sessionId: "s-resume" });
		expect(spawns).toHaveLength(2);
		expect(spawns[1].args[spawns[1].args.indexOf("--conversation") + 1]).toBe("conv-1");
		expect(types(events).at(-1)).toBe("done");
		expect(await store.get("s-resume")).toBe("conv-2");
	});

	test("repeat timeout is terminal: rebind (fresh next turn), errorMessage carries the run.log path", async () => {
		const { store, spawns, drain } = await setup(() =>
			fakeChild({ lines: [{ event: "init", conversation_id: "conv-x" }], exit: 124 }),
		);
		const events = await drain({ messages: [userMsg("q")] }, { sessionId: "s-twice" });
		expect(spawns).toHaveLength(2);
		const last = events.at(-1);
		expect(last?.type).toBe("error");
		if (last?.type === "error") {
			expect(last.reason).toBe("error");
			expect(last.error.errorMessage ?? "").toContain("run.log");
		}
		expect(await store.getEntry("s-twice")).toBeUndefined();
	});

	test("task failure: error terminal with agy's detail text and the log path; store stays unbound", async () => {
		const { store, drain } = await setup(() =>
			fakeChild({
				lines: [{ event: "result", result: { status: "ERROR", error: "agy exploded" } }],
				exit: 1,
			}),
		);
		const events = await drain({ messages: [userMsg("q")] }, { sessionId: "s-fail" });
		const last = events.at(-1);
		expect(last?.type).toBe("error");
		if (last?.type === "error") {
			expect(last.reason).toBe("error");
			expect(last.error.errorMessage ?? "").toContain("agy exploded");
			expect(last.error.errorMessage ?? "").toContain("run.log");
			expect(last.error.stopReason).toBe("error");
		}
		expect(await store.getEntry("s-fail")).toBeUndefined();
	});

	test("transient outage: retryability preserved in the errorMessage", async () => {
		const { drain } = await setup(() =>
			fakeChild({ lines: [], rawLines: ["provider unavailable: 503"], exit: 1 }),
		);
		const events = await drain({ messages: [userMsg("q")] }, { sessionId: "s-outage" });
		const last = events.at(-1);
		expect(last?.type).toBe("error");
		if (last?.type === "error") expect(last.error.errorMessage ?? "").toContain("(retryable)");
	});

	test("abort mid-run: SIGTERMs the child, preserves the tapped conversationId, finalizes error{aborted}", async () => {
		const controller = new AbortController();
		const { store, spawns, drain } = await setup(() =>
			fakeChild({ lines: [{ event: "init", conversation_id: "conv-ab" }], hold: true }),
		);
		const promise = drain({ messages: [userMsg("q")] }, { sessionId: "s-ab", signal: controller.signal });
		setTimeout(() => controller.abort(), 25);
		const events = await promise;
		expect(spawns[0].child.killed).toBe(true);
		expect(await store.get("s-ab")).toBe("conv-ab");
		const last = events.at(-1);
		expect(last?.type).toBe("error");
		if (last?.type === "error") {
			expect(last.reason).toBe("aborted");
			expect(last.error.errorMessage ?? "").toMatch(/abort/i);
			expect(last.error.stopReason).toBe("aborted");
		}
	});

	test("abort before the run: error{aborted} terminal, zero spawns", async () => {
		const { spawns, drain } = await setup(() => {
			throw new Error("must not spawn");
		});
		const controller = new AbortController();
		controller.abort();
		const events = await drain({ messages: [userMsg("q")] }, { sessionId: "s-pre", signal: controller.signal });
		expect(spawns).toHaveLength(0);
		const last = events.at(-1);
		expect(last?.type).toBe("error");
		if (last?.type === "error") expect(last.reason).toBe("aborted");
	});
});

describe("integration: streamSimple — model resolution", () => {
	test("thinkingLevelMap routes the requested level to the full agy id; default entry omits --model", async () => {
		const { spawns, drain } = await setup(() => fakeChild({ lines: [SUCCESS("c")], exit: 0 }));
		const mappedModel: Model<Api> = {
			...MODEL,
			id: "gemini-3.8-flash",
			reasoning: true,
			thinkingLevelMap: {
				low: "gemini-3.8-flash-low",
				medium: "gemini-3.8-flash-medium",
				high: "gemini-3.8-flash-high",
			},
		};
		const fn = createStreamSimple({
			bin: "agy",
			store: openSessionStore(join(await mkdtemp(join(tmpdir(), "agy-pi-mr-")), "s.json")),
			timeoutMs: 30_000,
			spawnFn: (((_bin: string, args: string[]) => {
				spawns.push({ bin: _bin, args, cwd: "/w", child: fakeChild({ lines: [SUCCESS("c")] }) });
				return spawns.at(-1)!.child;
			}) as never),
		});
		const stream = fn(mappedModel, { messages: [userMsg("q")] }, { sessionId: "s-m1", reasoning: "high" });
		for await (const _ev of stream) {
			void _ev;
		}
		expect(spawns.at(-1)!.args[spawns.at(-1)!.args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");

		const stream2 = fn(MODEL, { messages: [userMsg("q")] }, { sessionId: "s-m2" });
		for await (const _ev of stream2) {
			void _ev;
		}
		expect(spawns.at(-1)!.args).not.toContain("--model");
	});
});

// The engine's run.log captures every streamed line (containment evidence).
describe("integration: streamSimple — run.log evidence", () => {
	test("scripted NDJSON lines land in the scratch run.log", async () => {
		const { root, drain } = await setup(() =>
			fakeChild({ lines: [{ event: "init", conversation_id: "c" }, STEP_TOOL_ACTIVE, SUCCESS("c")], exit: 0 }),
		);
		await drain({ messages: [userMsg("q")] }, { sessionId: "s-log" });
		const scratch = readdirSync(root).find((d) => d.startsWith("agy-run-"));
		expect(scratch).toBeDefined();
		const log = readFileSync(join(root, scratch!, "run.log"), "utf8");
		expect(log).toContain('"step_update"');
		expect(log).toContain('"result"');
	});
});
