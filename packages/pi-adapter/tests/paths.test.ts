/**
 * Unit tests for path resolution (spec R5 state file, R9 scratch root):
 * XDG_STATE_HOME with absolute/relative/absent variants, HOME fallback,
 * the exact pi-sessions.json location, and scratch-root defaulting.
 * Ported from the opencode-adapter sibling (proven pattern, new filename).
 */
import { describe, expect, test } from "bun:test";
import { piSessionMapPath, resolveScratchRoot, resolveStateDir } from "../src/paths";

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

	test("pi session map path is <state>/agy-bridge/pi-sessions.json (R5 exact layout)", () => {
		const p = piSessionMapPath({ env: { XDG_STATE_HOME: "/xdg/state" } });
		expect(p).toBe("/xdg/state/agy-bridge/pi-sessions.json");
	});

	test("scratch root: override wins, else injected tmpdir, else os.tmpdir()", () => {
		expect(resolveScratchRoot({ override: "/scratch/root" })).toBe("/scratch/root");
		expect(resolveScratchRoot({ tmpdir: "/t/tmp" })).toBe("/t/tmp");
		expect(typeof resolveScratchRoot()).toBe("string");
		expect(resolveScratchRoot().startsWith("/")).toBe(true);
	});
});
