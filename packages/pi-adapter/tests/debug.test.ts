/**
 * Unit tests for the opt-in unified debug log (v0.2 R11, design D11,
 * tasks 4.1/4.2): the AGY_BRIDGE_DEBUG=1 env gate, the
 * AGY_BRIDGE_DEBUG_PATH override over the <stateDir>/debug.log default,
 * the one-JSON-object-per-line shape ({ts, event, ...fields} — ISO ts,
 * ids/codes/durations only), the 5 MB truncate-fresh size policy,
 * on-demand parent mkdir, and the silent no-op on an unwritable path
 * (debug must never break the bridge). The API-surface row pins the
 * structural property that makes prompt leakage impossible: the logger
 * synthesizes nothing and exposes no free-text channel beyond `event`
 * and caller-supplied id/code fields.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDebugLogger, debugLogPath } from "../src/debug";

async function tmpState(): Promise<string> {
	return mkdtemp(join(tmpdir(), "agy-pi-debug-"));
}

function readLines(path: string): Record<string, unknown>[] {
	return require("node:fs")
	.readFileSync(path, "utf8")
	.split("\n")
	.filter((l: string) => l !== "")
	.map((l: string) => JSON.parse(l) as Record<string, unknown>);
}

describe("unit: debug — env gate (R11)", () => {
	test("AGY_BRIDGE_DEBUG unset: log() is a no-op — zero files, zero writes", async () => {
		const stateDir = await tmpState();
		const logger = createDebugLogger({ env: {}, stateDir });
		logger.log("turn_start", { key: "k1" });
		logger.log("turn_end", { key: "k1", classification: "success" });
		expect(existsSync(debugLogPath({ env: {}, stateDir }))).toBe(false);
		expect(existsSync(join(stateDir, "debug.log"))).toBe(false);
	});

	test("AGY_BRIDGE_DEBUG=1 (any other value stays off: only the literal 1 enables)", async () => {
		const stateDir = await tmpState();
		createDebugLogger({ env: { AGY_BRIDGE_DEBUG: "true" }, stateDir }).log("turn_start");
		expect(existsSync(join(stateDir, "debug.log"))).toBe(false);
		createDebugLogger({ env: { AGY_BRIDGE_DEBUG: "1" }, stateDir }).log("turn_start");
		expect(existsSync(join(stateDir, "debug.log"))).toBe(true);
	});
});

describe("unit: debug — path resolution (D11)", () => {
	test("default path is <stateDir>/debug.log (stateDir already resolves <root>/agy-bridge)", async () => {
		const stateDir = await tmpState();
		expect(debugLogPath({ env: {}, stateDir })).toBe(join(stateDir, "debug.log"));
		createDebugLogger({ env: { AGY_BRIDGE_DEBUG: "1" }, stateDir }).log("turn_end", { key: "k2" });
		expect(existsSync(join(stateDir, "debug.log"))).toBe(true);
	});

	test("AGY_BRIDGE_DEBUG_PATH override wins; the default location is never created", async () => {
		const stateDir = await tmpState();
		const overridePath = join(stateDir, "elsewhere", "bridge-debug.log");
		const logger = createDebugLogger({ env: { AGY_BRIDGE_DEBUG: "1", AGY_BRIDGE_DEBUG_PATH: overridePath }, stateDir });
		logger.log("discovery", { source: "fresh" });
		expect(existsSync(overridePath)).toBe(true);
		expect(existsSync(join(stateDir, "debug.log"))).toBe(false);
		const lines = readLines(overridePath);
		expect(lines).toHaveLength(1);
		expect(lines[0]["event"]).toBe("discovery");
		expect(lines[0]["source"]).toBe("fresh");
	});

	test("missing parent dirs are created on demand (mkdir on first write)", async () => {
		const stateDir = await tmpState();
		const nested = join(stateDir, "does", "not", "exist");
		const logger = createDebugLogger({ env: { AGY_BRIDGE_DEBUG: "1", AGY_BRIDGE_DEBUG_PATH: join(nested, "debug.log") }, stateDir });
		expect(() => logger.log("session_start", { reason: "startup" })).not.toThrow();
		const lines = readLines(join(nested, "debug.log"));
		expect(lines).toHaveLength(1);
		expect(lines[0]["reason"]).toBe("startup");
	});
});

describe("unit: debug — line shape (R11: ids, codes, durations — never prompt text)", () => {
	test("every line is exactly one JSON object {ts, event, ...fields} with an ISO ts", async () => {
		const stateDir = await tmpState();
		const logger = createDebugLogger({ env: { AGY_BRIDGE_DEBUG: "1" }, stateDir });
		logger.log("classified", { key: "s-1", classification: "success", conversationId: "conv-9", resumed: false, durationMs: 12 });
		const lines = readLines(join(stateDir, "debug.log"));
		expect(lines).toHaveLength(1);
		expect(typeof lines[0]["ts"]).toBe("string");
		expect(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(lines[0]["ts"] as string)).toBe(true);
		expect(lines[0]["event"]).toBe("classified");
		expect(lines[0]["key"]).toBe("s-1");
		expect(lines[0]["classification"]).toBe("success");
		expect(lines[0]["conversationId"]).toBe("conv-9");
		expect(lines[0]["durationMs"]).toBe(12);
	});

	test("events append in order, one line per event", async () => {
		const stateDir = await tmpState();
		const logger = createDebugLogger({ env: { AGY_BRIDGE_DEBUG: "1" }, stateDir });
		logger.log("turn_start", { key: "s-2" });
		logger.log("turn_end", { key: "s-2", classification: "success" });
		const lines = readLines(join(stateDir, "debug.log"));
		expect(lines.map((l) => l["event"])).toEqual(["turn_start", "turn_end"]);
	});

	test("structural: the logger surface is {log} only and lines carry exactly {ts, event, ...fields} — no synthesized fields, no free-text channel", async () => {
		const stateDir = await tmpState();
		const logger = createDebugLogger({ env: { AGY_BRIDGE_DEBUG: "1" }, stateDir });
		// The API surface makes prompt logging impossible: nothing but log().
		expect(Object.keys(logger).sort()).toEqual(["log"]);
		const fields = { key: "s-3", mode: "plan", durationMs: 3 };
		logger.log("turn_start", fields);
		const lines = readLines(join(stateDir, "debug.log"));
		expect(Object.keys(lines[0]).sort()).toEqual(["durationMs", "event", "key", "mode", "ts"]);
		// No prompt-shaped key can appear unless the caller passes it as a
		// documented id/code field — the logger never invents content.
		expect(Object.keys(lines[0]).filter((k) => !["ts", "event", ...Object.keys(fields)].includes(k))).toEqual([]);
	});
});

describe("unit: debug — 5 MB truncate (D11: truncate fresh, no rotation chain)", () => {
	test("a file over 5 MB is truncated to empty before the next append", async () => {
		const stateDir = await tmpState();
		const path = join(stateDir, "debug.log");
		mkdirSync(stateDir, { recursive: true });
		const filler = `${"x".repeat(1024)}\n`.repeat(5 * 1024 + 1); // > 5 MiB of junk lines
		writeFileSync(path, filler);
		expect(require("node:fs").statSync(path).size).toBeGreaterThan(5 * 1024 * 1024);
		const logger = createDebugLogger({ env: { AGY_BRIDGE_DEBUG: "1" }, stateDir });
		logger.log("turn_end", { key: "s-4", classification: "success" });
		const raw = require("node:fs").readFileSync(path, "utf8") as string;
		const lines = raw.split("\n").filter((l) => l !== "");
		expect(lines).toHaveLength(1);
		expect((JSON.parse(lines[0]) as Record<string, unknown>)["event"]).toBe("turn_end");
		expect(raw.length).toBeLessThan(1024);
	});

	test("a file at/under 5 MB is appended to, never truncated", async () => {
		const stateDir = await tmpState();
		const path = join(stateDir, "debug.log");
		writeFileSync(path, '{"ts":"2026-01-01T00:00:00.000Z","event":"old"}\n');
		createDebugLogger({ env: { AGY_BRIDGE_DEBUG: "1" }, stateDir }).log("turn_start", { key: "s-5" });
		const lines = readLines(path);
		expect(lines.map((l) => l["event"])).toEqual(["old", "turn_start"]);
	});
});

describe("unit: debug — silent failure (D11: debug must never break the bridge)", () => {
	test("unwritable path (parent is a file → ENOTDIR): log() swallows and never throws", async () => {
		const stateDir = await tmpState();
		const blocker = join(stateDir, "blocker");
		writeFileSync(blocker, "not a dir");
		const logger = createDebugLogger({
			env: { AGY_BRIDGE_DEBUG: "1", AGY_BRIDGE_DEBUG_PATH: join(blocker, "debug.log") },
			stateDir,
		});
		expect(() => {
			logger.log("turn_start", { key: "s-6" });
			logger.log("turn_end", { key: "s-6", classification: "success" });
		}).not.toThrow();
	});
});
