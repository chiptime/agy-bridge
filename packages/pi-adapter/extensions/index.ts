/**
 * pi extension factory (specs R1, R2, R3; design "extensions/index.ts").
 * The single jiti entry the manifest's `pi.extensions` points at: load +
 * validate config (R12 — typed throw BEFORE any spawn, the discovery probe
 * included) → model discovery via `agy models` (R2 — 24h cache in the
 * lifecycle state, never throws, static fallback catalog) → one
 * registration round (provider `agy` with the real streamSimple, the
 * AskAgy tool, the /agy command) → the session_start/session_shutdown
 * handlers.
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
}

/**
 * Build and register the whole agy bridge on a pi ExtensionAPI. Throws
 * AgyConfigError (R12) before ANY registration when the config is invalid.
 */
export async function createAgyExtension(pi: ExtensionAPI, deps: AgyExtensionDeps = {}): Promise<void> {
	// R12: validation precedes every side effect — no registration, no store,
	// no discovery probe, no spawn can happen on a bad config.
	const config = resolveConfig(deps.options);
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
		}),
	);

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
