import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync, spawn } from "node:child_process";
import { createComponent } from "@opentui/solid";
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/dist/tui.js";
import {
	openInteractiveAgySession,
	isExecutableInPath,
	isWsl,
} from "agy-bridge-engine";
import { openSessionStore } from "./session-store";
import { sessionMapPath } from "./paths";

interface TranscriptTurn {
	role: "user" | "assistant" | "tool";
	text: string;
	time?: string;
}

interface SavedSessionInfo {
	conversationId: string;
	opencodeSessionId: string;
	updatedAt?: string;
	model?: string;
}

function truncate(str: string, max: number): string {
	if (!str) return "";
	return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

function renderComponent<P extends object>(
	comp: ((props: P) => unknown) | undefined,
	props: P,
): unknown {
	if (typeof comp !== "function") {
		return { ...(props as any) };
	}
	try {
		return createComponent(comp as any, props as any);
	} catch {
		return (comp as any)(props);
	}
}

function copyToClipboard(text: string): boolean {
	try {
		// 1. OSC 52 sequence to standard output
		if (process.stdout?.isTTY) {
			const b64 = Buffer.from(text).toString("base64");
			process.stdout.write(`\x1b]52;c;${b64}\x07`);
		}

		// 2. Windows clip.exe (in WSL)
		const clipBin = isExecutableInPath("clip.exe")
			? "clip.exe"
			: isExecutableInPath("/mnt/c/WINDOWS/system32/clip.exe")
				? "/mnt/c/WINDOWS/system32/clip.exe"
				: null;
		if (clipBin) {
			const proc = spawn(clipBin, [], { stdio: ["pipe", "ignore", "ignore"] });
			proc.stdin.write(text);
			proc.stdin.end();
			return true;
		}

		// 3. Linux wl-copy / xclip
		if (isExecutableInPath("wl-copy")) {
			const proc = spawn("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
			proc.stdin.write(text);
			proc.stdin.end();
			return true;
		}
		if (isExecutableInPath("xclip")) {
			const proc = spawn("xclip", ["-selection", "clipboard"], {
				stdio: ["pipe", "ignore", "ignore"],
			});
			proc.stdin.write(text);
			proc.stdin.end();
			return true;
		}

		return true;
	} catch {
		return false;
	}
}

function launchSplit(
	conversationId: string,
	cwd?: string,
): { success: boolean; method: string } {
	// 1. Herdr workspace manager
	if (process.env.HERDR_ENV === "1" && isExecutableInPath("herdr")) {
		try {
			const cwdArg = cwd ? ` --cwd "${cwd}"` : "";
			const out = execSync(
				`herdr pane split --current --direction right --focus${cwdArg}`,
				{
					encoding: "utf-8",
					env: process.env,
				},
			);
			let newPaneId = "";
			try {
				const parsed = JSON.parse(out);
				newPaneId =
					parsed?.result?.pane?.pane_id || parsed?.result?.pane_id || "";
			} catch {}
			if (newPaneId) {
				execSync(
					`herdr pane run ${newPaneId} "agy --conversation ${conversationId}"`,
					{
						env: process.env,
					},
				);
				return { success: true, method: "herdr-split" };
			}
		} catch {
			// fall through
		}
	}

	// 2. Tmux
	if (process.env.TMUX && isExecutableInPath("tmux")) {
		try {
			const cwdArg = cwd ? `-c "${cwd}" ` : "";
			execSync(
				`tmux split-window -h ${cwdArg}"agy --conversation ${conversationId}"`,
				{
					env: process.env,
				},
			);
			return { success: true, method: "tmux-split" };
		} catch {
			// fall through
		}
	}

	return { success: false, method: "none" };
}

function readRecentTranscript(
	conversationId: string,
	maxTurns = 8,
): TranscriptTurn[] {
	const home = process.env.HOME || "/home/bruno";
	const transcriptPath = join(
		home,
		".gemini/antigravity-cli/brain",
		conversationId,
		".system_generated/logs/transcript.jsonl",
	);

	if (!existsSync(transcriptPath)) return [];

	try {
		const content = readFileSync(transcriptPath, "utf-8");
		const lines = content.trim().split("\n");
		const turns: TranscriptTurn[] = [];

		for (let i = lines.length - 1; i >= 0 && turns.length < maxTurns; i--) {
			try {
				const item = JSON.parse(lines[i]);
				if (item.type === "USER_INPUT" && item.content) {
					let text = String(item.content);
					const match = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
					if (match) text = match[1].trim();
					turns.unshift({
						role: "user",
						text,
						time: item.created_at,
					});
				} else if (item.type === "PLANNER_RESPONSE") {
					const text = String(item.content || item.thinking || "").trim();
					if (text) {
						turns.unshift({
							role: "assistant",
							text,
							time: item.created_at,
						});
					}
				}
			} catch {}
		}

		return turns;
	} catch {
		return [];
	}
}

function loadAllSavedSessions(): SavedSessionInfo[] {
	try {
		const mapPath = sessionMapPath();
		if (!existsSync(mapPath)) return [];
		const raw = readFileSync(mapPath, "utf-8");
		const parsed = JSON.parse(raw);
		const sessions = (parsed?.sessions ?? {}) as Record<string, any[]>;
		const results: SavedSessionInfo[] = [];

		for (const [opencodeId, list] of Object.entries(sessions)) {
			if (!Array.isArray(list)) continue;
			for (const item of list) {
				if (item?.conversationId) {
					results.push({
						conversationId: item.conversationId,
						opencodeSessionId: opencodeId,
						updatedAt: item.updatedAt,
						model: item.model,
					});
				}
			}
		}

		results.sort((a, b) => {
			const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
			const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
			return timeB - timeA;
		});

		return results;
	} catch {
		return [];
	}
}

function showTranscriptViewer(
	api: TuiPluginApi,
	conversationId: string,
	onBack: () => void,
) {
	const turns = readRecentTranscript(conversationId);

	if (turns.length === 0) {
		api.ui.dialog.replace(() =>
			renderComponent(api.ui.DialogSelect, {
				title: `Historial Agy · ${truncate(conversationId, 24)}`,
				options: [
					{
						title: "Sin mensajes recientes",
						value: "__empty__",
						description:
							"No se encontraron mensajes en el transcript de esta conversación.",
						disabled: true,
					},
					{
						title: "← Volver",
						value: "__back__",
						category: "Navegación",
					},
					{
						title: "✕ Cerrar",
						value: "__close__",
						category: "Navegación",
					},
				],
				onSelect: (opt) => {
					if (opt.value === "__back__") onBack();
					else api.ui.dialog.clear();
				},
				onCancel: onBack,
			}),
		);
		return;
	}

	const options = turns.map((turn, idx) => {
		const icon = turn.role === "user" ? "👤" : "🤖";
		const roleName = turn.role === "user" ? "Usuario" : "Agy";
		const snippet = turn.text.replace(/\s+/g, " ").trim();
		return {
			title: `${icon} [${roleName}] ${truncate(snippet, 45)}`,
			value: `turn_${idx}`,
			description: truncate(snippet, 90),
			category: "Mensajes Recientes",
		};
	});

	options.push({
		title: "← Volver",
		value: "__back__",
		category: "Navegación",
	} as any);
	options.push({
		title: "✕ Cerrar",
		value: "__close__",
		category: "Navegación",
	} as any);

	api.ui.dialog.replace(() =>
		renderComponent(api.ui.DialogSelect, {
			title: `Historial Agy · ${truncate(conversationId, 24)}`,
			options,
			onSelect: (opt) => {
				if (opt.value === "__back__") {
					onBack();
					return;
				}
				if (opt.value === "__close__") {
					api.ui.dialog.clear();
					return;
				}

				const turnIdx = Number.parseInt(
					String(opt.value).replace("turn_", ""),
					10,
				);
				const turn = turns[turnIdx];
				if (turn) {
					api.ui.dialog.replace(() =>
						renderComponent(api.ui.DialogAlert, {
							title: `${turn.role === "user" ? "👤 Mensaje de Usuario" : "🤖 Respuesta de Agy"}`,
							message: turn.text.slice(0, 3000),
							onConfirm: () =>
								showTranscriptViewer(api, conversationId, onBack),
						}),
					);
				}
			},
			onCancel: onBack,
		}),
	);
}

function showSessionsListModal(
	api: TuiPluginApi,
	currentSessionID: string,
	onBack?: () => void,
) {
	const allSessions = loadAllSavedSessions();

	if (allSessions.length === 0) {
		api.ui.dialog.replace(() =>
			renderComponent(api.ui.DialogSelect, {
				title: "Agy Bridge · Sesiones Registradas",
				options: [
					{
						title: "No hay sesiones guardadas aún",
						value: "__empty__",
						description:
							"Usa el modelo agy en OpenCode para conectar conversaciones.",
						disabled: true,
					},
					...(onBack
						? [
								{
									title: "← Volver",
									value: "__back__",
									category: "Navegación",
								},
							]
						: []),
					{
						title: "✕ Cerrar",
						value: "__close__",
						category: "Navegación",
					},
				],
				onSelect: (opt) => {
					if (opt.value === "__back__" && onBack) onBack();
					else api.ui.dialog.clear();
				},
				onCancel: () => {
					if (onBack) onBack();
					else api.ui.dialog.clear();
				},
			}),
		);
		return;
	}

	const options = allSessions.slice(0, 15).map((item, idx) => {
		const isCurrent = item.opencodeSessionId === currentSessionID;
		const marker = isCurrent ? "★ " : "💬 ";
		const dateStr = item.updatedAt
			? new Date(item.updatedAt).toLocaleString()
			: "reciente";
		return {
			title: `${marker}${truncate(item.conversationId, 32)}`,
			value: `session_${idx}`,
			description: `${dateStr} · OpenCode: ${truncate(item.opencodeSessionId, 20)}`,
			category: "Conversaciones Guardadas",
		};
	});

	if (onBack) {
		options.push({
			title: "← Volver",
			value: "__back__",
			category: "Navegación",
		} as any);
	}
	options.push({
		title: "✕ Cerrar",
		value: "__close__",
		category: "Navegación",
	} as any);

	api.ui.dialog.replace(() =>
		renderComponent(api.ui.DialogSelect, {
			title: "Agy Bridge · Sesiones Registradas",
			options,
			onSelect: (opt) => {
				if (opt.value === "__back__" && onBack) {
					onBack();
					return;
				}
				if (opt.value === "__close__") {
					api.ui.dialog.clear();
					return;
				}

				const sIdx = Number.parseInt(
					String(opt.value).replace("session_", ""),
					10,
				);
				const selected = allSessions[sIdx];
				if (!selected) return;

				showSessionModal(
					api,
					{
						conversationId: selected.conversationId,
						model: selected.model,
					},
					currentSessionID,
					() => showSessionsListModal(api, currentSessionID, onBack),
				);
			},
			onCancel: () => {
				if (onBack) onBack();
				else api.ui.dialog.clear();
			},
		}),
	);
}

function showNoSessionModal(api: TuiPluginApi, sessionID: string) {
	api.ui.dialog.replace(() =>
		renderComponent(api.ui.DialogSelect, {
			title: "Agy Bridge · Sin Sesión Vinculada",
			options: [
				{
					title: "ℹ️ No hay conversación de agy vinculada a esta sesión",
					value: "__info__",
					description:
						"Envía un mensaje con el modelo agy para inicializar una conversación.",
					disabled: true,
					category: "Estado",
				},
				{
					title: "🔍 Explorar sesiones de agy guardadas",
					value: "list_sessions",
					description: "Ver conversaciones previas y abrirlas o vincularlas",
					category: "Acciones",
				},
				{
					title: "✕ Cerrar",
					value: "__close__",
					category: "Navegación",
				},
			],
			onSelect: (opt) => {
				if (opt.value === "list_sessions") {
					showSessionsListModal(api, sessionID, () =>
						showNoSessionModal(api, sessionID),
					);
				} else {
					api.ui.dialog.clear();
				}
			},
			onCancel: () => api.ui.dialog.clear(),
		}),
	);
}

function showSessionModal(
	api: TuiPluginApi,
	entry: { conversationId: string; model?: string; turnCount?: number },
	sessionID: string,
	onBack?: () => void,
) {
	const { conversationId } = entry;
	const worktree =
		api.state?.path?.worktree || api.state?.path?.directory || process.cwd();

	const isSplitAvailable =
		Boolean(process.env.HERDR_ENV === "1" && isExecutableInPath("herdr")) ||
		Boolean(process.env.TMUX && isExecutableInPath("tmux"));

	const options = [
		{
			title: `💬 Sesión: ${truncate(conversationId, 36)}`,
			value: "__info__",
			description: `Modelo: ${entry.model || "gemini-2.5-pro"} · Dir: ${truncate(worktree, 25)}`,
			disabled: true,
			category: "Detalles",
		},
		{
			title: isSplitAvailable
				? "⚡ Abrir en split de terminal (Herdr/Tmux)"
				: "⚡ Abrir en terminal split",
			value: "launch_split",
			description:
				"Abre agy en un panel interactivo al lado de OpenCode",
			category: "Ejecución Interactiva",
		},
		{
			title: "🪟 Abrir en ventana de terminal externa",
			value: "launch_external",
			description: "Lanza agy en una nueva ventana de terminal independiente",
			category: "Ejecución Interactiva",
		},
		{
			title: "📜 Ver mensajes recientes de la conversación",
			value: "view_transcript",
			description: "Ver el historial reciente de prompts y respuestas en OpenCode",
			category: "Inspección",
		},
		{
			title: "📋 Copiar comando CLI",
			value: "copy_cmd",
			description: `agy --conversation ${conversationId}`,
			category: "Portapapeles",
		},
		{
			title: "📋 Copiar Conversation ID",
			value: "copy_id",
			description: conversationId,
			category: "Portapapeles",
		},
		{
			title: "🔄 Ver otras sesiones de agy guardadas...",
			value: "browse_sessions",
			description: "Explorar la lista completa de sesiones vinculadas",
			category: "Sesiones",
		},
		...(onBack
			? [
					{
						title: "← Volver",
						value: "__back__",
						category: "Navegación",
					},
				]
			: []),
		{
			title: "✕ Cerrar",
			value: "__close__",
			category: "Navegación",
		},
	];

	api.ui.dialog.replace(() =>
		renderComponent(api.ui.DialogSelect, {
			title: `Agy Bridge · Sesión Conectada`,
			options,
			onSelect: (opt) => {
				if (opt.value === "__back__" && onBack) {
					onBack();
					return;
				}
				if (opt.value === "__close__") {
					api.ui.dialog.clear();
					return;
				}

				if (opt.value === "launch_split") {
					const splitRes = launchSplit(conversationId, worktree);
					if (splitRes.success) {
						api.ui.toast({
							title: "Agy Bridge",
							message: `Split de terminal abierto (${splitRes.method})`,
							variant: "success",
						});
						api.ui.dialog.clear();
					} else {
						// Fallback to external terminal
						const extRes = openInteractiveAgySession({
							conversationId,
							cwd: worktree,
						});
						if (extRes.success) {
							api.ui.toast({
								title: "Agy Bridge",
								message: `Abierto en terminal (${extRes.method})`,
								variant: "info",
							});
							api.ui.dialog.clear();
						} else {
							api.ui.toast({
								title: "Agy Bridge",
								message: `No se pudo abrir split. Ejecuta: agy --conversation ${conversationId}`,
								variant: "warning",
							});
						}
					}
					return;
				}

				if (opt.value === "launch_external") {
					const extRes = openInteractiveAgySession({
						conversationId,
						cwd: worktree,
					});
					if (extRes.success) {
						api.ui.toast({
							title: "Agy Bridge",
							message:
								extRes.method === "tmux-popup"
									? "Abierto en popup de tmux"
									: `Abierto en terminal (${extRes.terminal})`,
							variant: "info",
						});
						api.ui.dialog.clear();
					} else {
						api.ui.toast({
							title: "Agy Bridge",
							message: `Ejecuta: agy --conversation ${conversationId}`,
							variant: "warning",
						});
					}
					return;
				}

				if (opt.value === "view_transcript") {
					showTranscriptViewer(api, conversationId, () =>
						showSessionModal(api, entry, sessionID, onBack),
					);
					return;
				}

				if (opt.value === "copy_cmd") {
					const cmd = `agy --conversation ${conversationId}`;
					copyToClipboard(cmd);
					api.ui.toast({
						title: "Agy Bridge",
						message: "Comando copiado al portapapeles",
						variant: "success",
					});
					return;
				}

				if (opt.value === "copy_id") {
					copyToClipboard(conversationId);
					api.ui.toast({
						title: "Agy Bridge",
						message: "Conversation ID copiado al portapapeles",
						variant: "success",
					});
					return;
				}

				if (opt.value === "browse_sessions") {
					showSessionsListModal(api, sessionID, () =>
						showSessionModal(api, entry, sessionID, onBack),
					);
					return;
				}
			},
			onCancel: () => {
				if (onBack) onBack();
				else api.ui.dialog.clear();
			},
		}),
	);
}

export const tui: TuiPlugin = async (api) => {
	const handleOpen = async () => {
		const route = api.route.current;
		const sessionID =
			route.name === "session"
				? (route.params as Record<string, unknown> | undefined)?.sessionID
				: undefined;

		if (typeof sessionID !== "string" || !sessionID) {
			if (api.ui?.dialog?.replace) {
				showSessionsListModal(api, "");
			} else {
				api.ui?.toast?.({
					title: "Agy Bridge",
					message: "No hay una sesión activa seleccionada en OpenCode",
					variant: "warning",
				});
			}
			return;
		}

		const store = openSessionStore(sessionMapPath());
		let entry = await store.getEntry(sessionID);

		// Fallback 1: check parent if child subagent
		if (!entry?.conversationId) {
			const currentSession = (
				api.state?.session as
					| { get?: (id: string) => { parentID?: string } }
					| undefined
			)?.get?.(sessionID);
			if (currentSession?.parentID) {
				entry = await store.getEntry(currentSession.parentID);
			}
		}

		// Fallback 2: check child sessions if parent
		if (!entry?.conversationId) {
			try {
				const mapPath = sessionMapPath();
				const raw = readFileSync(mapPath, "utf-8");
				const parsed = JSON.parse(raw);
				const sessions = (parsed?.sessions ?? {}) as Record<string, unknown[]>;
				const sessionGetter = api.state?.session as
					| { get?: (id: string) => { parentID?: string } }
					| undefined;
				for (const candidateId of Object.keys(sessions)) {
					const candidate = sessionGetter?.get?.(candidateId);
					if (candidate?.parentID === sessionID) {
						entry = await store.getEntry(candidateId);
						if (entry?.conversationId) break;
					}
				}
			} catch {
				// non-critical
			}
		}

		if (!entry?.conversationId) {
			if (api.ui?.dialog?.replace) {
				showNoSessionModal(api, sessionID);
			} else {
				api.ui?.toast?.({
					title: "Agy Bridge",
					message:
						"No hay una conversación de agy vinculada a esta sesión aún",
					variant: "warning",
				});
			}
			return;
		}

		// Raise modal dialog window directly over OpenCode!
		if (api.ui?.dialog?.replace) {
			showSessionModal(api, entry, sessionID);
		} else {
			// Headless fallback
			const worktree =
				api.state?.path?.worktree || api.state?.path?.directory || process.cwd();
			openInteractiveAgySession({
				conversationId: entry.conversationId,
				cwd: worktree,
			});
		}
	};

	// 1. Slash command & command palette: /agy-open
	if (api.command?.register) {
		const disposeCommand = api.command.register(() => [
			{
				title: "Open Agy Session",
				value: "agy-open",
				description: "Open active agy conversation in modal window",
				category: "Agy",
				slash: {
					name: "agy-open",
					aliases: ["agy:open", "agy"],
				},
				onSelect: () => {
					void handleOpen();
				},
			},
		]);
		api.lifecycle?.onDispose?.(disposeCommand);
	}

	// 2. Keyboard shortcuts: alt+a and ctrl+alt+a
	if (api.keymap?.registerLayer) {
		const disposeLayer = api.keymap.registerLayer({
			priority: 100,
			commands: [
				{
					name: ":agy-open",
					title: "Open Agy Session",
					desc: "Open active agy conversation in modal window",
					category: "Agy",
					nargs: "0",
					run: () => {
						void handleOpen();
						return true;
					},
				},
				{
					name: ":agy",
					title: "Open Agy Session",
					desc: "Open active agy conversation in modal window",
					category: "Agy",
					nargs: "0",
					run: () => {
						void handleOpen();
						return true;
					},
				},
			],
			bindings: [
				{ key: "alt+a", cmd: ":agy-open" },
				{ key: "ctrl+alt+a", cmd: ":agy-open" },
			],
		});
		api.lifecycle?.onDispose?.(disposeLayer);
	}
};

const plugin = {
	id: "agy-bridge-tui",
	tui,
};

export default plugin;
