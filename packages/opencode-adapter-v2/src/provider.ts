/**
 * Provider factory entry for opencode v2 configs. The factory itself is
 * runtime-agnostic (an AI SDK ProviderV3), so it is the same code the v1
 * package ships at dist/provider.js; either path works for provider.agy.npm.
 */
export { createAgyProvider, AGY_PROVIDER_ID } from "../../opencode-adapter/src/provider";
