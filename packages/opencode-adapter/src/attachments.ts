/**
 * Compatibility shim (design pi-image-input D1/D3): the attachment
 * pipeline moved to the engine (packages/engine/src/attachments.ts) and
 * this module now RE-EXPORTS it verbatim, so every existing importer —
 * and the migrated engine suite's behavior guarantees — hold unchanged
 * through the same public surface. The opencode-specific config notice
 * (IMAGE_INPUT_DISABLED_MESSAGE) and host wiring stay in
 * language-model.ts / turn.ts; nothing host-specific lives in the engine.
 */
export * from "agy-bridge-engine";
