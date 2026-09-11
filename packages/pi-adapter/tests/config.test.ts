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

describe("unit: config — askAgy section and file layer (v0.2 R1, R2; D10)", () => {
	test("confirmed defaults: enabled false, defaultMode read, allowFullMode true, isolated false, appendSkills true", () => {
		const config = resolveConfig({ env: {} });
		expect(config.askAgy).toEqual({
			enabled: false,
			defaultMode: "read",
			allowFullMode: true,
			defaultIsolated: false,
			appendSkills: true,
		});
	});

	test("THREAT: defaultMode 'turbo' throws a typed error BEFORE any spawn", () => {
		try {
			resolveConfig({ askAgy: { defaultMode: "turbo" } as never, env: {} });
			throw new Error("unreachable: defaultMode turbo must throw");
		} catch (error) {
			expect(error).toBeInstanceOf(AgyConfigError);
			const typed = error as AgyConfigError;
			expect(typed.field).toBe("askAgy.defaultMode");
			expect(typed.message).toContain("turbo");
		}
	});

	test("allowFullMode:false narrows the enum to read|none: 'full' is rejected", () => {
		expect(() => resolveConfig({ askAgy: { allowFullMode: false, defaultMode: "full" }, env: {} })).toThrow(
			AgyConfigError,
		);
		expect(resolveConfig({ askAgy: { allowFullMode: false, defaultMode: "read" }, env: {} }).askAgy.defaultMode).toBe(
			"read",
		);
		expect(resolveConfig({ askAgy: { allowFullMode: false, defaultMode: "none" }, env: {} }).askAgy.defaultMode).toBe(
			"none",
		);
	});

	test("metadata options pass through; appendSkills defaults true", () => {
		const askAgy = resolveConfig({
			askAgy: { enabled: true, name: "AskSecond", label: "L", description: "D", defaultIsolated: true },
			env: {},
		}).askAgy;
		expect(askAgy.enabled).toBe(true);
		expect(askAgy.name).toBe("AskSecond");
		expect(askAgy.label).toBe("L");
		expect(askAgy.description).toBe("D");
		expect(askAgy.defaultIsolated).toBe(true);
		expect(askAgy.appendSkills).toBe(true);
	});

	test("unknown askAgy keys are ignored (tolerant, R2)", () => {
		const askAgy = resolveConfig({ askAgy: { enabled: true, turbo: 5 } as never, env: {} }).askAgy;
		expect(askAgy.enabled).toBe(true);
		expect((askAgy as unknown as Record<string, unknown>)["turbo"]).toBeUndefined();
	});

	test("wrong-typed askAgy values throw with the exact field path", () => {
		for (const [field, askAgy] of [
			["askAgy.enabled", { enabled: "yes" }],
			["askAgy.label", { label: 5 }],
			["askAgy.description", { description: {} }],
			["askAgy.defaultIsolated", { defaultIsolated: "x" }],
			["askAgy.allowFullMode", { allowFullMode: 1 }],
			["askAgy.appendSkills", { appendSkills: "no" }],
		] as const) {
			try {
				resolveConfig({ askAgy: askAgy as never, env: {} });
				throw new Error(`unreachable: ${field} bad type must throw`);
			} catch (error) {
				expect(error).toBeInstanceOf(AgyConfigError);
				expect((error as AgyConfigError).field).toBe(field);
			}
		}
	});

	test("the file layer sits BEHIND explicit options: explicit beats layer beats defaults", () => {
		const layer = { config: { timeoutMs: 60, stateDir: "/f/layer", models: { m: { name: "F" } } }, askAgy: {} };
		const explicit = resolveConfig({ timeoutMs: 5000, env: {} }, layer);
		expect(explicit.timeoutMs).toBe(5000);
		expect(explicit.stateDir).toBe("/f/layer");
		expect(explicit.models["m"]?.name).toBe("F");
		const explicitModel = resolveConfig({ models: { m: { name: "E" } }, env: {} }, layer);
		expect(explicitModel.models["m"]?.name).toBe("E");
	});

	test("askAgy from the file layer passes the same single validation gate; explicit wins per key", () => {
		expect(() => resolveConfig({ env: {} }, { config: {}, askAgy: { defaultMode: "turbo" } })).toThrow(
			AgyConfigError,
		);
		const resolved = resolveConfig(
			{ askAgy: { defaultMode: "read" }, env: {} },
			{ config: {}, askAgy: { defaultMode: "turbo", enabled: true } },
		).askAgy;
		expect(resolved.defaultMode).toBe("read");
		expect(resolved.enabled).toBe(true);
	});
});
