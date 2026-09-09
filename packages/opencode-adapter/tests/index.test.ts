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
import pluginModule, { agyPlugin } from "../src/index";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";

function pluginInput(worktree: string): PluginInput {
	return { worktree } as unknown as PluginInput;
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
