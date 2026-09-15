/**
 * Unit tests for the layered file config loader (v0.2 spec R1, design D10):
 * global `<agentDir>/agy-bridge.json` then project `<cwd>/.pi/agy-bridge.json`,
 * merged per section and per key with the project winning per key. Parsing is
 * TOLERANT: a missing file is silently absent, while an unreadable or
 * malformed file is a collected warning plus "absent" — this loader never
 * throws. Values pass through RAW: resolveConfig stays the single validation
 * gate (v0.1 R12).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadFileConfig } from "../src/file-config";

const ENV: Record<string, string | undefined> = { HOME: "/home/tester" };

/** Injected reader seam: path → content map; unlisted paths read as absent. */
function reader(files: Record<string, string>) {
	const reads: string[] = [];
	const readFile = (path: string): string | undefined => {
		reads.push(path);
		return files[path];
	};
	return { readFile, reads: () => reads };
}

describe("unit: file-config — layered global+project loader (R1, D10)", () => {
	test("spec R1: global timeoutMs and project stateDir both reach the layer", async () => {
		const { readFile } = reader({
			"/agent/agy-bridge.json": JSON.stringify({ timeoutMs: 60 }),
			"/proj/.pi/agy-bridge.json": JSON.stringify({ stateDir: "/s" }),
		});
		const loaded = await loadFileConfig({ env: ENV, cwd: "/proj", agentDir: "/agent", readFile });
		expect(loaded.config.timeoutMs).toBe(60);
		expect(loaded.config.stateDir).toBe("/s");
		expect(loaded.warnings).toEqual([]);
	});

	test("project wins per key; global values survive where the project is silent", async () => {
		const { readFile } = reader({
			"/agent/agy-bridge.json": JSON.stringify({ timeoutMs: 60, models: { m: { name: "G" } } }),
			"/proj/.pi/agy-bridge.json": JSON.stringify({ timeoutMs: 120, models: { n: { name: "P" } } }),
		});
		const loaded = await loadFileConfig({ env: ENV, cwd: "/proj", agentDir: "/agent", readFile });
		expect(loaded.config.timeoutMs).toBe(120);
		expect(loaded.config.models).toEqual({ m: { name: "G" }, n: { name: "P" } });
	});

	test("spec R1: malformed project JSON → warning, project ignored, global applies", async () => {
		const { readFile } = reader({
			"/agent/agy-bridge.json": JSON.stringify({ timeoutMs: 60 }),
			"/proj/.pi/agy-bridge.json": "{oops",
		});
		const loaded = await loadFileConfig({ env: ENV, cwd: "/proj", agentDir: "/agent", readFile });
		expect(loaded.config.timeoutMs).toBe(60);
		expect(loaded.config.stateDir).toBeUndefined();
		expect(loaded.warnings).toHaveLength(1);
		expect(loaded.warnings[0]).toContain("/proj/.pi/agy-bridge.json");
	});

	test("malformed global JSON → warning, project still applies", async () => {
		const { readFile } = reader({
			"/agent/agy-bridge.json": "{oops",
			"/proj/.pi/agy-bridge.json": JSON.stringify({ timeoutMs: 120 }),
		});
		const loaded = await loadFileConfig({ env: ENV, cwd: "/proj", agentDir: "/agent", readFile });
		expect(loaded.config.timeoutMs).toBe(120);
		expect(loaded.warnings).toHaveLength(1);
		expect(loaded.warnings[0]).toContain("/agent/agy-bridge.json");
	});

	test("missing both files → empty layer, empty askAgy, zero warnings", async () => {
		const { readFile } = reader({});
		const loaded = await loadFileConfig({ env: ENV, cwd: "/proj", agentDir: "/agent", readFile });
		expect(loaded.config).toEqual({});
		expect(loaded.askAgy).toEqual({});
		expect(loaded.warnings).toEqual([]);
	});

	test("unknown top-level keys are ignored", async () => {
		const { readFile } = reader({
			"/proj/.pi/agy-bridge.json": JSON.stringify({ nope: 1, timeoutMs: 5 }),
		});
		const loaded = await loadFileConfig({ env: ENV, cwd: "/proj", agentDir: "/agent", readFile });
		expect(loaded.config).toEqual({ timeoutMs: 5 });
	});

	test("askAgy passes through raw per-key merged; validation is resolveConfig's job", async () => {
		const { readFile } = reader({
			"/agent/agy-bridge.json": JSON.stringify({ askAgy: { enabled: true, label: "G label" } }),
			"/proj/.pi/agy-bridge.json": JSON.stringify({ askAgy: { defaultMode: "turbo", label: "P label" } }),
		});
		const loaded = await loadFileConfig({ env: ENV, cwd: "/proj", agentDir: "/agent", readFile });
		expect(loaded.askAgy).toEqual({ enabled: true, label: "P label", defaultMode: "turbo" });
		expect(loaded.warnings).toEqual([]);
	});

	test("a non-object section is a warning and treated as absent", async () => {
		const { readFile } = reader({
			"/agent/agy-bridge.json": JSON.stringify({ models: { m: { name: "G" } } }),
			"/proj/.pi/agy-bridge.json": JSON.stringify({ models: "oops", askAgy: 5 }),
		});
		const loaded = await loadFileConfig({ env: ENV, cwd: "/proj", agentDir: "/agent", readFile });
		expect(loaded.config.models).toEqual({ m: { name: "G" } });
		expect(loaded.askAgy).toEqual({});
		expect(loaded.warnings).toHaveLength(2);
		expect(loaded.warnings[0]).toContain("models");
		expect(loaded.warnings[1]).toContain("askAgy");
	});

	test("a non-object top-level document is a warning, not a crash", async () => {
		const { readFile } = reader({
			"/proj/.pi/agy-bridge.json": "[1, 2]",
		});
		const loaded = await loadFileConfig({ env: ENV, cwd: "/proj", agentDir: "/agent", readFile });
		expect(loaded.config).toEqual({});
		expect(loaded.warnings).toHaveLength(1);
		expect(loaded.warnings[0]).toContain("not a JSON object");
	});

	test("global path rides the injected agentDir seam; project path rides cwd", async () => {
		const { readFile, reads } = reader({});
		await loadFileConfig({ env: ENV, cwd: "/proj", agentDir: "/custom/agent", readFile });
		expect(reads()).toEqual(["/custom/agent/agy-bridge.json", "/proj/.pi/agy-bridge.json"]);
	});

	test("the default global dir comes from pi's getAgentDir() (~/.pi/agent)", async () => {
		const { readFile, reads } = reader({});
		await loadFileConfig({ env: ENV, cwd: "/proj", readFile });
		expect(reads()).toEqual([
			join(homedir(), ".pi", "agent", "agy-bridge.json"),
			"/proj/.pi/agy-bridge.json",
		]);
	});

	test("default reader: real tmp global+project files are read from disk", async () => {
		const root = mkdtempSync(join(tmpdir(), "agy-file-config-"));
		const agentDir = join(root, "agent");
		const project = join(root, "proj");
		mkdirSync(join(agentDir), { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "agy-bridge.json"), JSON.stringify({ timeoutMs: 60 }));
		writeFileSync(join(project, ".pi", "agy-bridge.json"), JSON.stringify({ stateDir: "/s" }));
		const loaded = await loadFileConfig({ env: ENV, cwd: project, agentDir });
		expect(loaded.config.timeoutMs).toBe(60);
		expect(loaded.config.stateDir).toBe("/s");
		expect(loaded.warnings).toEqual([]);
	});

	test("default reader: a directory at the config path is unreadable → warn + absent", async () => {
		const root = mkdtempSync(join(tmpdir(), "agy-file-config-"));
		mkdirSync(join(root, ".pi", "agy-bridge.json"), { recursive: true });
		const loaded = await loadFileConfig({ env: ENV, cwd: root, agentDir: join(root, "absent-agent") });
		expect(loaded.config).toEqual({});
		expect(loaded.warnings).toHaveLength(1);
		expect(loaded.warnings[0]).toContain("unreadable");
	});
});

describe("unit: file-config — imageInput scalar key (pi-image-input spec R1, D6)", () => {
	test("imageInput loads from the PROJECT file (.pi/agy-bridge.json)", async () => {
		const { readFile } = reader({
			"/proj/.pi/agy-bridge.json": JSON.stringify({ imageInput: true }),
		});
		const loaded = await loadFileConfig({ env: ENV, cwd: "/proj", agentDir: "/agent", readFile });
		expect(loaded.config.imageInput).toBe(true);
		expect(loaded.warnings).toEqual([]);
	});

	test("imageInput loads from the GLOBAL file (~/.pi/agent/agy-bridge.json) when the project is silent", async () => {
		const { readFile } = reader({
			"/agent/agy-bridge.json": JSON.stringify({ imageInput: true }),
		});
		const loaded = await loadFileConfig({ env: ENV, cwd: "/proj", agentDir: "/agent", readFile });
		expect(loaded.config.imageInput).toBe(true);
	});

	test("project wins per key: project false beats global true", async () => {
		const { readFile } = reader({
			"/agent/agy-bridge.json": JSON.stringify({ imageInput: true }),
			"/proj/.pi/agy-bridge.json": JSON.stringify({ imageInput: false }),
		});
		const loaded = await loadFileConfig({ env: ENV, cwd: "/proj", agentDir: "/agent", readFile });
		expect(loaded.config.imageInput).toBe(false);
	});

	test("values pass through RAW: a non-boolean imageInput rides the layer unvalidated, zero warnings", async () => {
		const { readFile } = reader({
			"/proj/.pi/agy-bridge.json": JSON.stringify({ imageInput: "yes" }),
		});
		const loaded = await loadFileConfig({ env: ENV, cwd: "/proj", agentDir: "/agent", readFile });
		expect(loaded.config.imageInput as unknown).toBe("yes");
		expect(loaded.warnings).toEqual([]);
	});
});
