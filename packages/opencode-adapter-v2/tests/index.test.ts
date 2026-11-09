/**
 * Unit tests for the opencode v2 plugin entry. opencode v2 (@opencode/plugin
 * 2.2.5) requires `export default { id, setup }`; setup receives a Context
 * whose domains replace the v1 hooks:
 *   chat.params     -> ctx.session.hook("context", ...)
 *   provider.models -> ctx.provider.transform(...)
 *   tool.{...}      -> ctx.tool.transform(...)
 * The mock ctx records every registration so the tests drive the callbacks
 * the way the host would.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pluginModule, { agyPluginV2, agyProviderInfo, resolveWorktree } from "../src/index";


/** Temporary dirs created by this file; removed after the run. */
const scratchDirs: string[] = [];
async function scratch(prefix: string): Promise<string> {
	const dir = await mkdtemp(prefix);
	scratchDirs.push(dir);
	return dir;
}
afterAll(async () => {
	await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

type Callback = (input: any) => unknown;

interface Recorded {
	sessionHooks: { name: string; callback: Callback; options?: unknown }[];
	providerTransforms: Callback[];
	toolTransforms: Callback[];
	reloads: number;
}

const GIT_LOCATION = {
	directory: "/repo/sub",
	project: { id: "prj_123", directory: "/repo", canonical: "/repo" },
};
const GLOBAL_LOCATION = {
	directory: "/home/u/scratch",
	project: { id: "global", directory: "/", canonical: "/" },
};

const DISCOVERED_SAMPLE = [
	{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
	{ id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
	{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
];

const registration = { dispose: async () => {} };

function mockCtx(location: unknown, options: Record<string, unknown> = {}) {
	const rec: Recorded = { sessionHooks: [], providerTransforms: [], toolTransforms: [], reloads: 0 };
	const ctx = {
		location,
		options,
		session: {
			hook: async (name: string, callback: Callback, hookOptions?: unknown) => {
				rec.sessionHooks.push({ name, callback, options: hookOptions });
				return registration;
			},
		},
		provider: {
			transform: async (callback: Callback) => {
				rec.providerTransforms.push(callback);
				return registration;
			},
			reload: async () => {
				rec.reloads++;
			},
		},
		tool: {
			transform: async (callback: Callback) => {
				rec.toolTransforms.push(callback);
				return registration;
			},
		},
	};
	return { ctx, rec };
}

async function setupWith(location: unknown, options: Record<string, unknown> = {}) {
	const stateDir = await scratch(join(tmpdir(), "agy-plugin-v2-"));
	const { ctx, rec } = mockCtx(location, { stateDir, ...options });
	await pluginModule.setup(ctx as never);
	return { ctx, rec, stateDir };
}

function contextHook(rec: Recorded): Callback {
	const hook = rec.sessionHooks.find((h) => h.name === "context");
	if (!hook) throw new Error("context hook not registered");
	return hook.callback;
}

function contextEvent(providerID: string, options: Record<string, unknown> = {}) {
	return {
		sessionID: "ses_abc",
		model: { providerID, id: "gemini-3.8-flash" },
		agent: "build",
		system: [],
		messages: [],
		tools: {},
		options,
	};
}

function providerEditor(hasAgy = true) {
	const sets: { providerID: string; models: any[] }[] = [];
	return {
		sets,
		editor: {
			get: (id: string) => (hasAgy && id === "agy" ? { provider: { id: "agy" }, models: new Map() } : undefined),
			models: { set: (providerID: string, models: any[]) => sets.push({ providerID, models }) },
		},
	};
}

function toolEditor() {
	const added: any[] = [];
	return { added, editor: { add: (tool: any) => added.push(tool) } };
}

/** Let the fire-and-forget discovery promise settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("v2 plugin module shape", () => {
	test("default export is { id, setup } with no v1 server key", () => {
		expect(pluginModule).toBe(agyPluginV2);
		expect(pluginModule.id).toBe("agy-bridge");
		expect(typeof pluginModule.setup).toBe("function");
		expect("server" in pluginModule).toBe(false);
	});
});

describe("context hook (v1 chat.params)", () => {
	test("sets sessionId, worktree and the agy record for an agy model", async () => {
		const { rec } = await setupWith(GIT_LOCATION);
		const hook = rec.sessionHooks.find((h) => h.name === "context");
		expect(hook?.options).toEqual({ providerID: "agy" });
		const event = contextEvent("agy", { otherPlugin: 1 });
		await contextHook(rec)(event);
		expect(event.options).toEqual({
			otherPlugin: 1,
			sessionId: "ses_abc",
			worktree: "/repo",
			agy: { sessionId: "ses_abc", worktree: "/repo" },
		});
	});

	test("no-ops for a non-agy provider", async () => {
		const { rec } = await setupWith(GIT_LOCATION);
		const event = contextEvent("anthropic", { keep: true });
		await contextHook(rec)(event);
		expect(event.options).toEqual({ keep: true });
	});

	test("never throws on a malformed event", async () => {
		const { rec } = await setupWith(GIT_LOCATION);
		expect(() => contextHook(rec)(null)).not.toThrow();
		expect(() => contextHook(rec)({ model: { providerID: "agy" } })).not.toThrow();
	});

	test("global project falls back to the location directory", async () => {
		const { rec } = await setupWith(GLOBAL_LOCATION);
		const event = contextEvent("agy");
		await contextHook(rec)(event);
		expect(event.options.worktree).toBe("/home/u/scratch");
	});
});

describe("resolveWorktree", () => {
	test("uses the project directory for a git project", () => {
		expect(resolveWorktree(GIT_LOCATION as never)).toBe("/repo");
	});
	test("uses the location directory for the global project", () => {
		expect(resolveWorktree(GLOBAL_LOCATION as never)).toBe("/home/u/scratch");
	});
	test("uses the location directory when project data is missing", () => {
		expect(resolveWorktree({ directory: "/x" } as never)).toBe("/x");
	});
});

describe("provider transform (v1 provider.models)", () => {
	test("setup never runs discovery; first transform starts it and reloads; next sets models", async () => {
		let calls = 0;
		const listAgyModels = async () => {
			calls++;
			return DISCOVERED_SAMPLE;
		};
		const { rec } = await setupWith(GIT_LOCATION, { listAgyModels });
		expect(calls).toBe(0);
		expect(rec.providerTransforms).toHaveLength(1);

		const first = providerEditor();
		rec.providerTransforms[0]!(first.editor);
		expect(first.sets).toHaveLength(0);
		await settle();
		expect(calls).toBe(1);
		expect(rec.reloads).toBe(1);

		const second = providerEditor();
		rec.providerTransforms[0]!(second.editor);
		expect(second.sets).toHaveLength(1);
		expect(second.sets[0]!.providerID).toBe("agy");
		const ids = second.sets[0]!.models.map((m) => m.id);
		expect(ids).toContain("default");
		expect(ids).toContain("gemini-3.8-flash");
		expect(ids).toContain("claude-sonnet-4-6");

		// Memoized: further transforms neither rediscover nor reload.
		rec.providerTransforms[0]!(providerEditor().editor);
		await settle();
		expect(calls).toBe(1);
		expect(rec.reloads).toBe(1);
	});

	test("emits v2 Model.Info records with effort variants carrying agyModelId", async () => {
		const { rec } = await setupWith(GIT_LOCATION, { listAgyModels: async () => DISCOVERED_SAMPLE });
		rec.providerTransforms[0]!(providerEditor().editor);
		await settle();
		const { editor, sets } = providerEditor();
		rec.providerTransforms[0]!(editor);
		const flash = sets[0]!.models.find((m) => m.id === "gemini-3.8-flash");
		expect(flash).toMatchObject({
			id: "gemini-3.8-flash",
			modelID: "gemini-3.8-flash-high",
			providerID: "agy",
			status: "active",
			enabled: true,
			capabilities: { tools: true, input: ["text"], output: ["text"], temperature: true },
			cost: [],
			time: { released: 0 },
		});
		expect(flash.limit.context).toBeGreaterThan(0);
		expect(flash.variants).toEqual(
			expect.arrayContaining([
				{ id: "high", settings: { agyModelId: "gemini-3.8-flash-high" } },
				{ id: "low", settings: { agyModelId: "gemini-3.8-flash-low" } },
			]),
		);
	});

	test("imageInput option advertises image input", async () => {
		const { rec } = await setupWith(GIT_LOCATION, { listAgyModels: async () => DISCOVERED_SAMPLE, imageInput: true });
		rec.providerTransforms[0]!(providerEditor().editor);
		await settle();
		const { editor, sets } = providerEditor();
		rec.providerTransforms[0]!(editor);
		expect(sets[0]!.models[0]!.capabilities.input).toEqual(["text", "image"]);
	});

	test("adds the agy provider when the editor does not have it yet", async () => {
		// opencode 2.2.5 runs plugin transforms on the catalog before the
		// config layer applies provider.agy, which then overlays this record.
		const { rec } = await setupWith(GIT_LOCATION, { listAgyModels: async () => DISCOVERED_SAMPLE });
		rec.providerTransforms[0]!(providerEditor(false).editor);
		await settle();
		const adds: any[] = [];
		const { editor, sets } = providerEditor(false);
		rec.providerTransforms[0]!({ ...editor, add: (input: unknown) => adds.push(input) });
		expect(sets).toHaveLength(0);
		expect(adds).toHaveLength(1);
		expect(adds[0].info).toMatchObject({ id: "agy", name: "Agy (Antigravity)", activation: "auto" });
		expect(adds[0].models.map((m: any) => m.id)).toContain("gemini-3.8-flash");
	});

	test("falls back to the static registry when discovery throws", async () => {
		const { rec } = await setupWith(GIT_LOCATION, {
			listAgyModels: async () => {
				throw new Error("agy missing");
			},
		});
		rec.providerTransforms[0]!(providerEditor().editor);
		await settle();
		expect(rec.reloads).toBe(1);
		const { editor, sets } = providerEditor();
		rec.providerTransforms[0]!(editor);
		expect(sets[0]!.models.map((m) => m.id)).toContain("default");
	});
});

describe("agyProviderInfo", () => {
	test("defaults the package to the sibling provider.js entry", () => {
		const info = agyProviderInfo("file:///pkg/dist/index.js");
		expect(info.package).toBe("aisdk:file:///pkg/dist/provider.js");
	});
});

describe("tool transform (v1 tool map)", () => {
	test("adds open_agy_session, agy_open and agy_cleanup_preview", async () => {
		const { rec } = await setupWith(GIT_LOCATION);
		expect(rec.toolTransforms).toHaveLength(1);
		const { editor, added } = toolEditor();
		rec.toolTransforms[0]!(editor);
		expect(added.map((t) => t.name)).toEqual(["open_agy_session", "agy_open", "agy_cleanup_preview"]);
		for (const tool of added) {
			expect(typeof tool.description).toBe("string");
			expect(tool.input).toMatchObject({ type: "object" });
			expect(typeof tool.execute).toBe("function");
		}
	});

	test("open tool reports an unbound session without spawning", async () => {
		let opened = 0;
		const { rec } = await setupWith(GIT_LOCATION, {
			store: { getEntry: async () => undefined },
			openInteractiveSession: () => {
				opened++;
				return { success: true, method: "tmux-popup" };
			},
		});
		const { editor, added } = toolEditor();
		rec.toolTransforms[0]!(editor);
		const result = await added[0].execute({}, { sessionID: "ses_abc" });
		expect(result).toEqual({ content: "No active agy conversation bound for this session yet." });
		expect(opened).toBe(0);
	});

	test("open tool opens the bound conversation in the resolved worktree", async () => {
		const seen: any[] = [];
		const { rec } = await setupWith(GIT_LOCATION, {
			store: { getEntry: async () => ({ conversationId: "conv-1" }) },
			openInteractiveSession: (input: unknown) => {
				seen.push(input);
				return { success: true, method: "tmux-popup" };
			},
		});
		const { editor, added } = toolEditor();
		rec.toolTransforms[0]!(editor);
		const result = await added[1].execute({}, { sessionID: "ses_abc" });
		expect(result).toEqual({ content: "Opened agy session conv-1 in tmux popup." });
		expect(seen[0]).toMatchObject({ conversationId: "conv-1", cwd: "/repo" });
	});

	test("cleanup preview passes ttlDays and the state dir to the engine", async () => {
		const seen: any[] = [];
		const { rec, stateDir } = await setupWith(GIT_LOCATION, {
			cleanupPreview: async (input: unknown) => {
				seen.push(input);
				return { candidates: [] };
			},
		});
		const { editor, added } = toolEditor();
		rec.toolTransforms[0]!(editor);
		const result = await added[2].execute({ ttlDays: 3 }, { sessionID: "ses_abc" });
		// Same resolution as v1: dirname(sessionMapPath) = <stateDir>/agy-bridge.
		expect(seen[0]).toEqual({ ttlDays: 3, stateDir: `${stateDir}/agy-bridge` });
		expect(JSON.parse(result.content)).toEqual({ candidates: [] });
	});

	test("cleanup preview rejects unknown parameters", async () => {
		const { rec } = await setupWith(GIT_LOCATION, { cleanupPreview: async () => ({}) });
		const { editor, added } = toolEditor();
		rec.toolTransforms[0]!(editor);
		await expect(added[2].execute({ bogus: 1 }, { sessionID: "ses_abc" })).rejects.toThrow("Unsupported cleanup preview parameter: bogus");
	});
});
