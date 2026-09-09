/**
 * Unit tests for the plugin entry (spec R3 exports["."], design D3/OQ1):
 * opencode loads the package root and expects a default-exported
 * PluginModule { id?, server } (verified against the 1.18.29 binary —
 * "must default export an object"; server must be a function). The
 * server's chat.params hook is the D3 channel: it returns void and
 * MUTATES output.options in place with agy = { sessionId, worktree },
 * where sessionId comes from the per-request input (capital-D sessionID)
 * and worktree from the PluginInput the server was initialized with.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import pluginModule, { agyPlugin } from "../src/index";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { Provider as ProviderV2 } from "@opencode-ai/sdk/v2";

function pluginInput(worktree: string): PluginInput {
	return { worktree } as unknown as PluginInput;
}

/** Minimal ProviderV2 stand-in: the host passes the provider being registered. */
const fakeProvider: ProviderV2 = {
	id: "agy",
	name: "agy",
	source: "custom",
	env: [],
	options: {},
	models: {},
};

/** Real-shaped discovery sample from `agy models` (v1.1.28, 2026-09-09). */
const DISCOVERED_SAMPLE = [
	{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
	{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
];

async function providerModels(options: Record<string, unknown> = {}) {
	// Fresh tmp state dir per call: hook tests must never touch the real
	// user state, and must not observe each other's models-cache.json.
	const stateDir = await mkdtemp("/tmp/agy-plugin-hook-");
	const hooks: Hooks = await pluginModule.server(pluginInput("/wt"), { stateDir, ...options });
	const hook = hooks.provider;
	expect(hook).toBeDefined();
	expect(hook?.id).toBe("agy");
	expect(typeof hook?.models).toBe("function");
	return hook?.models?.(fakeProvider, {});
}

async function chatParams(worktree: string, sessionID: string, providerID: string) {
	const hooks = await agyPlugin.server(pluginInput(worktree));
	const hook = hooks["chat.params"];
	if (!hook) throw new Error("chat.params hook missing");
	const output = {
		temperature: 0,
		topP: 1,
		topK: 1,
		maxOutputTokens: undefined,
		options: {} as Record<string, unknown>,
	};
	const result = await hook(
		{ sessionID, providerID, model: { providerID } } as never,
		output as never,
	);
	return { result, output };
}

describe("unit: index — plugin entry and chat.params channel (D3/OQ1)", () => {
	test("default-exports a PluginModule { id, server }; named export matches", () => {
		expect(typeof pluginModule.server).toBe("function");
		expect(pluginModule.id).toBe("agy-bridge");
		expect(agyPlugin).toBe(pluginModule);
		expect(pluginModule.tui).toBeUndefined();
	});

	test("server() returns hooks with a chat.params function", async () => {
		const hooks: Hooks = await pluginModule.server(pluginInput("/wt"));
		expect(typeof hooks["chat.params"]).toBe("function");
	});

	test("OQ1: chat.params returns void and MUTATES output.options.agy in place", async () => {
		const { result, output } = await chatParams("/wt/project", "sess-42", "agy");
		expect(result).toBeUndefined();
		expect(output.options.agy).toEqual({ sessionId: "sess-42", worktree: "/wt/project" });
	});

	test("non-agy providers are left untouched; per-request scoping, no module state", async () => {
		const other = await chatParams("/wt/project", "sess-42", "openai");
		expect(other.output.options).toEqual({});
		const a = await chatParams("/wt/a", "sess-a", "agy");
		const b = await chatParams("/wt/b", "sess-b", "agy");
		expect(a.output.options.agy).toEqual({ sessionId: "sess-a", worktree: "/wt/a" });
		expect(b.output.options.agy).toEqual({ sessionId: "sess-b", worktree: "/wt/b" });
	});
});

describe("unit: index — provider.models hook (dynamic discovery registration)", () => {
	test("server registers a provider hook with id 'agy' and a models function", async () => {
		const record = await providerModels({ listAgyModels: async () => DISCOVERED_SAMPLE });
		expect(record).toBeDefined();
	});

	test("hook returns the DISCOVERED registry: bare keys, default first, display names", async () => {
		const record = await providerModels({ listAgyModels: async () => DISCOVERED_SAMPLE });
		expect(Object.keys(record ?? {})).toEqual(["default", "gemini-3.8-flash-high", "claude-sonnet-4-6"]);
		const claude = record?.["claude-sonnet-4-6"];
		expect(claude?.providerID).toBe("agy");
		expect(claude?.name).toBe("Claude Sonnet 4.6");
		expect(claude?.limit.context).toBe(128000);
	});

	test("discovery returning nothing falls back to the static builtin registry", async () => {
		const record = await providerModels({ listAgyModels: async () => [] });
		expect(Object.keys(record ?? {})).toEqual([
			"default",
			"gemini-3.8-flash-high",
			"gemini-3.8-flash-medium",
			"gemini-3.8-flash-low",
		]);
	});

	test("discovery THROWING never rejects the hook — static fallback, error swallowed", async () => {
		const record = await providerModels({
			listAgyModels: async () => {
				throw new Error("injected discovery failure");
			},
		});
		expect(Object.keys(record ?? {})[0]).toBe("default");
	});
});
