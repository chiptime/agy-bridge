/**
 * Unit tests for config resolution (spec R12 env parity + threat-matrix
 * "never a relative path"): AGY_BIN resolution, timeoutMs budget, absolute
 * stateDir with the XDG default, the models override map, and typed
 * fail-fast errors thrown BEFORE any spawn can happen.
 */
import { describe, expect, test } from "bun:test";
import { AgyConfigError, resolveConfig } from "../src/config";

describe("unit: config — env parity and fail-fast validation (R12)", () => {
	test("defaults: agy binary 'agy' on PATH, XDG state dir, empty model map", () => {
		const config = resolveConfig({ env: { HOME: "/home/tester" } });
		expect(config.agyBin).toBe("agy");
		expect(config.stateDir).toBe("/home/tester/.local/state/agy-bridge");
		expect(config.models).toEqual({});
		expect(config.timeoutMs).toBeUndefined();
		expect(config.scratchRoot).toBeUndefined();
	});

	test("AGY_BIN from the injected environment wins over the PATH default", () => {
		const config = resolveConfig({ env: { AGY_BIN: "/opt/agy/bin/agy", HOME: "/home/tester" } });
		expect(config.agyBin).toBe("/opt/agy/bin/agy");
	});

	test("an injected env is used alone: unset AGY_BIN never falls through to process.env", () => {
		const config = resolveConfig({ env: { HOME: "/home/tester" } });
		expect(config.agyBin).toBe("agy");
	});

	test("an absolute XDG_STATE_HOME becomes the state dir default", () => {
		const config = resolveConfig({ env: { XDG_STATE_HOME: "/xdg/state" } });
		expect(config.stateDir).toBe("/xdg/state/agy-bridge");
	});

	test("an absolute stateDir override beats the environment default", () => {
		const config = resolveConfig({ stateDir: "/custom/state", env: { XDG_STATE_HOME: "/xdg/state" } });
		expect(config.stateDir).toBe("/custom/state");
	});

	test("THREAT: a relative stateDir throws a typed error before any spawn", () => {
		expect(() => resolveConfig({ stateDir: "relative/state", env: {} })).toThrow(AgyConfigError);
		try {
			resolveConfig({ stateDir: "relative/state", env: {} });
		} catch (error) {
			const typed = error as AgyConfigError;
			expect(typed).toBeInstanceOf(AgyConfigError);
			expect(typed).toBeInstanceOf(Error);
			expect(typed.field).toBe("stateDir");
			expect(typed.code).toBe("AGY_CONFIG_INVALID");
			expect(typed.message).toContain("absolute");
		}
	});

	test("THREAT: a relative scratchRoot throws a typed error before any spawn", () => {
		try {
			resolveConfig({ scratchRoot: "relative/scratch", env: {} });
			throw new Error("unreachable: relative scratchRoot must throw");
		} catch (error) {
			expect(error).toBeInstanceOf(AgyConfigError);
			expect((error as AgyConfigError).field).toBe("scratchRoot");
		}
	});

	test("timeoutMs must be a positive integer; valid values pass through", () => {
		for (const bad of [0, -5, 1.5]) {
			try {
				resolveConfig({ timeoutMs: bad, env: {} });
				throw new Error(`unreachable: timeoutMs ${bad} must throw`);
			} catch (error) {
				expect(error).toBeInstanceOf(AgyConfigError);
				expect((error as AgyConfigError).field).toBe("timeoutMs");
			}
		}
		expect(resolveConfig({ timeoutMs: 120_000, env: {} }).timeoutMs).toBe(120_000);
	});

	test("model limits must be positive integers with output <= context", () => {
		try {
			resolveConfig({ models: { "gemini-3.8-flash": { limit: { context: 0, output: 10 } } }, env: {} });
			throw new Error("unreachable: zero context must throw");
		} catch (error) {
			expect(error).toBeInstanceOf(AgyConfigError);
			expect((error as AgyConfigError).field).toBe("models.gemini-3.8-flash.limit");
		}
		expect(() =>
			resolveConfig({
				models: { "gemini-3.8-flash": { limit: { context: 100, output: 200 } } },
				env: {},
			}),
		).toThrow(AgyConfigError);
	});

	test("the models override map passes through validated entries untouched", () => {
		const models = { "gemini-3.8-flash": { name: "Flash", limit: { context: 2000, output: 100 } } };
		const config = resolveConfig({ models, env: {} });
		expect(config.models).toEqual(models);
	});
});
