/**
 * Plugin entry (spec R3 exports["."], design D3): opencode loads the
 * package root and expects a default-exported PluginModule { id?, server }
 * (verified against the 1.18.29 binary — "must default export an object"
 * with a function `server`). The server's chat.params hook is the
 * plugin→provider channel: opencode's runtime forwards the mutated
 * output.options into the LLM call as providerOptions, so the agy models
 * read { sessionId, worktree } from providerOptions.agy. Per OQ1 the hook
 * returns void and mutates `output` in place; the session id is the
 * per-request input field `sessionID` (capital D) and the worktree comes
 * from the PluginInput this server was initialized with — no module state,
 * so concurrent sessions cannot race.
 */
import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";
import { AGY_PROVIDER_ID } from "./provider";

const server: Plugin = async (input) => {
	const worktree = input.worktree;
	const hooks: Hooks = {
		"chat.params": async (req, output) => {
			if (req.model.providerID !== AGY_PROVIDER_ID) return;
			output.options.agy = { sessionId: req.sessionID, worktree };
		},
	};
	return hooks;
};

/** The agy-bridge opencode plugin module (default export per R3). */
export const agyPlugin: PluginModule = {
	id: "agy-bridge",
	server,
};

export default agyPlugin;
