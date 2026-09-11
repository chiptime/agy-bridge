/**
 * Export the collapsed agy model registry as an opencode CONFIG `models`
 * fragment (JSON printed to stdout).
 *
 * WHY THIS EXISTS: opencode 1.18.30 does NOT consult the plugin's
 * `provider.models` hook for providers declared via `provider.<id>.npm`
 * (verified empirically 2026-09-11: the hook never fired and the discovery
 * cache was never written). The picker only renders `provider.<id>.models`
 * from config. So discovery must be MATERIALIZED into config; this script
 * is the refresh pipeline: run it, paste/merge the output.
 *
 * Usage: bun run scripts/export-config-models.ts [--bin <agy-path>]
 * The output is a diff-friendly JSON object shaped as:
 *   { "default": {...}, "gemini-3.8-flash": { "name", "variants" }, ... }
 * Collapsed bases carry `variants` whose payloads hold `agyModelId` (the
 * full effort-suffixed id the adapter passes as --model at turn time);
 * suffix-less ids stay flat. Merge it under provider.agy.models.
 */
import { discoverModels } from "../src/discovery";
import { resolveRegistry } from "../src/models";

const binIndex = process.argv.indexOf("--bin");
const bin = binIndex !== -1 ? process.argv[binIndex + 1] : undefined;

const discovered = await discoverModels(bin ? { bin } : {});
const registry = resolveRegistry({}, discovered);

const fragment: Record<string, unknown> = {};
for (const entry of registry) {
	const id = entry.id.startsWith("agy/") ? entry.id.slice("agy/".length) : entry.id;
	if (entry.variants !== undefined) {
		const variants: Record<string, { agyModelId: string }> = {};
		for (const [name, payload] of Object.entries(entry.variants)) {
			if (payload?.agyModelId) variants[name] = { agyModelId: payload.agyModelId };
		}
		fragment[id] = { name: entry.name, ...(Object.keys(variants).length > 0 ? { variants } : {}) };
	} else {
		fragment[id] = { name: entry.name };
	}
}
process.stdout.write(`${JSON.stringify(fragment, null, 2)}\n`);
