/**
 * pi extension factory (specs R1, R2, R3; design "extensions/index.ts").
 * The single jiti entry the manifest's `pi.extensions` points at: load +
 * validate config (R12 — typed throw BEFORE any spawn, the discovery probe
 * included) → model discovery via `agy models` (R2 — 24h cache in the
 * lifecycle state, never throws, static fallback catalog) → one
 * registration round (provider `agy` with the real streamSimple, the
 * /agy command, and — since v0.2 R3 — the AskAgy tool ONLY when
 * `askAgy.enabled`; an ABSENT section arms a one-time startup notice) →
 * the session_start/session_shutdown handlers.
 *
 * Prompt transport: the factory enables the engine's corrected stdin seam
 * (`promptViaStdin: true`) for BOTH turn paths — argv switches to
 * `--input-format/--output-format stream-json` and the prompt rides ONE
 * NDJSON user line on the child's stdin, never argv (verified against the
 * real binary; `--print` requires a value so there is no bare-flag form).
 *
 * /reload: pi fires session_start with reason "reload"; the lifecycle
 * awaits rebuildDiscovery, which re-probes and RE-REGISTERS ONLY the
 * provider (registerProvider REPLACES the provider's models — pi's
 * documented refresh path, safe from event callbacks). Tools, commands,
 * and handlers are registered exactly once at load and never again; the
 * rebuild catches its own errors so a failed probe cannot break /reload.
 */
import type { spawn } from "node:child_process";
import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listAgyModels, type AgyModelsRunner } from "agy-bridge-engine";
import { createAskAgyTool } from "../src/ask-tool";
import { createAgyCommand } from "../src/commands";
import { resolveConfig, type PiAdapterOptions } from "../src/config";
import { loadFileConfig } from "../src/file-config";
import { createBridgeState, createLifecycle } from "../src/lifecycle";
import { resolveRegistry, toProviderModel, type DiscoveredEntry, type PiAgyModel } from "../src/models";
import { openPiSessionStore } from "../src/session-store";
import { createStreamSimple } from "../src/stream-simple";
import { DEFAULT_TURN_TIMEOUT_MS } from "../src/turn";

/** Custom api id: pi requires provider-level `api` with streamSimple and
 *  routes every model whose `api` equals it to our streamSimple. */
const AGY_STREAM_API = "agy-stream-json" as Api;
/** Marker baseUrl (pi requires one when a provider defines models); never
 *  fetched — streamSimple intercepts every request before any HTTP. */
const AGY_BASE_URL = "agy://bridge";
/** Sentinel apiKey: pi's auth gate needs a configured method for the models
 *  to be available; this is no secret and is never sent anywhere. */
const AGY_API_KEY = "agy-bridge-local";

export interface AgyExtensionDeps {
	/** Config inputs beyond env (R12); tests inject stateDir isolation + models. */
	options?: PiAdapterOptions;
	/** Discovery seam: replaces the real `agy models` probe (tests). */
	runner?: AgyModelsRunner;
	/** Spawn seam forwarded to every engine run (tests). */
	spawnFn?: typeof spawn;
	/** Wall-clock seam for discovery cache aging (tests). */
	now?: () => number;
	/** File-config seams (v0.2 R1, tests): pin the loader's project cwd and global dir. */
	fileConfig?: { cwd?: string; agentDir?: string };
	/** Skills-catalog passthrough for AskAgy (v0.2 R4 tests; pi exposes no skills API yet). */
	skillsCatalog?: () => string | undefined;
}

/**
 * Build and register the whole agy bridge on a pi ExtensionAPI. Throws
 * AgyConfigError (R12) before ANY registration when the config is invalid.
 */
export async function createAgyExtension(pi: ExtensionAPI, deps: AgyExtensionDeps = {}): Promise<void> {
	// v0.2 R1/D10: the layered file config loads FIRST and sits BEHIND the
	// explicit options (explicit > project > global > env/defaults). The
	// loader never throws (tolerant parse); its warnings are collected on
	// the layer for the startup notice/debug surfaces (later slices).
	const file = await loadFileConfig({
		env: deps.options?.env ?? process.env,
		cwd: deps.fileConfig?.cwd ?? process.cwd(),
		...(deps.fileConfig?.agentDir !== undefined ? { agentDir: deps.fileConfig.agentDir } : {}),
	});
	// R12: validation precedes every side effect — no registration, no store,
	// no discovery probe, no spawn can happen on a bad config.
	const config = resolveConfig(deps.options ?? {}, file);
	// v0.2 R3: AskAgy registers ONLY when explicitly enabled. When the whole
	// askAgy section is ABSENT (not merely enabled:false), the user gets a
	// ONE-TIME startup notice on the first session_start — discoverability
	// for the off-by-default tool. File-config warnings ride along so a
	// broken config file explains itself (the S4 debug log surfaces them in
	// the remaining cases).
	const askAgySectionPresent =
		deps.options?.askAgy !== undefined || Object.keys(file.askAgy).length > 0;
	const startupNotice = askAgySectionPresent
		? undefined
		: [
				"agy-bridge: the AskAgy delegation tool is available but disabled by default.",
				'Enable it with {"askAgy": {"enabled": true}} in .pi/agy-bridge.json (project) or ~/.pi/agent/agy-bridge.json (global).',
				...file.warnings.map((warning) => `config warning: ${warning}`),
			].join("\n");
	// file.warnings surface via the startup notice/debug log (v0.2 S2/S4).
	const now = deps.now ?? Date.now;
	const store = openPiSessionStore(config);
	const state = createBridgeState();

	// Discovery probe (R2): listAgyModels never throws (every failure maps
	// to [] and the registry falls back to the static catalog); the extra
	// catch keeps that promise even if the seam itself misbehaves.
	const probe = async (): Promise<DiscoveredEntry[]> => {
		try {
			return await listAgyModels({
				bin: config.agyBin,
				...(deps.runner !== undefined ? { runner: deps.runner } : {}),
			});
		} catch {
			return [];
		}
	};

	// Load-time discovery: a fresh 24h cache would skip the probe (only
	// reachable when the state outlives this factory, e.g. hot reloads);
	// ONLY non-empty rounds are cached — a failed or empty probe never
	// poisons the cache, so the next reload can retry.
	let rows: readonly DiscoveredEntry[] | undefined = state.discoverySnapshot(now())?.rows;
	if (rows === undefined) {
		const probed = await probe();
		if (probed.length > 0) {
			rows = probed;
			state.setDiscovery(probed, now());
		}
	}
	let registry: readonly PiAgyModel[] = resolveRegistry(config.models, rows);

	// The streamSimple closure is built ONCE and reused across provider
	// (re-)registrations — the transports and stores never change.
	const streamSimple = createStreamSimple({
		bin: config.agyBin,
		store,
		...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
		...(deps.spawnFn !== undefined ? { spawnFn: deps.spawnFn } : {}),
		promptViaStdin: true,
		state,
	});

	const registerModels = (models: readonly PiAgyModel[]): void => {
		pi.registerProvider("agy", {
			name: "agy",
			api: AGY_STREAM_API,
			baseUrl: AGY_BASE_URL,
			apiKey: AGY_API_KEY,
			models: models.map(toProviderModel),
			streamSimple,
		});
	};
	registerModels(registry);

	// v0.2 R3: conditional registration — the tool exists only when the
	// resolved askAgy.enabled is true. The execute-time circular guard stays
	// regardless (the model can change onto agy mid-session and pi tools
	// cannot be unregistered, so the guard is the only recursion fence).
	if (config.askAgy.enabled) {
		const { name, label, description } = config.askAgy;
		pi.registerTool(
			createAskAgyTool({
				bin: config.agyBin,
				store,
				// Live view: a /reload rebuild refreshes the registry without
				// re-registering the tool, and thinking-level resolution should
				// see the fresh tiers.
				get models() {
					return registry;
				},
				...(config.scratchRoot !== undefined ? { scratchRoot: config.scratchRoot } : {}),
				...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
				...(deps.spawnFn !== undefined ? { spawnFn: deps.spawnFn } : {}),
				promptViaStdin: true,
				state,
				// v0.2 R4: configured metadata overrides + effective defaults
				// (explicit caller params still win inside the tool).
				...(name !== undefined || label !== undefined || description !== undefined
					? {
							metadata: {
								...(name !== undefined ? { name } : {}),
								...(label !== undefined ? { label } : {}),
								...(description !== undefined ? { description } : {}),
							},
						}
					: {}),
				defaults: {
					defaultMode: config.askAgy.defaultMode,
					allowFullMode: config.askAgy.allowFullMode,
					defaultIsolated: config.askAgy.defaultIsolated,
					appendSkills: config.askAgy.appendSkills,
				},
				...(deps.skillsCatalog !== undefined ? { skillsCatalog: deps.skillsCatalog } : {}),
			}),
		);
	}

	pi.registerCommand(
		"agy",
		createAgyCommand({
			bin: config.agyBin,
			timeoutMs: config.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
			stateDir: config.stateDir,
			store,
			state,
			...(deps.now !== undefined ? { now: deps.now } : {}),
		}),
	);

	const lifecycle = createLifecycle({
		state,
		// v0.2 R3: the one-time "AskAgy is off" notice (only composed when the
		// askAgy section is absent) fires on the first session_start.
		...(startupNotice !== undefined ? { startupNotice } : {}),
		// /reload refresh (R2): re-probe → refresh cache + registry →
		// re-register ONLY the provider (models are REPLACED, never appended).
		// This closure catches its own errors (D3 risk 2): a failed probe
		// must not break the reload itself, and an empty round leaves the
		// load-time registry and cache untouched.
		rebuildDiscovery: async () => {
			try {
				const fresh = await probe();
				if (fresh.length > 0) {
					state.setDiscovery(fresh, now());
					registry = resolveRegistry(config.models, fresh);
					registerModels(registry);
				}
			} catch {
				/* never break /reload on a failed rebuild */
			}
		},
	});
	pi.on("session_start", lifecycle.onSessionStart);
	pi.on("session_shutdown", lifecycle.onSessionShutdown);
}

/** The manifest's jiti entry: pi calls this with the real ExtensionAPI. */
export default function agyBridgeExtension(pi: ExtensionAPI): Promise<void> {
	return createAgyExtension(pi);
}
