/**
 * opencode v2 TUI entry (@opencode/plugin/tui 2.2.5): `{ id, setup }`.
 * Same user-facing behavior as the v1 TUI (packages/opencode-adapter/src/tui.ts):
 * /agy-open (aliases agy:open, agy), palette entry, alt+a and ctrl+alt+a open
 * the agy session dialogs. Registration channels change:
 *   v1 api.command.register + api.keymap.registerLayer -> ctx.keymap.layer
 *   v1 api.ui.dialog.replace(DialogSelect callbacks)   -> await ctx.ui.dialog.select
 *   v1 api.ui.toast                                    -> ctx.ui.toast.show
 *   v1 api.route.current / api.state.session          -> ctx.ui.router / ctx.data.session
 * Each dialog is a loop that resolves to "back" or "close"; cancelling a
 * dialog counts as "back", like the v1 onCancel handlers. v2 select hides
 * disabled options, so the v1 informational rows (details, empty states) are
 * selectable here and selecting one just shows the same dialog again.
 */
import type { Plugin } from "@opencode/plugin/tui";
import { openInteractiveAgySession } from "agy-bridge-engine";
import { openSessionStore } from "../../opencode-adapter/src/session-store";
import { sessionMapPath } from "../../opencode-adapter/src/paths";
import {
	copyToClipboard,
	isSplitAvailable,
	launchSplit,
	loadAllSavedSessions,
	readRecentTranscript,
	savedSessionIds,
	truncate,
	type Env,
} from "./tui-helpers";

type Ctx = Plugin.Context;
type Nav = "back" | "close";
type Option = { title: string; value: string; description?: string; category?: string; disabled?: boolean };

/** TUI options (ctx.options): same state keys as the server plugin, plus test seams. */
export interface AgyTuiV2Options {
	stateDir?: string;
	env?: Env;
	openInteractiveSession?: typeof openInteractiveAgySession;
	copyToClipboard?: (text: string) => unknown;
}

interface Deps {
	ctx: Ctx;
	env: Env;
	mapPath: string;
	open: typeof openInteractiveAgySession;
	copy: (text: string) => unknown;
}

const BACK: Option = { title: "← Volver", value: "__back__", category: "Navegación" };
const CLOSE: Option = { title: "✕ Cerrar", value: "__close__", category: "Navegación" };

/** Run location: the session project's git root, else the session directory. */
export function resolveSessionWorktree(ctx: Ctx, sessionID: string): string {
	const session = sessionID ? ctx.data.session.get(sessionID) : undefined;
	const canonical = session ? ctx.data.project.get(session.projectID)?.canonical : undefined;
	if (canonical && canonical !== "/") return canonical;
	return session?.location?.directory || ctx.location?.directory || process.cwd();
}

async function select(d: Deps, title: string, options: Option[]): Promise<string | undefined> {
	return d.ctx.ui.dialog.select<string>({ title, options });
}

function toast(d: Deps, message: string, variant: "info" | "success" | "warning") {
	d.ctx.ui.toast.show({ title: "Agy Bridge", message, variant });
}

async function transcriptViewer(d: Deps, conversationId: string): Promise<Nav> {
	const title = `Historial Agy · ${truncate(conversationId, 24)}`;
	for (;;) {
		const turns = readRecentTranscript(conversationId, d.env);
		const options: Option[] =
			turns.length === 0
				? [
						{
							title: "Sin mensajes recientes",
							value: "__empty__",
							description: "No se encontraron mensajes en el transcript de esta conversación.",
						},
					]
				: turns.map((turn, idx) => {
						const snippet = turn.text.replace(/\s+/g, " ").trim();
						const label = turn.role === "user" ? "👤 [Usuario]" : "🤖 [Agy]";
						return {
							title: `${label} ${truncate(snippet, 45)}`,
							value: `turn_${idx}`,
							description: truncate(snippet, 90),
							category: "Mensajes Recientes",
						};
					});
		const choice = await select(d, title, [...options, BACK, CLOSE]);
		if (choice === undefined || choice === "__back__") return "back";
		if (choice === "__close__") return "close";
		const turn = turns[Number.parseInt(choice.replace("turn_", ""), 10)];
		if (turn) {
			await d.ctx.ui.dialog.alert({
				title: turn.role === "user" ? "👤 Mensaje de Usuario" : "🤖 Respuesta de Agy",
				message: turn.text.slice(0, 3000),
			});
		}
	}
}

async function sessionsList(d: Deps, currentSessionID: string, hasBack: boolean): Promise<Nav> {
	const title = "Agy Bridge · Sesiones Registradas";
	const nav = hasBack ? [BACK, CLOSE] : [CLOSE];
	for (;;) {
		const all = loadAllSavedSessions(d.mapPath);
		const options: Option[] =
			all.length === 0
				? [
						{
							title: "No hay sesiones guardadas aún",
							value: "__empty__",
							description: "Usa el modelo agy en OpenCode para conectar conversaciones.",
						},
					]
				: all.slice(0, 15).map((item, idx) => ({
						title: `${item.opencodeSessionId === currentSessionID ? "★ " : "💬 "}${truncate(item.conversationId, 32)}`,
						value: `session_${idx}`,
						description: `${item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "reciente"} · OpenCode: ${truncate(item.opencodeSessionId, 20)}`,
						category: "Conversaciones Guardadas",
					}));
		const choice = await select(d, title, [...options, ...nav]);
		if (choice === undefined || choice === "__back__") return hasBack ? "back" : "close";
		if (choice === "__close__") return "close";
		const selected = all[Number.parseInt(choice.replace("session_", ""), 10)];
		if (!selected) continue;
		const result = await sessionModal(d, { conversationId: selected.conversationId, model: selected.model }, currentSessionID, true);
		if (result === "close") return "close";
	}
}

async function noSessionModal(d: Deps, sessionID: string): Promise<Nav> {
	for (;;) {
		const choice = await select(d, "Agy Bridge · Sin Sesión Vinculada", [
			{
				title: "ℹ️ No hay conversación de agy vinculada a esta sesión",
				value: "__info__",
				description: "Envía un mensaje con el modelo agy para inicializar una conversación.",
				category: "Estado",
			},
			{
				title: "🔍 Explorar sesiones de agy guardadas",
				value: "list_sessions",
				description: "Ver conversaciones previas y abrirlas o vincularlas",
				category: "Acciones",
			},
			CLOSE,
		]);
		if (choice === "__info__") continue;
		if (choice !== "list_sessions") return "close";
		if ((await sessionsList(d, sessionID, true)) === "close") return "close";
	}
}

function openExternal(d: Deps, conversationId: string, worktree: string, fromSplit: boolean): boolean {
	const result = d.open({ conversationId, cwd: worktree });
	if (result.success) {
		const message = fromSplit
			? `Abierto en terminal (${result.method})`
			: result.method === "tmux-popup"
				? "Abierto en popup de tmux"
				: `Abierto en terminal (${result.terminal})`;
		toast(d, message, "info");
		return true;
	}
	toast(
		d,
		fromSplit
			? `No se pudo abrir split. Ejecuta: agy --conversation ${conversationId}`
			: `Ejecuta: agy --conversation ${conversationId}`,
		"warning",
	);
	return false;
}

async function sessionModal(
	d: Deps,
	entry: { conversationId: string; model?: string },
	sessionID: string,
	hasBack: boolean,
): Promise<Nav> {
	const { conversationId } = entry;
	const worktree = resolveSessionWorktree(d.ctx, sessionID);
	for (;;) {
		const choice = await select(d, "Agy Bridge · Sesión Conectada", [
			{
				title: `💬 Sesión: ${truncate(conversationId, 36)}`,
				value: "__info__",
				description: `Modelo: ${entry.model || "gemini-2.5-pro"} · Dir: ${truncate(worktree, 25)}`,
				category: "Detalles",
			},
			{
				title: isSplitAvailable(d.env) ? "⚡ Abrir en split de terminal (Herdr/Tmux)" : "⚡ Abrir en terminal split",
				value: "launch_split",
				description: "Abre agy en un panel interactivo al lado de OpenCode",
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
			{ title: "📋 Copiar comando CLI", value: "copy_cmd", description: `agy --conversation ${conversationId}`, category: "Portapapeles" },
			{ title: "📋 Copiar Conversation ID", value: "copy_id", description: conversationId, category: "Portapapeles" },
			{
				title: "🔄 Ver otras sesiones de agy guardadas...",
				value: "browse_sessions",
				description: "Explorar la lista completa de sesiones vinculadas",
				category: "Sesiones",
			},
			...(hasBack ? [BACK] : []),
			CLOSE,
		]);
		switch (choice) {
			case undefined:
			case "__back__":
				return hasBack ? "back" : "close";
			case "__close__":
				return "close";
			case "launch_split": {
				const split = launchSplit(conversationId, worktree, d.env);
				if (split.success) {
					toast(d, `Split de terminal abierto (${split.method})`, "success");
					return "close";
				}
				if (openExternal(d, conversationId, worktree, true)) return "close";
				break;
			}
			case "launch_external":
				if (openExternal(d, conversationId, worktree, false)) return "close";
				break;
			case "view_transcript":
				if ((await transcriptViewer(d, conversationId)) === "close") return "close";
				break;
			case "copy_cmd":
				d.copy(`agy --conversation ${conversationId}`);
				toast(d, "Comando copiado al portapapeles", "success");
				break;
			case "copy_id":
				d.copy(conversationId);
				toast(d, "Conversation ID copiado al portapapeles", "success");
				break;
			case "browse_sessions":
				if ((await sessionsList(d, sessionID, true)) === "close") return "close";
				break;
		}
	}
}

/** Binding for the session, its parent (subagent child), or a bound child. */
async function findEntry(d: Deps, sessionID: string) {
	const store = openSessionStore(d.mapPath);
	let entry = await store.getEntry(sessionID);
	if (!entry?.conversationId) {
		const parentID = d.ctx.data.session.get(sessionID)?.parentID;
		if (parentID) entry = await store.getEntry(parentID);
	}
	if (!entry?.conversationId) {
		for (const candidate of savedSessionIds(d.mapPath)) {
			if (d.ctx.data.session.get(candidate)?.parentID !== sessionID) continue;
			entry = await store.getEntry(candidate);
			if (entry?.conversationId) break;
		}
	}
	return entry?.conversationId ? entry : undefined;
}

async function handleOpen(d: Deps): Promise<void> {
	const route = d.ctx.ui.router.current();
	const sessionID = route.type === "session" ? route.sessionID : "";
	if (!sessionID) await sessionsList(d, "", false);
	else {
		const entry = await findEntry(d, sessionID);
		if (entry) await sessionModal(d, entry, sessionID, false);
		else await noSessionModal(d, sessionID);
	}
	d.ctx.ui.dialog.clear();
}

const OPEN_DESCRIPTION = "Open active agy conversation in modal window";

const setup: Plugin.Definition["setup"] = (ctx) => {
	const opts = (ctx.options ?? {}) as AgyTuiV2Options;
	const env = opts.env ?? process.env;
	const deps: Deps = {
		ctx,
		env,
		mapPath: sessionMapPath({ override: opts.stateDir, env }),
		open: opts.openInteractiveSession ?? openInteractiveAgySession,
		copy: opts.copyToClipboard ?? copyToClipboard,
	};
	const run = () => handleOpen(deps).catch(() => {});
	ctx.keymap.layer(() => ({
		mode: "global",
		priority: 100,
		commands: [
			{
				id: "agy.open",
				title: "Open Agy Session",
				description: OPEN_DESCRIPTION,
				group: "Agy",
				palette: true,
				slash: { name: "agy-open", aliases: ["agy:open", "agy"] },
				bind: "alt+a",
				run,
			},
			{ id: "agy.open.alt", title: "Open Agy Session", description: OPEN_DESCRIPTION, group: "Agy", bind: "ctrl+alt+a", run },
		],
		bindings: ["agy.open", "agy.open.alt"],
	}));
};

/** The agy-bridge opencode v2 TUI plugin definition. */
export const agyTuiV2: Plugin.Definition = { id: "agy-bridge-tui", setup };

export default agyTuiV2;
