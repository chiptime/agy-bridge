/**
 * Unit tests for the AskAgy delegation tool (spec R9 + threat-matrix
 * "Git repository selection" row): scope containment (scratch default →
 * a FRESH agy-run-* tmp dir under the validated scratch root, never
 * ctx.cwd; worktree → exactly ctx.cwd), no caller-supplied path (extra
 * params or prompt text) ever becomes the workdir, isolated calls skip
 * persistent-store lookup/bind entirely and omit --conversation, the
 * skills catalog is injected ONLY on explicit opt-in via the injected
 * seam, exactly ONE engine run per call (runTurn reused, never
 * duplicated), onUpdate narrates step updates through formatStepUpdate,
 * the 7d scratch prune removes only stale agy-run-* dirs (foreign dirs
 * untouched), and hostile prompt text never reaches argv (D1 stdin
 * seam). Runs a fake spawn against the REAL engine runAgyStream with a
 * real file-backed store plus a spy wrapper counting every persistent
 * store touch.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { existsSync, mkdirSync, utimesSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { messageHashes } from "agy-bridge-engine";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAskAgyTool, type AskAgyDeps, type AskAgyParams } from "../src/ask-tool";
import { AgyConfigError } from "../src/config";
import { openSessionStore, type SessionStore } from "../src/session-store";
import type { PiAgyModel } from "../src/models";

// --- fixtures -----------------------------------------------------------------

const SUCCESS = (conversationId: string, response = "the answer") => ({
	event: "result",
	result: { conversation_id: conversationId, status: "SUCCESS", response },
});

/** Minimal ChildProcess stand-in: scripted NDJSON lines, stdin capture, exit/close. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeChild(opts: { lines?: unknown[]; exit?: number | null }) {
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
	for (const line of opts.lines ?? []) {
		child.stdout.push(Buffer.from(`${JSON.stringify(line)}\n`));
	}
	setTimeout(() => child.emit("close", opts.exit ?? 0, null), 10);
	return child;
}

interface SpawnRecord {
	bin: string;
	args: string[];
	cwd: string;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	child: any;
	/** Bytes written to the child's stdin (promptViaStdin evidence). */
	stdinText(): string;
}

/** Persistent-store spy: counts every touch so isolated rows can prove ZERO. */
interface StoreSpy {
	calls: { get: 0; getEntry: 0; bind: 0; rebind: 0; prune: 0 };
}

async function setup(script?: (rec: SpawnRecord, call: number) => unknown, depsOpts: Partial<AskAgyDeps> = {}) {
	const root = await mkdtemp(join(tmpdir(), "agy-pi-ask-"));
	const scratchRoot = join(root, "scratch");
	mkdirSync(scratchRoot);
	const ctxDir = join(root, "project");
	mkdirSync(ctxDir);
	const inner = openSessionStore(join(root, "pi-sessions.json"));
	const spy: StoreSpy = {
		calls: { get: 0, getEntry: 0, bind: 0, rebind: 0, prune: 0 },
	};
	const store: SessionStore = {
		get: (k) => (spy.calls.get++, inner.get(k)),
		getEntry: (k) => (spy.calls.getEntry++, inner.getEntry(k)),
		bind: (k, c, h) => (spy.calls.bind++, inner.bind(k, c, h)),
		rebind: (k) => (spy.calls.rebind++, inner.rebind(k)),
		prune: (n) => (spy.calls.prune++, inner.prune(n)),
	};
	const spawns: SpawnRecord[] = [];
	const deps: AskAgyDeps = {
		bin: "agy",
		store,
		scratchRoot,
		timeoutMs: 30_000,
		promptViaStdin: true,
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
					: fakeChild({ lines: [{ event: "init", conversation_id: "conv-1" }, SUCCESS("conv-1")] });
			return rec.child;
		}) as never,
		...depsOpts,
	};
	const tool = createAskAgyTool(deps);
	const updates: string[] = [];
	const run = (
		params: AskAgyParams & Record<string, unknown>,
		ctxOverrides: Partial<ExtensionContext> = {},
	): Promise<{ text: string; details: unknown }> =>
		tool
			.execute(
				"call-1",
				params as never,
				undefined,
				(u) => {
					const text = u.content.map((c) => (c.type === "text" ? c.text : "")).join("");
					if (text !== "") updates.push(text);
				},
				{ cwd: ctxDir, ...ctxOverrides } as ExtensionContext,
			)
			.then((r) => ({
				text: r.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
				details: r.details,
			}));
	return { root, scratchRoot, ctxDir, inner, spy, spawns, tool, updates, run };
}

const HOSTILE_PROMPT = "; $(id) | ` && rm -rf /\ncd /tmp/evil && cat /etc/shadow\nrun in /etc/passwd please";

/**
 * Content of the ONE NDJSON user envelope the corrected stdin transport
 * writes (stream-json input mode): the caller's prompt, byte-exact through
 * the JSON round-trip. Throws on any deviation so a malformed transport
 * fails loudly instead of silently passing.
 */
function stdinContent(rec: SpawnRecord): string {
	const raw = rec.stdinText();
	const lines = raw.split("\n").filter((l) => l !== "");
	if (lines.length !== 1) throw new Error(`expected exactly one NDJSON stdin line, got ${lines.length}: ${raw}`);
	const parsed = JSON.parse(lines[0]) as { event?: string; message?: { role?: string; content?: string } };
	if (parsed.event !== "user" || parsed.message?.role !== "user") {
		throw new Error(`expected a user envelope, got ${raw}`);
	}
	return parsed.message.content ?? "";
}
const DAY_MS = 86_400_000;

/** Registry fixture: default entry + one effort-collapsed base (models.ts shape). */
const REGISTRY: readonly PiAgyModel[] = [
	{ id: "default", name: "default", reasoning: false, limit: { context: 1, output: 1 } },
	{
		id: "gemini-3.8-flash",
		name: "gemini-3.8-flash",
		modelArg: "gemini-3.8-flash",
		reasoning: true,
		thinkingLevelMap: {
			minimal: null,
			low: null,
			medium: "gemini-3.8-flash-medium",
			high: "gemini-3.8-flash-high",
			xhigh: null,
			max: null,
		},
		limit: { context: 1, output: 1 },
	},
];

// --- tests --------------------------------------------------------------------

describe("unit: ask-tool — scope containment (R9, threat 'Git repository selection')", () => {
	test("THREAT default scope: child spawns in a FRESH agy-run-* dir under the validated scratch root, never ctx.cwd; exactly ONE engine run", async () => {
		const { scratchRoot, ctxDir, spawns, run } = await setup();
		const { text } = await run({ prompt: "list the files" });
		expect(spawns).toHaveLength(1); // one engine run per call — runTurn reused, not duplicated
		const cwd = spawns[0].cwd;
		expect(cwd.startsWith(join(scratchRoot, "agy-run-"))).toBe(true);
		expect(cwd).not.toBe(ctxDir);
		expect(basename(cwd).startsWith("agy-run-")).toBe(true);
		expect(text).toBe("the answer");
	});

	test("THREAT scope worktree: child cwd is exactly ctx.cwd", async () => {
		const { ctxDir, spawns, run } = await setup();
		await run({ prompt: "refactor this module", scope: "worktree" });
		expect(spawns[0].cwd).toBe(ctxDir);
	});

	test("THREAT caller-supplied paths: extra params and path-like prompt text NEVER move the workdir or argv (scratch scope)", async () => {
		const { scratchRoot, spawns, run } = await setup();
		await run({
			prompt: HOSTILE_PROMPT,
			cwd: "/etc",
			workdir: "/tmp/evil",
			workspace: "relative/escape",
		});
		const cwd = spawns[0].cwd;
		expect(cwd.startsWith(join(scratchRoot, "agy-run-"))).toBe(true);
		expect([cwd, ...spawns[0].args].some((a) => a.includes("/etc") || a.includes("/tmp/evil") || a.includes("relative/escape"))).toBe(
			false,
		);
	});

	test("THREAT hostile prompt, fixed workdir: argv byte-identical to a benign call; prompt rides stdin (D1 seam)", async () => {
		// Isolated calls: no store interplay, so the forwarded prompt is
		// EXACTLY the caller text and the argv comparison is pure.
		const { spawns, run } = await setup();
		await run({ prompt: "a perfectly benign question", scope: "worktree", isolated: true });
		await run({ prompt: HOSTILE_PROMPT, scope: "worktree", isolated: true });
		expect(spawns).toHaveLength(2);
		expect(spawns[1].args).toEqual(spawns[0].args); // argv unchanged by prompt content
		// The prompt rides stdin inside the ONE NDJSON user envelope, byte-exact.
		expect(stdinContent(spawns[0])).toBe("a perfectly benign question");
		expect(stdinContent(spawns[1])).toBe(HOSTILE_PROMPT);
	});

	test("THREAT isolated:true: no --conversation, persistent store NEVER read or written; two isolated calls both run fresh", async () => {
		const { spy, spawns, run } = await setup();
		await run({ prompt: "one-shot question", isolated: true });
		await run({ prompt: "another one-shot", isolated: true });
		expect(spawns).toHaveLength(2);
		for (const rec of spawns) expect(rec.args).not.toContain("--conversation");
		expect(spy.calls).toEqual({ get: 0, getEntry: 0, bind: 0, rebind: 0, prune: 0 });
	});

	test("default keeps continuity keyed by the pi session (ctx.cwd): stored entry resumes via --conversation, success rebinds", async () => {
		const { ctxDir, inner, spawns, run } = await setup();
		const prompt = "same self-contained question";
		await inner.bind(ctxDir, "conv-old", messageHashes([{ role: "user", content: prompt }]));
		const { details } = await run({ prompt });
		expect(spawns[0].args[spawns[0].args.indexOf("--conversation") + 1]).toBe("conv-old");
		expect(await inner.get(ctxDir)).toBe("conv-1");
		expect((details as { conversationId?: string }).conversationId).toBe("conv-1");
	});

	test("successive different prompts in one session follow the R7 table: diverged → fresh seeded conversation, prior prompt never resent as-is", async () => {
		const { ctxDir, inner, spawns, run } = await setup();
		await run({ prompt: "first task" });
		expect(await inner.get(ctxDir)).toBe("conv-1");
		const { details } = await run({ prompt: "second task" });
		// Non-prefix baseline (the new prompt replaced the old): the R7 table
		// starts a FRESH conversation (no --conversation conv-1) seeded with
		// the prior thread; the store rebinds to the new conversation.
		expect(spawns[1].args.some((a) => a === "conv-1")).toBe(false);
		expect(spawns[1].args).not.toContain("--conversation");
		expect(await inner.get(ctxDir)).toBe("conv-1"); // fixture returns the same id
		expect((details as { conversationId?: string }).conversationId).toBe("conv-1");
	});
});

describe("unit: ask-tool — skills catalog injection (R9)", () => {
	test("skills omitted and skills:false: NO catalog injected — stdin carries exactly the user prompt", async () => {
		// Isolated calls keep the forwarded prompt EXACTLY the caller text
		// (no divergence seed), so catalog absence is directly observable.
		const { spawns, run } = await setup(undefined, {
			skillsCatalog: () => "- my-skill: does things",
		});
		await run({ prompt: "plain question", isolated: true });
		await run({ prompt: "another question", skills: false, isolated: true });
		// The envelope's content carries EXACTLY the user prompt — no catalog.
		expect(stdinContent(spawns[0])).toBe("plain question");
		expect(stdinContent(spawns[1])).toBe("another question");
	});

	test("skills:true: the seam catalog section precedes the user prompt; an empty catalog injects nothing", async () => {
		const first = await setup(undefined, {
			skillsCatalog: () => "- my-skill: does things\n- other-skill: does other things",
		});
		await first.run({ prompt: "use a skill please", skills: true, isolated: true });
		const forwarded = stdinContent(first.spawns[0]);
		expect(forwarded).toContain("- my-skill: does things");
		expect(forwarded).toContain("use a skill please");
		expect(forwarded.indexOf("- my-skill:")).toBeLessThan(forwarded.indexOf("use a skill please"));
		const second = await setup(undefined, { skillsCatalog: () => "" });
		await second.run({ prompt: "no catalog anyway", skills: true, isolated: true });
		expect(stdinContent(second.spawns[0])).toBe("no catalog anyway");
	});
});

describe("unit: ask-tool — progress, prune, plumbing", () => {
	test("onUpdate receives readable progress lines (formatStepUpdate via the turn onStep hook)", async () => {
		const { updates, run } = await setup(() =>
			fakeChild({
				lines: [
					{ event: "step_update", step_update: { step_type: "tool", state: "ACTIVE", tool_name: "ls" } },
					{ event: "step_update", step_update: { step_type: "tool", state: "DONE", tool_name: "ls", duration_seconds: 0.4 } },
					SUCCESS("conv-p"),
				],
			}),
		);
		const { text } = await run({ prompt: "long task" });
		// v0.2 D2 behavior change: each update re-emits the JOINED segments so
		// far (cumulative snapshots), not a per-step line.
		expect(updates).toEqual(["▸ tool ls…\n", "▸ tool ls…\n✓ ls (0.4s)\n"]);
		expect(text).toBe("the answer");
	});

	test("7d prune: stale agy-run-* dirs removed; recent agy-run-* and foreign dirs untouched", async () => {
		const now = Date.now();
		const { scratchRoot, spawns, run } = await setup(undefined, { now: () => now });
		const stale = join(scratchRoot, "agy-run-stale");
		const recent = join(scratchRoot, "agy-run-recent");
		const foreign = join(scratchRoot, "foreign-old");
		for (const [dir, age] of [
			[stale, 8 * DAY_MS],
			[recent, 1 * DAY_MS],
			[foreign, 8 * DAY_MS],
		] as const) {
			mkdirSync(dir);
			const t = new Date(now - age);
			utimesSync(dir, t, t);
		}
		await run({ prompt: "prune check" });
		expect(spawns).toHaveLength(1);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(recent)).toBe(true);
		expect(existsSync(foreign)).toBe(true);
	});

	test("model/thinking plumbing: omitted → no --model; explicit id passes through; registry thinking routes to the full tier id", async () => {
		const { spawns, run } = await setup(undefined, { models: REGISTRY });
		await run({ prompt: "q1" });
		await run({ prompt: "q2", model: "some-unknown-id" });
		await run({ prompt: "q3", model: "gemini-3.8-flash", thinking: "high" });
		await run({ prompt: "q4", model: "gemini-3.8-flash", thinking: "low" });
		expect(spawns[0].args).not.toContain("--model");
		expect(spawns[1].args[spawns[1].args.indexOf("--model") + 1]).toBe("some-unknown-id");
		expect(spawns[2].args[spawns[2].args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-high");
		expect(spawns[3].args[spawns[3].args.indexOf("--model") + 1]).toBe("gemini-3.8-flash");
	});

	test("tool result: success content is the response text; details carry scope, workdir, logPath and conversationId", async () => {
		const { scratchRoot, run } = await setup();
		const { text, details } = await run({ prompt: "summarize" });
		expect(text).toBe("the answer");
		const d = details as {
			scope: string;
			isolated: boolean;
			workdir: string;
			logPath: string;
			conversationId?: string;
		};
		expect(d.scope).toBe("scratch");
		expect(d.isolated).toBe(false);
		expect(d.workdir.startsWith(join(scratchRoot, "agy-run-"))).toBe(true);
		expect(existsSync(d.logPath)).toBe(true);
		expect(d.conversationId).toBe("conv-1");
	});

	test("failure surfaces as tool text (never a throw): TurnError message with the run.log path", async () => {
		const { run } = await setup(() =>
			fakeChild({ lines: [{ event: "result", result: { status: "ERROR", error: "agy exploded" } }], exit: 1 }),
		);
		const { text } = await run({ prompt: "doomed" });
		expect(text).toContain("agy exploded");
		expect(text).toMatch(/run\.log/);
	});

	test("circular-delegation guard: an active agy provider refuses with zero spawns", async () => {
		const { spawns, run } = await setup();
		const { text } = await run({ prompt: "delegate" }, { model: { provider: "agy" } as ExtensionContext["model"] });
		expect(text).toContain("already");
		expect(spawns).toHaveLength(0);
	});
});

// --- v0.2 S2 R4: metadata overrides -----------------------------------------------

describe("unit: ask-tool — metadata overrides (v0.2 R4)", () => {
	test("configured name/label/description replace the v0.1 metadata", async () => {
		const { tool } = await setup(undefined, {
			metadata: { name: "AskSecond", label: "Second opinion", description: "custom description for the model" },
		});
		expect(tool.name).toBe("AskSecond");
		expect(tool.label).toBe("Second opinion");
		expect(tool.description).toBe("custom description for the model");
	});

	test("no metadata → v0.1 defaults intact (AskAgy / Ask agy / full description)", async () => {
		const { tool } = await setup();
		expect(tool.name).toBe("AskAgy");
		expect(tool.label).toBe("Ask agy");
		expect(tool.description).toContain("Delegate a self-contained sub-task to agy");
	});

	test("partial metadata: only the configured fields are overridden", async () => {
		const { tool } = await setup(undefined, { metadata: { name: "AskSecond" } });
		expect(tool.name).toBe("AskSecond");
		expect(tool.label).toBe("Ask agy");
		expect(tool.description).toContain("Delegate a self-contained sub-task to agy");
	});
});

// --- v0.2 S3 R5/D1: execution modes (THREAT rows precede the 3.4 GREEN) ---

/** Runtime shape of the mode union in the tool's TypeBox schema. */
function modeEnumOf(tool: { parameters: unknown }): string[] {
	const schema = tool.parameters as { properties: { mode?: { anyOf?: { const?: string }[] } } };
	return (schema.properties.mode?.anyOf ?? []).map((literal) => literal.const ?? "");
}

describe("unit: ask-tool — execution modes (v0.2 R5, D1)", () => {
	test("default mode read (no param, no defaultMode): spawned argv carries --mode plan", async () => {
		const { spawns, run } = await setup();
		const { text } = await run({ prompt: "read-only question" });
		expect(spawns[0].args[spawns[0].args.indexOf("--mode") + 1]).toBe("plan");
		expect(text).toBe("the answer");
	});

	test("mode:full → --mode accept-edits (v0.1 escalation; allowFullMode defaults true)", async () => {
		const { spawns, run } = await setup();
		await run({ prompt: "do the full task", mode: "full" });
		expect(spawns[0].args[spawns[0].args.indexOf("--mode") + 1]).toBe("accept-edits");
	});

	test("config defaultMode:none (no param): --mode plan AND forced scratch; details.scope reports scratch", async () => {
		const { scratchRoot, spawns, run } = await setup(undefined, { defaults: { defaultMode: "none" } });
		const { details } = await run({ prompt: "think, do not touch", scope: "worktree" });
		expect(spawns[0].args[spawns[0].args.indexOf("--mode") + 1]).toBe("plan");
		expect(spawns[0].cwd.startsWith(join(scratchRoot, "agy-run-"))).toBe(true);
		expect((details as { scope: string }).scope).toBe("scratch");
	});

	test("config defaultMode:full (no param): --mode accept-edits (explicit caller mode still wins)", async () => {
		const { spawns, run } = await setup(undefined, { defaults: { defaultMode: "full" } });
		await run({ prompt: "default full task" });
		expect(spawns[0].args[spawns[0].args.indexOf("--mode") + 1]).toBe("accept-edits");
	});

	test("THREAT mode:none + scope:worktree → FRESH scratch wins (mode coerces scope, never rejected); --mode plan; details.scope=scratch", async () => {
		const { scratchRoot, ctxDir, spawns, run } = await setup();
		const { details } = await run({ prompt: "just think", mode: "none", scope: "worktree" });
		expect((details as { scope: string }).scope).toBe("scratch");
		expect(spawns[0].cwd.startsWith(join(scratchRoot, "agy-run-"))).toBe(true);
		expect(spawns[0].cwd).not.toBe(ctxDir);
		expect(spawns[0].args[spawns[0].args.indexOf("--mode") + 1]).toBe("plan");
	});

	test("THREAT mode:read + scope:worktree → worktree honored (only none coerces); --mode plan", async () => {
		const { ctxDir, spawns, run } = await setup();
		await run({ prompt: "inspect this repo", mode: "read", scope: "worktree" });
		expect(spawns[0].cwd).toBe(ctxDir);
		expect(spawns[0].args[spawns[0].args.indexOf("--mode") + 1]).toBe("plan");
	});

	test("THREAT invalid mode value: AgyConfigError BEFORE any spawn (zero children)", async () => {
		const { spawns, run } = await setup();
		await expect(run({ prompt: "x", mode: "turbo" } as never)).rejects.toThrow(AgyConfigError);
		expect(spawns).toHaveLength(0);
	});

	test("THREAT allowFullMode:false: schema enum excludes full; requesting full fails closed (AgyConfigError → pi tool error text, NO spawn)", async () => {
		const { spawns, tool, run } = await setup(undefined, { defaults: { allowFullMode: false } });
		expect(modeEnumOf(tool)).toEqual(["read", "none"]);
		const err = await run({ prompt: "x", mode: "full" }).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(AgyConfigError);
		expect((err as Error).message).toContain("allowFullMode");
		expect(spawns).toHaveLength(0);
	});

	test("allowFullMode default (unset): schema enum keeps all three modes", async () => {
		const { tool } = await setup();
		expect(modeEnumOf(tool)).toEqual(["read", "none", "full"]);
	});
});

// --- v0.2 S5 R9/D2: partial-text onUpdate streaming --------------------------------

describe("v0.2 R9: onUpdate partial-text streaming (D2)", () => {
	test("every text_delta re-emits the JOINED partial text; delta steps add NO ▸ response narration", async () => {
		const { updates, run } = await setup(() =>
			fakeChild({
				lines: [
					{ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "AL" } },
					{ event: "step_update", step_update: { step_type: "agent_response", state: "DONE", text_delta: "PHA\n" } },
					{ event: "step_update", step_update: { step_type: "tool", state: "ACTIVE", tool_name: "ls" } },
					{ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "GAMMA" } },
					SUCCESS("conv-u", "ALPHA\nGAMMA"),
				],
			}),
		);
		const { text } = await run({ prompt: "stream please" });
		// Ordered segments (streamed text + narration), cumulative per update.
		expect(updates).toEqual(["AL", "ALPHA\n", "ALPHA\n▸ tool ls…\n", "ALPHA\n▸ tool ls…\nGAMMA"]);
		// The final tool result stays envelope-authoritative and unchanged.
		expect(text).toBe("ALPHA\nGAMMA");
	});

	test("narration-only delegation: cumulative snapshots of the v0.1 formatStepUpdate lines", async () => {
		const { updates, run } = await setup(() =>
			fakeChild({
				lines: [
					{ event: "step_update", step_update: { step_type: "tool", state: "ACTIVE", tool_name: "rg" } },
					{ event: "step_update", step_update: { step_type: "tool", state: "DONE", tool_name: "rg", duration_seconds: 0.2 } },
					SUCCESS("conv-n"),
				],
			}),
		);
		await run({ prompt: "narrate" });
		expect(updates).toEqual(["▸ tool rg…\n", "▸ tool rg…\n✓ rg (0.2s)\n"]);
	});
});
