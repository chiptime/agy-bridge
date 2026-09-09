/**
 * Unit tests for path resolution (spec R7 state file, R9 scratch root):
 * XDG_STATE_HOME with absolute/relative/absent variants, HOME fallback,
 * the exact opencode-sessions.json location, and scratch-root defaulting.
 */
import { describe, expect, test } from "bun:test";
import { resolveScratchRoot, resolveStateDir, sessionMapPath } from "../src/paths";

describe("unit: paths — XDG state and scratch resolution", () => {
	test("XDG_STATE_HOME (absolute) wins and gets the agy-bridge suffix", () => {
		const dir = resolveStateDir({ env: { XDG_STATE_HOME: "/xdg/state" } });
		expect(dir).toBe("/xdg/state/agy-bridge");
	});

	test("a relative XDG_STATE_HOME is ignored per the XDG spec", () => {
		const dir = resolveStateDir({ env: { XDG_STATE_HOME: "relative/state", HOME: "/home/tester" } });
		expect(dir).toBe("/home/tester/.local/state/agy-bridge");
	});

	test("unset XDG_STATE_HOME falls back to ~/.local/state", () => {
		const dir = resolveStateDir({ env: { HOME: "/home/tester" } });
		expect(dir).toBe("/home/tester/.local/state/agy-bridge");
	});

	test("an explicit override beats every environment source", () => {
		const dir = resolveStateDir({ override: "/custom/state", env: { XDG_STATE_HOME: "/xdg/state" } });
		expect(dir).toBe("/custom/state/agy-bridge");
	});

	test("session map path is <state>/opencode-sessions.json (R7 exact layout)", () => {
		const p = sessionMapPath({ env: { XDG_STATE_HOME: "/xdg/state" } });
		expect(p).toBe("/xdg/state/agy-bridge/opencode-sessions.json");
	});

	test("scratch root: override wins, else injected tmpdir, else os.tmpdir()", () => {
		expect(resolveScratchRoot({ override: "/scratch/root" })).toBe("/scratch/root");
		expect(resolveScratchRoot({ tmpdir: "/t/tmp" })).toBe("/t/tmp");
		expect(typeof resolveScratchRoot()).toBe("string");
		expect(resolveScratchRoot().startsWith("/")).toBe(true);
	});
});
