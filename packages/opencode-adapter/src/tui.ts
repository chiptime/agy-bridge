import type { TuiPlugin } from "@opencode-ai/plugin/dist/tui.js";
import { openInteractiveAgySession } from "agy-bridge-engine";
import { openSessionStore } from "./session-store";
import { sessionMapPath } from "./paths";

export const tui: TuiPlugin = async (api) => {
	const handleOpen = async () => {
		const route = api.route.current;
		const sessionID =
			route.name === "session"
				? (route.params as Record<string, unknown> | undefined)?.sessionID
				: undefined;

		if (typeof sessionID !== "string" || !sessionID) {
			api.ui.toast({
				title: "Agy Bridge",
				message: "No active session selected in OpenCode",
				variant: "warning",
			});
			return;
		}

		const store = openSessionStore(sessionMapPath());
		const entry = await store.getEntry(sessionID);
		if (!entry?.conversationId) {
			api.ui.toast({
				title: "Agy Bridge",
				message: "No active agy conversation bound for this session yet",
				variant: "warning",
			});
			return;
		}

		const worktree = api.state.path.worktree || api.state.path.directory || process.cwd();
		const result = openInteractiveAgySession({
			conversationId: entry.conversationId,
			cwd: worktree,
		});

		if (result.success) {
			api.ui.toast({
				title: "Agy Bridge",
				message:
					result.method === "tmux-popup"
						? `Opened agy in tmux popup`
						: `Opened agy in terminal (${result.terminal})`,
				variant: "info",
			});
		} else {
			api.ui.toast({
				title: "Agy Bridge",
				message: `Could not launch terminal automatically: run "agy --conversation ${entry.conversationId}"`,
				variant: "warning",
			});
		}
	};

	// 1. Slash command & command palette: /agy-open
	if (api.command?.register) {
		const disposeCommand = api.command.register(() => [
			{
				title: "Open Agy Session",
				value: "agy-open",
				description: "Open active agy conversation in interactive popup",
				category: "Agy",
				slash: {
					name: "agy-open",
					aliases: ["agy:open"],
				},
				onSelect: () => {
					void handleOpen();
				},
			},
		]);
		api.lifecycle?.onDispose?.(disposeCommand);
	}

	// 2. Keyboard shortcut: alt+a
	if (api.keymap?.registerLayer) {
		const disposeLayer = api.keymap.registerLayer({
			priority: 100,
			commands: [
				{
					name: ":agy-open",
					title: "Open Agy Session",
					desc: "Open active agy conversation in popup",
					category: "Agy",
					nargs: "0",
					run: () => {
						void handleOpen();
						return true;
					},
				},
			],
			bindings: [{ key: "alt+a", cmd: ":agy-open" }],
		});
		api.lifecycle?.onDispose?.(disposeLayer);
	}
};
Object.assign(tui, {
	id: "agy-bridge-tui",
	tui,
});

export default tui;
