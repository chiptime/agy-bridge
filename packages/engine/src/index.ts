/**
 * Public API of the agy bridge engine: stream spawn runner, run-outcome
 * error taxonomy, passive quota selection, host-agnostic divergence
 * helpers, and the image-attachment pipeline. Host-agnostic by contract —
 * nothing in here may import a host adapter package.
 */
export * from "./spawn";
export * from "./outcomes";
export * from "./quota";
export * from "./models-list";
export * from "./messages";
export * from "./attachments";
