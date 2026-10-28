import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CleanupPreview } from "agy-bridge-engine";
import { createAgyExtension } from "../extensions/index";
import { createCleanupPreviewTool } from "../src/cleanup-tool";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("the preview tool exposes only retention and returns structured read-only details", async () => {
	const calls: unknown[] = [];
	const report: CleanupPreview = { readOnly: true, ttlDays: 14, complete: false, warnings: ["fixture"], entries: [], totals: { inspected: 0, candidates: 0, protected: 0, estimatedCandidateBytes: 0 }, note: "fixture" };
	const tool = createCleanupPreviewTool({ stateDir: "/fixture", preview: async (options) => { calls.push(options); return report; } });
	expect(tool.name).toBe("agy_cleanup_preview");
	expect(Object.keys(tool.parameters.properties)).toEqual(["ttlDays"]);
	expect((tool.parameters as { additionalProperties?: boolean }).additionalProperties).toBe(false);
	const result = await tool.execute("call", { ttlDays: 14 });
	expect(result.details).toEqual(report);
	expect(JSON.parse(result.content[0].text)).toEqual(report);
	expect(calls).toEqual([{ ttlDays: 14, stateDir: "/fixture" }]);
	for (const key of ["apply", "homeDir", "stateDir"]) {
		await expect(tool.execute("call", { [key]: "/untrusted" } as any)).rejects.toThrow(key);
	}
	expect(calls).toHaveLength(1);
});

test("Pi registers the preview independently of opt-in AskAgy without inspecting state during load", async () => {
	const root = mkdtempSync(join(tmpdir(), "agy-pi-preview-"));
	roots.push(root);
	const tools: any[] = [];
	let scans = 0;
	const pi = { registerTool: (tool: any) => tools.push(tool), registerProvider() {}, registerCommand() {}, on() {} };
	await createAgyExtension(pi as any, {
		options: { stateDir: root, env: {} }, fileConfig: { cwd: root, agentDir: root },
		runner: () => ({ stdout: "", exitCode: 0 }),
		cleanupPreview: async () => { scans++; throw new Error("must stay lazy"); },
	});
	expect(tools.map((tool) => tool.name)).toEqual(["agy_cleanup_preview"]);
	expect(scans).toBe(0);
});
