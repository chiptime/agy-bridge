import { spawn as defaultSpawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { join } from "node:path";

export interface OpenInteractiveSessionOptions {
	/** agy conversationId to resume. */
	conversationId: string;
	/** Working directory for the agy process. */
	cwd?: string;
	/** agy binary name or path. Default: env.AGY_BIN ?? "agy" */
	bin?: string;
	/** Environment variables snapshot. Default: process.env */
	env?: Record<string, string | undefined>;
	/** Test seam: custom spawn function. */
	spawnFn?: (command: string, args: string[], options: unknown) => ChildProcess | { unref?: () => void };
	/** Test seam: check if a command is executable on PATH. */
	isCommandAvailable?: (cmd: string) => boolean;
	/** Test seam: check if a terminal emulator is known broken on the system. */
	isTerminalBroken?: (term: string) => boolean;
}

export type OpenInteractiveSessionResult =
	| { success: true; method: "tmux-popup"; command: string }
	| { success: true; method: "terminal-window"; terminal: string; command: string }
	| { success: false; reason: "no_display_or_terminal" | "spawn_failed"; command: string; error?: string };

/** Build the verbatim CLI invocation for resuming an agy conversation. */
export function buildAgyResumeCommand(bin: string, conversationId: string): string {
	return `${bin} --conversation ${conversationId}`;
}

/** Check if a binary name or absolute path is executable on PATH. */
export function isExecutableInPath(cmd: string, env: Record<string, string | undefined> = process.env): boolean {
	if (cmd.includes("/")) {
		try {
			accessSync(cmd, constants.X_OK);
			return true;
		} catch {
			return false;
		}
	}
	const pathVal = env.PATH ?? process.env.PATH ?? "";
	for (const dir of pathVal.split(":")) {
		if (!dir) continue;
		try {
			accessSync(join(dir, cmd), constants.X_OK);
			return true;
		} catch {}
	}
	return false;
}

export function isWsl(env: Record<string, string | undefined> = process.env): boolean {
	return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

function isBrokenTerminal(term: string): boolean {
	if (term.includes("zutty")) return true;
	try {
		const target = term.includes("/") ? term : `/usr/bin/${term}`;
		const real = realpathSync(target);
		if (real.includes("zutty")) return true;
	} catch {}
	return false;
}

/**
 * Open an active agy conversation in an interactive session.
 *
 * Precedence:
 * 1. tmux display-popup (if running inside tmux, $TMUX is set and tmux is on PATH)
 * 2. WSL host terminal (WezTerm or Windows Terminal if in WSL)
 * 3. Linux GUI terminal window (if $DISPLAY or $WAYLAND_DISPLAY is set and a terminal emulator is on PATH)
 * 4. Graceful failure returning the verbatim command to run manually
 */
export function openInteractiveAgySession(options: OpenInteractiveSessionOptions): OpenInteractiveSessionResult {
	const env = options.env ?? process.env;
	const bin = options.bin ?? env.AGY_BIN ?? "agy";
	const command = buildAgyResumeCommand(bin, options.conversationId);
	const spawnFn = options.spawnFn ?? defaultSpawn;
	const checkCmd = options.isCommandAvailable ?? ((cmd) => isExecutableInPath(cmd, env));
	const checkBroken = options.isTerminalBroken ?? isBrokenTerminal;

	// 1. Prefer tmux display-popup when inside a tmux session
	if (env.TMUX && checkCmd("tmux")) {
		const title = ` agy: ${options.conversationId.slice(0, 8)} `;
		const tmuxArgs = ["display-popup"];
		if (options.cwd) {
			tmuxArgs.push("-d", options.cwd);
		}
		tmuxArgs.push("-w", "85%", "-h", "85%", "-T", title, "-E", command);

		try {
			const child = spawnFn("tmux", tmuxArgs, {
				cwd: options.cwd,
				detached: true,
				stdio: "ignore",
				env: env as NodeJS.ProcessEnv,
			});
			child?.unref?.();
			return { success: true, method: "tmux-popup", command };
		} catch (err) {
			return {
				success: false,
				reason: "spawn_failed",
				command,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	}

	// 2. In WSL: prefer host Windows terminal emulators (WezTerm, wt.exe)
	if (isWsl(env)) {
		const distro = env.WSL_DISTRO_NAME ?? "Ubuntu";

		// 2a. If running WezTerm or WezTerm GUI is available:
		const weztermCandidates = [
			"/mnt/c/Program Files/WezTerm/wezterm-gui.exe",
			"/mnt/c/Program Files/WezTerm/wezterm.exe",
			"wezterm-gui.exe",
			"wezterm.exe",
			"wezterm",
		];
		const weztermBin = (env.TERM_PROGRAM === "WezTerm" ? weztermCandidates : []).find((c) => checkCmd(c))
			?? weztermCandidates.find((c) => checkCmd(c));

		if (weztermBin) {
			const weztermArgs = ["start"];
			if (options.cwd) {
				weztermArgs.push("--cwd", options.cwd);
			}
			weztermArgs.push("--", "wsl.exe", "-d", distro, "-e", bin, "--conversation", options.conversationId);

			try {
				const child = spawnFn(weztermBin, weztermArgs, {
					cwd: options.cwd,
					detached: true,
					stdio: "ignore",
					env: env as NodeJS.ProcessEnv,
				});
				child?.unref?.();
				return { success: true, method: "terminal-window", terminal: "wezterm", command };
			} catch (err) {
				return {
					success: false,
					reason: "spawn_failed",
					command,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}

		// 2b. Windows Terminal (wt.exe)
		const wtCandidates = [
			"wt.exe",
			"/mnt/c/Users/Bruno/AppData/Local/Microsoft/WindowsApps/wt.exe",
		];
		const wtBin = wtCandidates.find((c) => checkCmd(c));
		if (wtBin) {
			const wtArgs = options.cwd ? ["-d", options.cwd] : [];
			wtArgs.push("wsl.exe", "-d", distro, "-e", bin, "--conversation", options.conversationId);

			try {
				const child = spawnFn(wtBin, wtArgs, {
					cwd: options.cwd,
					detached: true,
					stdio: "ignore",
					env: env as NodeJS.ProcessEnv,
				});
				child?.unref?.();
				return { success: true, method: "terminal-window", terminal: "wt.exe", command };
			} catch (err) {
				return {
					success: false,
					reason: "spawn_failed",
					command,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}
	}

	// 3. Fall back to desktop terminal emulator if GUI display is available
	const hasDisplay = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
	if (hasDisplay) {
		const candidates = env.TERMINAL
			? [env.TERMINAL]
			: [
					"ghostty",
					"kitty",
					"alacritty",
					"wezterm",
					"foot",
					"gnome-terminal",
					"konsole",
					"xfce4-terminal",
					"xterm",
					"x-terminal-emulator",
				];

		const term = candidates.find((t) => checkCmd(t) && !checkBroken(t));
		if (term) {
			const termArgs =
				term === "gnome-terminal"
					? ["--", bin, "--conversation", options.conversationId]
					: ["-e", bin, "--conversation", options.conversationId];

			try {
				const child = spawnFn(term, termArgs, {
					cwd: options.cwd,
					detached: true,
					stdio: "ignore",
					env: env as NodeJS.ProcessEnv,
				});
				child?.unref?.();
				return { success: true, method: "terminal-window", terminal: term, command };
			} catch (err) {
				return {
					success: false,
					reason: "spawn_failed",
					command,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}
	}

	// 4. Fallback: headless or no terminal found
	return { success: false, reason: "no_display_or_terminal", command };
}
