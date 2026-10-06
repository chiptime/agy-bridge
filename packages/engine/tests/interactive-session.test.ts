import { describe, expect, test } from "bun:test";
import {
	buildAgyResumeCommand,
	openInteractiveAgySession,
} from "../src/interactive-session";

describe("unit: buildAgyResumeCommand", () => {
	test("formats binary and conversation id into standard resume flag", () => {
		expect(buildAgyResumeCommand("agy", "conv-123")).toBe("agy --conversation conv-123");
		expect(buildAgyResumeCommand("/path/to/agy", "abc-456")).toBe("/path/to/agy --conversation abc-456");
	});
});

describe("unit: openInteractiveAgySession", () => {
	test("prefers tmux display-popup when TMUX env is set and tmux is available", () => {
		const spawned: { cmd: string; args: string[]; options: unknown }[] = [];
		let unrefCalled = false;

		const result = openInteractiveAgySession({
			conversationId: "c1234567-89ab-cdef",
			cwd: "/work/project",
			bin: "agy",
			env: {
				TMUX: "/tmp/tmux-1000/default,123,0",
				PATH: "/bin:/usr/bin",
			},
			isCommandAvailable: (cmd) => cmd === "tmux",
			spawnFn: (cmd, args, options) => {
				spawned.push({ cmd, args, options });
				return {
					unref: () => {
						unrefCalled = true;
					},
				};
			},
		});

		expect(result).toEqual({
			success: true,
			method: "tmux-popup",
			command: "agy --conversation c1234567-89ab-cdef",
		});
		expect(spawned).toHaveLength(1);
		expect(spawned[0]?.cmd).toBe("tmux");
		expect(spawned[0]?.args).toEqual([
			"display-popup",
			"-d",
			"/work/project",
			"-w",
			"85%",
			"-h",
			"85%",
			"-T",
			" agy: c1234567 ",
			"-E",
			"agy --conversation c1234567-89ab-cdef",
		]);
		expect(unrefCalled).toBe(true);
	});

	test("falls through to desktop terminal when TMUX is not set but DISPLAY is set", () => {
		const spawned: { cmd: string; args: string[] }[] = [];
		let unrefCalled = false;

		const result = openInteractiveAgySession({
			conversationId: "conv-xyz",
			cwd: "/work/project",
			env: {
				DISPLAY: ":0",
			},
			isCommandAvailable: (cmd) => cmd === "x-terminal-emulator",
			isTerminalBroken: () => false,
			spawnFn: (cmd, args) => {
				spawned.push({ cmd, args });
				return { unref: () => (unrefCalled = true) };
			},
		});

		expect(result).toEqual({
			success: true,
			method: "terminal-window",
			terminal: "x-terminal-emulator",
			command: "agy --conversation conv-xyz",
		});
		expect(spawned).toHaveLength(1);
		expect(spawned[0]?.cmd).toBe("x-terminal-emulator");
		expect(spawned[0]?.args).toEqual(["-e", "agy", "--conversation", "conv-xyz"]);
		expect(unrefCalled).toBe(true);
	});

	test("in WSL detects WezTerm when TERM_PROGRAM is WezTerm", () => {
		const spawned: { cmd: string; args: string[] }[] = [];

		const result = openInteractiveAgySession({
			conversationId: "conv-wez",
			cwd: "/home/user/code",
			env: {
				WSL_DISTRO_NAME: "Ubuntu",
				TERM_PROGRAM: "WezTerm",
			},
			isCommandAvailable: (cmd) => cmd === "wezterm",
			spawnFn: (cmd, args) => {
				spawned.push({ cmd, args });
				return { unref: () => {} };
			},
		});

		expect(result).toEqual({
			success: true,
			method: "terminal-window",
			terminal: "wezterm",
			command: "agy --conversation conv-wez",
		});
		expect(spawned[0]?.cmd).toBe("wezterm");
		expect(spawned[0]?.args).toEqual([
			"start",
			"--cwd",
			"/home/user/code",
			"--",
			"wsl.exe",
			"-d",
			"Ubuntu",
			"-e",
			"agy",
			"--conversation",
			"conv-wez",
		]);
	});

	test("in WSL detects wt.exe when available", () => {
		const spawned: { cmd: string; args: string[] }[] = [];

		const result = openInteractiveAgySession({
			conversationId: "conv-wt",
			cwd: "/home/user/code",
			env: {
				WSL_DISTRO_NAME: "Ubuntu",
			},
			isCommandAvailable: (cmd) => cmd === "wt.exe",
			spawnFn: (cmd, args) => {
				spawned.push({ cmd, args });
				return { unref: () => {} };
			},
		});

		expect(result).toEqual({
			success: true,
			method: "terminal-window",
			terminal: "wt.exe",
			command: "agy --conversation conv-wt",
		});
		expect(spawned[0]?.cmd).toBe("wt.exe");
		expect(spawned[0]?.args).toEqual([
			"-d",
			"/home/user/code",
			"wsl.exe",
			"-d",
			"Ubuntu",
			"-e",
			"agy",
			"--conversation",
			"conv-wt",
		]);
	});

	test("skips broken terminal emulators like zutty and falls back to next available", () => {
		const spawned: { cmd: string; args: string[] }[] = [];

		const result = openInteractiveAgySession({
			conversationId: "conv-xyz",
			env: {
				DISPLAY: ":0",
			},
			isCommandAvailable: (cmd) => cmd === "x-terminal-emulator" || cmd === "xterm",
			isTerminalBroken: (cmd) => cmd === "x-terminal-emulator",
			spawnFn: (cmd, args) => {
				spawned.push({ cmd, args });
				return {};
			},
		});

		expect(result.success).toBe(true);
		expect(spawned[0]?.cmd).toBe("xterm");
	});

	test("prioritizes TERMINAL env variable when set", () => {
		const spawned: { cmd: string; args: string[] }[] = [];

		const result = openInteractiveAgySession({
			conversationId: "conv-xyz",
			env: {
				WAYLAND_DISPLAY: "wayland-0",
				TERMINAL: "my-custom-terminal",
			},
			isCommandAvailable: (cmd) => cmd === "my-custom-terminal",
			spawnFn: (cmd, args) => {
				spawned.push({ cmd, args });
				return {};
			},
		});

		expect(result).toEqual({
			success: true,
			method: "terminal-window",
			terminal: "my-custom-terminal",
			command: "agy --conversation conv-xyz",
		});
		expect(spawned[0]?.cmd).toBe("my-custom-terminal");
	});

	test("uses -- syntax for gnome-terminal", () => {
		const spawned: { cmd: string; args: string[] }[] = [];

		const result = openInteractiveAgySession({
			conversationId: "conv-xyz",
			env: {
				DISPLAY: ":0",
			},
			isCommandAvailable: (cmd) => cmd === "gnome-terminal",
			spawnFn: (cmd, args) => {
				spawned.push({ cmd, args });
				return {};
			},
		});

		expect(result.success).toBe(true);
		expect(spawned[0]?.cmd).toBe("gnome-terminal");
		expect(spawned[0]?.args).toEqual(["--", "agy", "--conversation", "conv-xyz"]);
	});

	test("returns no_display_or_terminal when headless and outside tmux", () => {
		const result = openInteractiveAgySession({
			conversationId: "conv-headless",
			env: {},
			isCommandAvailable: () => true,
		});

		expect(result).toEqual({
			success: false,
			reason: "no_display_or_terminal",
			command: "agy --conversation conv-headless",
		});
	});

	test("handles spawn errors gracefully", () => {
		const result = openInteractiveAgySession({
			conversationId: "conv-fail",
			env: { TMUX: "1" },
			isCommandAvailable: () => true,
			spawnFn: () => {
				throw new Error("EPERM: operation not permitted");
			},
		});

		expect(result).toEqual({
			success: false,
			reason: "spawn_failed",
			command: "agy --conversation conv-fail",
			error: "EPERM: operation not permitted",
		});
	});
});
