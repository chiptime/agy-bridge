/**
 * opencode v2 plugin entry (@opencode/plugin 2.2.5). v2 requires
 * `export default { id, setup }`; anything else fails with "Plugin must
 * export a default definition with an id and an effect or setup function."
 * The v1 entry (packages/opencode-adapter) keeps the v1 `{ id, server }`
 * shape untouched; this package only changes the registration channel:
 *
 *   v1 chat.params     -> ctx.session.hook("context", ...) scoped to agy.
 *     Non-generation keys of `event.options` become providerOptions, so the
 *     agy models keep reading { sessionId, worktree } from providerOptions.agy.
 *   v1 provider.models -> ctx.provider.transform(...). v2 transform callbacks
 *     are synchronous, so discovery cannot be awaited inside them: the first
 *     callback starts the memoized discovery and, once it settles, asks the
 *     host to reload providers; the next callback publishes the models.
 *     Until then the configured provider.agy models stay as they are.
 *     Nothing spawns in setup itself. The transform sees the catalog before
 *     the config layer applies provider.agy (observed on 2.2.5), so the
 *     provider is added here and config overlays it afterwards.
 *   v1 tool map        -> ctx.tool.transform(...) adding the same three tools.
 *
 * Worktree: v2 has no `input.worktree`. ctx.location.project.directory is the
 * project root opencode resolved for the location (the git worktree); the
 * "global" project (non-git directories) reports "/", so the location
 * directory takes its place, matching the v1 fallback.
 */
import type { Location, Plugin, Model } from "@opencode/plugin";
import { dirname } from "node:path";
import {
	CLEANUP_PREVIEW_DESCRIPTION,
	openInteractiveAgySession,
	parseCleanupPreviewParameters,
	previewCleanup,
} from "agy-bridge-engine";
import type { ModelConfig } from "../../opencode-adapter/src/config";
import { AGY_PROVIDER_ID } from "../../opencode-adapter/src/provider";
import { resolveRegistry, type AgyModel } from "../../opencode-adapter/src/models";
import { discoverModels } from "../../opencode-adapter/src/discovery";
import { openSessionStore, type SessionStore } from "../../opencode-adapter/src/session-store";
import { sessionMapPath } from "../../opencode-adapter/src/paths";

/** Same factory re-export as the v1 entry: `provider.agy.npm` may point here too. */
export { createAgyProvider, AGY_PROVIDER_ID } from "../../opencode-adapter/src/provider";

/** Plugin options (ctx.options), same keys as the v1 server options. */
export interface AgyPluginV2Options {
	/** Test/DI seam: replace the engine's `agy models` lister. */
	listAgyModels?: (bin: string) => Promise<{ id: string; name: string }[]>;
	/** Config models override/extension (same shape as the provider option). */
	models?: Record<string, ModelConfig>;
	/** Binary override; default env AGY_BIN ?? "agy". */
	bin?: string;
	/** Environment snapshot override. */
	env?: Record<string, string | undefined>;
	/** State dir override for the models cache and session map. */
	stateDir?: string;
	/** Opt-in image attachment bridge; advertises image input. Default off. */
	imageInput?: boolean;
	/** Test/DI seam: session store override. */
	store?: Pick<SessionStore, "getEntry">;
	/** Test/DI seam: interactive session opener override. */
	openInteractiveSession?: typeof openInteractiveAgySession;
	/** Test/DI seam: read-only cleanup inventory; never called at plugin load. */
	cleanupPreview?: typeof previewCleanup;
}

const GLOBAL_PROJECT_ID = "global";

/** Run location for agy: the project worktree, or the directory for the global project. */
export function resolveWorktree(location: Location.Info): string {
	const project = location.project as { id?: string; directory?: string } | undefined;
	const projectDir = project?.directory;
	if (project?.id !== GLOBAL_PROJECT_ID && projectDir && projectDir !== "/") return projectDir;
	return location.directory;
}

/** v1 AgyModel -> v2 Model.Info (the v1 record used ModelV2 from @opencode-ai/sdk). */
export function toModelInfo(entry: AgyModel, providerID: string, opts: { imageInput?: boolean } = {}): Model.Info {
	const id = entry.id.startsWith("agy/") ? entry.id.slice("agy/".length) : entry.id;
	const variants = Object.entries(entry.variants ?? {}).map(([effort, payload]) => ({
		id: effort,
		settings: { agyModelId: payload.agyModelId },
	}));
	return {
		id,
		modelID: entry.modelArg ?? id,
		providerID,
		name: entry.name,
		capabilities: {
			tools: true,
			input: opts.imageInput === true ? ["text", "image"] : ["text"],
			output: ["text"],
			temperature: true,
		},
		variants,
		time: { released: 0 },
		cost: [],
		status: "active",
		enabled: true,
		limit: { context: entry.limit.context, output: entry.limit.output },
	} as unknown as Model.Info;
}

/**
 * Provider record for the transform when config has not applied provider.agy
 * yet. The package defaults to this build's sibling dist/provider.js, so the
 * provider stays usable without a provider.agy config entry; a configured
 * provider.agy.npm overrides it.
 */
export function agyProviderInfo(entryUrl: string = import.meta.url) {
	return {
		id: AGY_PROVIDER_ID,
		name: "Agy (Antigravity)",
		activation: "auto",
		package: `aisdk:${new URL("./provider.js", entryUrl).href}`,
	};
}

const OPEN_SESSION_DESCRIPTION =
	"Open the active agy conversation in an interactive popup (tmux popup or floating terminal)";

const setup: Plugin.Plugin["setup"] = async (ctx) => {
	const opts = (ctx.options ?? {}) as AgyPluginV2Options;
	const worktree = resolveWorktree(ctx.location);
	const store = opts.store ?? openSessionStore(sessionMapPath({ override: opts.stateDir, env: opts.env }));
	const openSession = opts.openInteractiveSession ?? openInteractiveAgySession;

	// Memoized lazy discovery, started by the first provider transform.
	let registry: AgyModel[] | null = null;
	let discovery: Promise<void> | null = null;
	const startDiscovery = () => {
		discovery ??= (async () => {
			try {
				const discovered = await discoverModels({
					bin: opts.bin,
					env: opts.env,
					stateDir: opts.stateDir,
					list: opts.listAgyModels,
				});
				registry = resolveRegistry(opts.models ?? {}, discovered);
			} catch {
				registry = resolveRegistry(opts.models ?? {});
			}
			await ctx.provider.reload();
		})().catch(() => {});
	};

	await ctx.session.hook(
		"context",
		(event) => {
			// Merge in place: options may already carry keys from other plugins.
			if (event?.model?.providerID !== AGY_PROVIDER_ID || !event.options) return;
			event.options.sessionId = event.sessionID;
			event.options.worktree = worktree;
			event.options.agy = { sessionId: event.sessionID, worktree };
		},
		{ providerID: AGY_PROVIDER_ID },
	);

	await ctx.provider.transform((editor) => {
		if (!registry) {
			startDiscovery();
			return;
		}
		const models = registry.map((entry) => toModelInfo(entry, AGY_PROVIDER_ID, { imageInput: opts.imageInput }));
		// Plugin transforms run on the models.dev catalog before the config
		// layer applies provider.agy, so agy is usually absent here: add it,
		// and config then overlays its package, options and per-model fields.
		if (editor.get(AGY_PROVIDER_ID)) editor.models.set(AGY_PROVIDER_ID, models);
		else editor.add({ info: agyProviderInfo() as never, models });
	});

	const openSessionExecute = async (_input: unknown, context: { sessionID: string }) => {
		const entry = await store.getEntry(context.sessionID);
		if (!entry?.conversationId) {
			return { content: "No active agy conversation bound for this session yet." };
		}
		const result = openSession({ conversationId: entry.conversationId, cwd: worktree, bin: opts.bin, env: opts.env });
		if (result.success) {
			return {
				content:
					result.method === "tmux-popup"
						? `Opened agy session ${entry.conversationId} in tmux popup.`
						: `Opened agy session ${entry.conversationId} in terminal window (${result.terminal}).`,
			};
		}
		return {
			content: `Could not launch interactive terminal automatically (${result.reason}). Run manually:\n  ${result.command}`,
		};
	};
	const noArgs = { type: "object", properties: {}, additionalProperties: false } as const;

	await ctx.tool.transform((editor) => {
		editor.add({ name: "open_agy_session", description: OPEN_SESSION_DESCRIPTION, input: noArgs, execute: openSessionExecute });
		editor.add({ name: "agy_open", description: OPEN_SESSION_DESCRIPTION, input: noArgs, execute: openSessionExecute });
		editor.add({
			name: "agy_cleanup_preview",
			description: CLEANUP_PREVIEW_DESCRIPTION,
			input: {
				type: "object",
				properties: {
					ttlDays: {
						type: "integer",
						minimum: 0,
						maximum: 36500,
						description: "Retention window in days (default: 7). Preview only.",
					},
				},
				additionalProperties: false,
			},
			execute: async (input) => {
				const params = parseCleanupPreviewParameters(input);
				const stateDir = dirname(sessionMapPath({ override: opts.stateDir, env: opts.env }));
				const preview = await (opts.cleanupPreview ?? previewCleanup)({ ...params, stateDir });
				return { content: JSON.stringify(preview, null, 2) };
			},
		});
	});
};

/** The agy-bridge opencode v2 plugin definition. */
export const agyPluginV2: Plugin.Plugin = { id: "agy-bridge", setup };

export default agyPluginV2;
