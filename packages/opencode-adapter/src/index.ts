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
 *
 * Dynamic model discovery: the server also registers the pinned
 * `provider.models` hook (@opencode-ai/plugin@1.18.30:
 * `models?(provider: ProviderV2, ctx: ProviderHookContext) =>
 * Promise<Record<string, ModelV2>>`). Discovery runs lazily on the FIRST
 * hook call (not at plugin init) and is memoized per server instance; the
 * cache-first discoverModels pipeline (models-cache.json, 24h TTL) sits in
 * front, and any failure degrades to the static builtin registry.
 */
import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin";
import type { ModelConfig } from "./config";
import { AGY_PROVIDER_ID } from "./provider";
import { resolveRegistry, buildModelRecord, type AgyModel } from "./models";
import { discoverModels } from "./discovery";

/**
 * Registry-form transport: opencode's npm loader imports the package
 * entrypoint and scans its exports for a `create*` factory (verified against
 * the 1.18.29 binary). Re-exporting here makes the "." entry serve BOTH the
 * plugin (default export) and the provider factory — the same package works
 * from the `plugin` array and from `provider.<id>.npm`.
 */
export { createAgyProvider, AGY_PROVIDER_ID } from "./provider";

/**
 * server(input, options) extension point: opencode forwards plugin options
 * from config; tests and embeddings use the same keys to inject the
 * discovery seam or pin the model config without touching process.env.
 */
export interface AgyPluginServerOptions {
	/** Test/DI seam: replace the engine's `agy models` lister. */
	listAgyModels?: (bin: string) => Promise<{ id: string; name: string }[]>;
	/** Config models override/extension (same shape as the provider option). */
	models?: Record<string, ModelConfig>;
	/** Binary override; default env AGY_BIN ?? "agy". */
	bin?: string;
	/** Environment snapshot override (paths.ts house pattern). */
	env?: Record<string, string | undefined>;
	/** State dir override for the models cache (validated absolute upstream). */
	stateDir?: string;
}

const server: Plugin = async (input, options) => {
	const worktree = input.worktree;
	const opts = (options ?? {}) as AgyPluginServerOptions;
	// Memoized lazy discovery: nothing spawns at plugin init; the first
	// provider.models call pays the (cached) round-trip once.
	let registry: AgyModel[] | null = null;
	const getRegistry = async (): Promise<AgyModel[]> => {
		if (registry) return registry;
		const discovered = await discoverModels({
			bin: opts.bin,
			env: opts.env,
			stateDir: opts.stateDir,
			list: opts.listAgyModels,
		});
		registry = resolveRegistry(opts.models ?? {}, discovered);
		return registry;
	};
	const hooks: Hooks = {
	"chat.params": async (req, output) => {
		// Live host contract (2026-09-11): opencode invokes chat.params a
		// SECOND time per turn with null req/output — never throw on it.
		// output.options may already carry keys from other plugins; we only
		// ADD our own (merge-in-place, never clobber the rest).
		if (req?.model?.providerID !== AGY_PROVIDER_ID || !output?.options) return;
		output.options.sessionId = req.sessionID;
		output.options.worktree = worktree;
		output.options.agy = { sessionId: req.sessionID, worktree };
	},
		provider: {
			id: AGY_PROVIDER_ID,
			models: async (provider) => buildModelRecord(await getRegistry(), provider.id),
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
