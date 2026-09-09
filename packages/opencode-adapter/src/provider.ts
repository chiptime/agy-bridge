/**
 * Provider factory (spec R3, design D3): opencode's custom-provider loader
 * (verified against the 1.18.29 binary) imports this module through the
 * package's "./provider" export, picks the export whose name starts with
 * "create", and calls it with { name: providerID, ...mergedOptions } —
 * later resolving models via .languageModel(modelId). The factory returns a
 * ProviderV3-shaped object: languageModel builds AgyLanguageModel instances
 * backed by one shared session store (rooted at the configured stateDir) and
 * the validated adapter config; the unsupported model kinds follow the
 * standard provider contract and throw NoSuchModelError.
 */
import { NoSuchModelError, type ProviderV3 } from "@ai-sdk/provider";
import { resolveConfig, type AgyAdapterOptions } from "./config";
import { openSessionStore } from "./session-store";
import { sessionMapPath } from "./paths";
import { AgyLanguageModel, type TurnRunner } from "./language-model";
import type { TurnDeps } from "./turn";

/** The reserved provider id; the chat.params channel and registry agree on it. */
export const AGY_PROVIDER_ID = "agy";

/** Factory options: opencode passes { name, ...provider config options }. */
export interface AgyProviderFactoryOptions extends AgyAdapterOptions {
	/** Provider id assigned by the host; defaults to the reserved "agy". */
	name?: string;
}

/** Test seam: inject the runner/spawn without changing the host contract. */
export interface AgyProviderTestDeps {
	bin?: string;
	run?: TurnRunner;
	spawnFn?: TurnDeps["spawnFn"];
}

/**
 * Build the agy provider. One config validation, one session store, and one
 * runner seam are shared by every model instance the host resolves.
 */
export function createAgyProvider(
	options: AgyProviderFactoryOptions = {},
	testDeps: AgyProviderTestDeps = {},
): ProviderV3 {
	const provider = options.name ?? AGY_PROVIDER_ID;
	const config = resolveConfig(options);
	const store = openSessionStore(sessionMapPath({ override: config.stateDir }));
	return {
		specificationVersion: "v3",
		languageModel: (modelId) =>
			new AgyLanguageModel({
				provider,
				modelId,
				config,
				store,
				bin: testDeps.bin,
				run: testDeps.run,
				spawnFn: testDeps.spawnFn,
			}),
		embeddingModel: (modelId) => {
			throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
		},
		imageModel: (modelId) => {
			throw new NoSuchModelError({ modelId, modelType: "imageModel" });
		},
	};
}
