import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agyPlugin } from "../src/index";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("registers a lazy read-only cleanup preview without changing the interactive aliases", async () => {
	const root = mkdtempSync(join(tmpdir(), "agy-opencode-preview-"));
	roots.push(root);
	const calls: unknown[] = [];
	const result = { readOnly: true, complete: false, warnings: ["fixture"], entries: [] };
	const hooks = await agyPlugin.server!({ worktree: root, directory: root } as any, {
		stateDir: root,
		cleanupPreview: async (options: unknown) => { calls.push(options); return result; },
	} as any);
	expect(calls).toEqual([]);
	expect(hooks.tool!.agy_open).toBe(hooks.tool!.open_agy_session);
	expect(hooks.tool!.agy_cleanup_preview).toBeDefined();
	const output = await hooks.tool!.agy_cleanup_preview.execute({ ttlDays: 14 }, {} as any);
	expect(JSON.parse(output)).toEqual(result);
	expect(calls).toEqual([{ ttlDays: 14, stateDir: join(root, "agy-bridge") }]);
	for (const key of ["apply", "homeDir", "stateDir"]) {
		await expect(hooks.tool!.agy_cleanup_preview.execute({ [key]: "/untrusted" } as any, {} as any)).rejects.toThrow(key);
	}
	expect(calls).toHaveLength(1);
});
