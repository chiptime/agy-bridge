/**
 * Unit tests for adapter config resolution (spec R9 defaults + validation):
 * workdirMode default/override/rejection, path-option absoluteness (threat:
 * never a relative path reaches spawn), model-limit sanity, and typed
 * AgyConfigError surfaces for every invalid field.
 */
import { describe, expect, test } from "bun:test";
import { AgyConfigError, resolveConfig } from "../src/config";

describe("unit: config — resolve adapter options", () => {
	test("defaults: unset options resolve to scratch mode and empty model overrides", () => {
		const cfg = resolveConfig();
		expect(cfg.workdirMode).toBe("scratch");
		expect(cfg.models).toEqual({});
		expect(cfg.timeoutMs).toBeUndefined();
	});

	test("workdirMode session is accepted", () => {
		expect(resolveConfig({ workdirMode: "session" }).workdirMode).toBe("session");
	});

	test("invalid workdirMode throws a typed config error naming the field", () => {
		try {
			resolveConfig({ workdirMode: "bogus" as never });
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(AgyConfigError);
			const err = e as AgyConfigError;
			expect(err.code).toBe("AGY_CONFIG_INVALID");
			expect(err.field).toBe("workdirMode");
			expect(err.message).toContain("scratch");
		}
	});

	test("relative path options are rejected: scratchRoot, stateDir, quotaSnapshotDir", () => {
		for (const field of ["scratchRoot", "stateDir", "quotaSnapshotDir"] as const) {
			try {
				resolveConfig({ [field]: "relative/dir" } as never);
				expect.unreachable();
			} catch (e) {
				expect(e).toBeInstanceOf(AgyConfigError);
				expect((e as AgyConfigError).field).toBe(field);
			}
		}
	});

	test("absolute path options pass through", () => {
		const cfg = resolveConfig({
			scratchRoot: "/tmp/agy-scratch",
			stateDir: "/tmp/agy-state",
			quotaSnapshotDir: "/tmp/agy-quota",
		});
		expect(cfg.scratchRoot).toBe("/tmp/agy-scratch");
		expect(cfg.stateDir).toBe("/tmp/agy-state");
		expect(cfg.quotaSnapshotDir).toBe("/tmp/agy-quota");
	});

	test("model limit overrides must be positive integers with output <= context", () => {
		const bad: Array<Record<string, unknown>> = [
			{ context: 0, output: 10 },
			{ context: 1000, output: 0 },
			{ context: 1.5, output: 1 },
			{ context: 100, output: 200 },
		];
		for (const limit of bad) {
			try {
				resolveConfig({ models: { "agy/custom": { limit } as never } });
				expect.unreachable();
			} catch (e) {
				expect(e).toBeInstanceOf(AgyConfigError);
				expect((e as AgyConfigError).field).toContain("models.agy/custom.limit");
			}
		}
	});

	test("valid model overrides are preserved verbatim", () => {
		const cfg = resolveConfig({
			models: { "agy/custom": { name: "Custom", limit: { context: 64000, output: 4096 } } },
		});
		expect(cfg.models["agy/custom"]).toEqual({
			name: "Custom",
			limit: { context: 64000, output: 4096 },
		});
	});

	test("timeoutMs must be a positive integer when provided", () => {
		for (const timeoutMs of [0, -5, 1.5]) {
			try {
				resolveConfig({ timeoutMs });
				expect.unreachable();
			} catch (e) {
				expect(e).toBeInstanceOf(AgyConfigError);
				expect((e as AgyConfigError).field).toBe("timeoutMs");
			}
		}
		expect(resolveConfig({ timeoutMs: 5000 }).timeoutMs).toBe(5000);
	});

	test("imageInput defaults to false (default-off contract)", () => {
		expect(resolveConfig().imageInput).toBe(false);
		expect(resolveConfig({ scratchRoot: "/tmp" }).imageInput).toBe(false);
	});

	test("imageInput true is accepted and preserved", () => {
		expect(resolveConfig({ imageInput: true }).imageInput).toBe(true);
	});

	test("imageInput must be a boolean when provided — strings/numbers/null are rejected", () => {
		for (const imageInput of ["true", 1, 0, null, {}]) {
			try {
				resolveConfig({ imageInput } as never);
				expect.unreachable();
			} catch (e) {
				expect(e).toBeInstanceOf(AgyConfigError);
				const err = e as AgyConfigError;
				expect(err.code).toBe("AGY_CONFIG_INVALID");
				expect(err.field).toBe("imageInput");
				expect(err.message).toContain("boolean");
			}
		}
	});
});
