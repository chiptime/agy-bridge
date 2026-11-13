/**
 * Host-agnostic helpers for the v2 TUI entry. They mirror the private helpers
 * of the v1 TUI (packages/opencode-adapter/src/tui.ts), which are not exported
 * and import the v1 TUI runtime, so the v1 file stays untouched. Differences:
 * the environment and home directory are injectable, and herdr/tmux are
 * invoked with argument arrays instead of a shell string.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { isExecutableInPath } from "agy-bridge-engine";

export type Env = Record<string, string | undefined>;

export interface TranscriptTurn {
	role: "user" | "assistant";
	text: string;
	time?: string;
}

export interface SavedSessionInfo {
	conversationId: string;
	opencodeSessionId: string;
	updatedAt?: string;
	model?: string;
}

export function truncate(str: string, max: number): string {
	if (!str) return "";
	return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function pipeTo(bin: string, args: string[], text: string): void {
	const proc = spawn(bin, args, { stdio: ["pipe", "ignore", "ignore"] });
	proc.stdin.write(text);
	proc.stdin.end();
}

/** OSC 52 to the terminal, then the first available system clipboard tool. */
export function copyToClipboard(text: string): boolean {
	try {
		if (process.stdout?.isTTY) {
			process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
		}
		const clip = isExecutableInPath("clip.exe")
			? "clip.exe"
			: isExecutableInPath("/mnt/c/WINDOWS/system32/clip.exe")
				? "/mnt/c/WINDOWS/system32/clip.exe"
				: null;
		if (clip) pipeTo(clip, [], text);
		else if (isExecutableInPath("wl-copy")) pipeTo("wl-copy", [], text);
		else if (isExecutableInPath("xclip")) pipeTo("xclip", ["-selection", "clipboard"], text);
		return true;
	} catch {
		return false;
	}
}

export function isSplitAvailable(env: Env): boolean {
	return (env.HERDR_ENV === "1" && isExecutableInPath("herdr")) || (Boolean(env.TMUX) && isExecutableInPath("tmux"));
}

/** Open `agy --conversation <id>` in a herdr or tmux split next to opencode. */
export function launchSplit(conversationId: string, cwd: string | undefined, env: Env): { success: boolean; method: string } {
	const agyCommand = `agy --conversation ${conversationId}`;
	const execEnv = env as NodeJS.ProcessEnv;
	if (env.HERDR_ENV === "1" && isExecutableInPath("herdr")) {
		try {
			const out = execFileSync(
				"herdr",
				["pane", "split", "--current", "--direction", "right", "--focus", ...(cwd ? ["--cwd", cwd] : [])],
				{ encoding: "utf-8", env: execEnv },
			);
			let paneId = "";
			try {
				const parsed = JSON.parse(out);
				paneId = parsed?.result?.pane?.pane_id || parsed?.result?.pane_id || "";
			} catch {}
			if (paneId) {
				execFileSync("herdr", ["pane", "run", paneId, agyCommand], { env: execEnv });
				return { success: true, method: "herdr-split" };
			}
		} catch {
			// fall through to tmux
		}
	}
	if (env.TMUX && isExecutableInPath("tmux")) {
		try {
			execFileSync("tmux", ["split-window", "-h", ...(cwd ? ["-c", cwd] : []), agyCommand], { env: execEnv });
			return { success: true, method: "tmux-split" };
		} catch {
			// fall through
		}
	}
	return { success: false, method: "none" };
}

/** Last user/assistant turns of an agy conversation transcript, oldest first. */
export function readRecentTranscript(conversationId: string, env: Env, maxTurns = 8): TranscriptTurn[] {
	const home = env.HOME || homedir();
	const path = join(home, ".gemini/antigravity-cli/brain", conversationId, ".system_generated/logs/transcript.jsonl");
	if (!existsSync(path)) return [];
	try {
		const lines = readFileSync(path, "utf-8").trim().split("\n");
		const turns: TranscriptTurn[] = [];
		for (let i = lines.length - 1; i >= 0 && turns.length < maxTurns; i--) {
			try {
				const item = JSON.parse(lines[i]!);
				if (item.type === "USER_INPUT" && item.content) {
					let text = String(item.content);
					const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
					if (match) text = match[1]!.trim();
					turns.unshift({ role: "user", text, time: item.created_at });
				} else if (item.type === "PLANNER_RESPONSE") {
					const text = String(item.content || item.thinking || "").trim();
					if (text) turns.unshift({ role: "assistant", text, time: item.created_at });
				}
			} catch {}
		}
		return turns;
	} catch {
		return [];
	}
}

/** Every saved binding in the session map, newest first. */
export function loadAllSavedSessions(mapPath: string): SavedSessionInfo[] {
	try {
		if (!existsSync(mapPath)) return [];
		const sessions = (JSON.parse(readFileSync(mapPath, "utf-8"))?.sessions ?? {}) as Record<string, unknown>;
		const results: SavedSessionInfo[] = [];
		for (const [opencodeSessionId, list] of Object.entries(sessions)) {
			if (!Array.isArray(list)) continue;
			for (const item of list) {
				if (item?.conversationId) {
					results.push({ conversationId: item.conversationId, opencodeSessionId, updatedAt: item.updatedAt, model: item.model });
				}
			}
		}
		const time = (s: SavedSessionInfo) => (s.updatedAt ? new Date(s.updatedAt).getTime() : 0);
		return results.sort((a, b) => time(b) - time(a));
	} catch {
		return [];
	}
}

/** Session ids present in the map (used to find a bound child session). */
export function savedSessionIds(mapPath: string): string[] {
	try {
		return Object.keys(JSON.parse(readFileSync(mapPath, "utf-8"))?.sessions ?? {});
	} catch {
		return [];
	}
}
