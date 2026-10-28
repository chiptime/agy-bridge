import { Type } from "typebox";
import { CLEANUP_PREVIEW_DESCRIPTION, parseCleanupPreviewParameters, previewCleanup } from "agy-bridge-engine";

const parameters = Type.Object({
	ttlDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 36500, description: "Retention window in days (default: 7). Preview only." })),
}, { additionalProperties: false });

/** Shared engine semantics; no process spawn, store mutation, or apply mode. */
export function createCleanupPreviewTool(deps: { stateDir: string; preview?: typeof previewCleanup }) {
	return {
		name: "agy_cleanup_preview",
		label: "Preview agy cleanup",
		description: CLEANUP_PREVIEW_DESCRIPTION,
		parameters,
		async execute(_toolCallId: string, params: { ttlDays?: number }) {
			const validated = parseCleanupPreviewParameters(params);
			const report = await (deps.preview ?? previewCleanup)({ ...validated, stateDir: deps.stateDir });
			return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }], details: report };
		},
	};
}
