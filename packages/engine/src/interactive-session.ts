import { spawn as defaultSpawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
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

/**
 * Open an active agy conversation in an interactive session.
 *
 * Precedence:
 * 1. tmux display-popup (if running inside tmux, $TMUX is set and tmux is on PATH)
 * 2. GUI terminal window (if $DISPLAY or $WAYLAND_DISPLAY is set and a terminal emulator is on PATH)
 * 3. Graceful failure returning the verbatim command to run manually
 */
export function openInteractiveAgySession(options: OpenInteractiveSessionOptions): OpenInteractiveSessionResult {
	const env = options.env ?? process.env;
	const bin = options.bin ?? env.AGY_BIN ?? "agy";
	const command = buildAgyResumeCommand(bin, options.conversationId);
	const spawnFn = options.spawnFn ?? defaultSpawn;
	const checkCmd = options.isCommandAvailable ?? ((cmd) => isExecutableInPath(cmd, env));

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

	// 2. Fall back to desktop terminal emulator if GUI display is available
	const hasDisplay = Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
	if (hasDisplay) {
		const candidates = env.TERMINAL
			? [env.TERMINAL]
			: [
					"x-terminal-emulator",
					"ghostty",
					"kitty",
					"alacritty",
					"wezterm",
					"foot",
					"gnome-terminal",
					"konsole",
					"xfce4-terminal",
					"xterm",
				];

		const term = candidates.find((t) => checkCmd(t));
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

	// 3. Fallback: headless or no terminal found
	return { success: false, reason: "no_display_or_terminal", command };
}
