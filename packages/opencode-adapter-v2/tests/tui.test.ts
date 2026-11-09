/**
 * Unit tests for the opencode v2 TUI entry (@opencode/plugin/tui 2.2.5):
 * `export default { id, setup }` where setup registers a keymap layer and the
 * session dialogs use the promise-based ctx.ui.dialog.select/alert API.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tuiModule, { resolveSessionWorktree } from "../src/tui";


/** Temporary dirs created by this file; removed after the run. */
const scratchDirs: string[] = [];
async function scratch(prefix: string): Promise<string> {
	const dir = await mkdtemp(prefix);
	scratchDirs.push(dir);
	return dir;
}
afterAll(async () => {
	await Promise.all(scratchDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

type Answer = string | undefined | ((options: any) => string | undefined);

function mockCtx(opts: {
	route?: unknown;
	answers?: Answer[];
	sessions?: Record<string, { parentID?: string; projectID?: string; location?: { directory: string } }>;
	projects?: Record<string, { canonical: string }>;
	options?: Record<string, unknown>;
}) {
	const layers: any[] = [];
	const selects: any[] = [];
	const alerts: any[] = [];
	const toasts: any[] = [];
	let clears = 0;
	const answers = [...(opts.answers ?? [])];
	const ctx = {
		options: opts.options ?? {},
		location: { directory: "/fallback" },
		keymap: { layer: (factory: () => unknown) => layers.push(factory()) },
		data: {
			session: { get: (id: string) => opts.sessions?.[id] },
			project: { get: (id: string) => opts.projects?.[id] },
		},
		ui: {
			router: { current: () => opts.route ?? { type: "home" } },
			toast: { show: (t: unknown) => toasts.push(t) },
			dialog: {
				select: async (o: any) => {
					selects.push(o);
					const next = answers.shift();
					return typeof next === "function" ? next(o) : next;
				},
				alert: async (o: unknown) => {
					alerts.push(o);
				},
				clear: () => {
					clears++;
				},
			},
		},
	};
	return { ctx, layers, selects, alerts, toasts, clears: () => clears };
}

async function stateWith(sessions: Record<string, unknown[]>) {
	const stateDir = await scratch(join(tmpdir(), "agy-tui-v2-"));
	await mkdir(join(stateDir, "agy-bridge"), { recursive: true });
	// The session store prunes bindings without a recent updatedAt (TTL).
	const now = new Date().toISOString();
	const fresh = Object.fromEntries(
		Object.entries(sessions).map(([id, list]) => [id, list.map((e: any) => ({ updatedAt: now, ...e }))]),
	);
	await writeFile(join(stateDir, "agy-bridge", "opencode-sessions.json"), JSON.stringify({ version: 2, sessions: fresh }));
	return stateDir;
}

async function setup(c: ReturnType<typeof mockCtx>) {
	await tuiModule.setup(c.ctx as never);
	const command = c.layers[0].commands.find((cmd: any) => cmd.id === "agy.open");
	return { run: () => command.run() as Promise<void> };
}

describe("v2 TUI module shape and registration", () => {
	test("default export is { id, setup }", () => {
		expect(tuiModule.id).toBe("agy-bridge-tui");
		expect(typeof tuiModule.setup).toBe("function");
	});

	test("registers palette, slash and both v1 shortcuts", async () => {
		const c = mockCtx({});
		await tuiModule.setup(c.ctx as never);
		expect(c.layers).toHaveLength(1);
		const [open, alt] = c.layers[0].commands;
		expect(open).toMatchObject({
			id: "agy.open",
			title: "Open Agy Session",
			group: "Agy",
			palette: true,
			slash: { name: "agy-open", aliases: ["agy:open", "agy"] },
			bind: "alt+a",
		});
		expect(alt).toMatchObject({ id: "agy.open.alt", bind: "ctrl+alt+a" });
		// Without mode "global" opencode 2.2.5 lists neither the palette entry
		// nor the slash command (observed in the live TUI).
		expect(c.layers[0].mode).toBe("global");
		expect(c.layers[0].bindings).toEqual(["agy.open", "agy.open.alt"]);
	});
});

describe("open flow", () => {
	test("bound session shows the connected-session dialog and opens externally", async () => {
		const stateDir = await stateWith({ ses_1: [{ conversationId: "conv-1", updatedAt: "2026-11-05T10:00:00Z" }] });
		const opened: any[] = [];
		const c = mockCtx({
			route: { type: "session", sessionID: "ses_1" },
			sessions: { ses_1: { projectID: "prj", location: { directory: "/repo/sub" } } },
			projects: { prj: { canonical: "/repo" } },
			answers: ["launch_external"],
			options: {
				stateDir,
				env: {},
				openInteractiveSession: (input: unknown) => {
					opened.push(input);
					return { success: true, method: "tmux-popup" };
				},
			},
		});
		await (await setup(c)).run();
		expect(c.selects[0].title).toBe("Agy Bridge · Sesión Conectada");
		expect(c.selects[0].options.map((o: any) => o.value)).toEqual([
			"__info__",
			"launch_split",
			"launch_external",
			"view_transcript",
			"copy_cmd",
			"copy_id",
			"browse_sessions",
			"__close__",
		]);
		expect(opened[0]).toMatchObject({ conversationId: "conv-1", cwd: "/repo" });
		expect(c.toasts[0]).toMatchObject({ message: "Abierto en popup de tmux", variant: "info" });
		expect(c.clears()).toBe(1);
	});

	test("informational rows stay visible and selecting one re-shows the dialog", async () => {
		// v2 select hides disabled options, so info rows must be enabled.
		const stateDir = await stateWith({});
		const c = mockCtx({ route: { type: "session", sessionID: "ses_x" }, answers: ["__info__", undefined], options: { stateDir } });
		await (await setup(c)).run();
		expect(c.selects).toHaveLength(2);
		expect(c.selects[0].options[0]).toMatchObject({ value: "__info__", description: "Envía un mensaje con el modelo agy para inicializar una conversación." });
		expect(c.selects[0].options.some((o: any) => o.disabled)).toBe(false);
	});

	test("unbound session shows the no-session dialog; cancel closes", async () => {
		const stateDir = await stateWith({});
		const c = mockCtx({ route: { type: "session", sessionID: "ses_x" }, answers: [undefined], options: { stateDir } });
		await (await setup(c)).run();
		expect(c.selects).toHaveLength(1);
		expect(c.selects[0].title).toBe("Agy Bridge · Sin Sesión Vinculada");
	});

	test("child session falls back to the parent's binding", async () => {
		const stateDir = await stateWith({ ses_parent: [{ conversationId: "conv-p" }] });
		const c = mockCtx({
			route: { type: "session", sessionID: "ses_child" },
			sessions: { ses_child: { parentID: "ses_parent" } },
			answers: [undefined],
			options: { stateDir },
		});
		await (await setup(c)).run();
		expect(c.selects[0].title).toBe("Agy Bridge · Sesión Conectada");
		expect(c.selects[0].options[0].title).toContain("conv-p");
	});

	test("parent session falls back to a bound child", async () => {
		const stateDir = await stateWith({ ses_child: [{ conversationId: "conv-c" }] });
		const c = mockCtx({
			route: { type: "session", sessionID: "ses_parent" },
			sessions: { ses_child: { parentID: "ses_parent" } },
			answers: [undefined],
			options: { stateDir },
		});
		await (await setup(c)).run();
		expect(c.selects[0].options[0].title).toContain("conv-c");
	});

	test("home route lists saved sessions newest first and drills into one", async () => {
		const stateDir = await stateWith({
			ses_a: [{ conversationId: "conv-old", updatedAt: "2026-01-01T00:00:00Z" }],
			ses_b: [{ conversationId: "conv-new", updatedAt: "2026-11-01T00:00:00Z" }],
		});
		const c = mockCtx({ answers: ["session_0", "__close__"], options: { stateDir } });
		await (await setup(c)).run();
		expect(c.selects[0].title).toBe("Agy Bridge · Sesiones Registradas");
		expect(c.selects[0].options[0].title).toContain("conv-new");
		expect(c.selects[1].title).toBe("Agy Bridge · Sesión Conectada");
		expect(c.selects[1].options.map((o: any) => o.value)).toContain("__back__");
	});

	test("back from a drilled-in session returns to the list", async () => {
		const stateDir = await stateWith({ ses_a: [{ conversationId: "conv-a" }] });
		const c = mockCtx({ answers: ["session_0", "__back__", "__close__"], options: { stateDir } });
		await (await setup(c)).run();
		expect(c.selects.map((s) => s.title)).toEqual([
			"Agy Bridge · Sesiones Registradas",
			"Agy Bridge · Sesión Conectada",
			"Agy Bridge · Sesiones Registradas",
		]);
	});

	test("copy actions toast and keep the dialog open", async () => {
		const stateDir = await stateWith({ ses_1: [{ conversationId: "conv-1" }] });
		const copied: string[] = [];
		const c = mockCtx({
			route: { type: "session", sessionID: "ses_1" },
			answers: ["copy_cmd", "copy_id", "__close__"],
			options: { stateDir, copyToClipboard: (text: string) => copied.push(text) },
		});
		await (await setup(c)).run();
		expect(copied).toEqual(["agy --conversation conv-1", "conv-1"]);
		expect(c.toasts.map((t) => t.message)).toEqual([
			"Comando copiado al portapapeles",
			"Conversation ID copiado al portapapeles",
		]);
		expect(c.selects).toHaveLength(3);
	});

	test("split with no herdr/tmux falls back to an external terminal", async () => {
		const stateDir = await stateWith({ ses_1: [{ conversationId: "conv-1" }] });
		const c = mockCtx({
			route: { type: "session", sessionID: "ses_1" },
			answers: ["launch_split"],
			options: {
				stateDir,
				env: {},
				openInteractiveSession: () => ({ success: true, method: "terminal", terminal: "wt" }),
			},
		});
		await (await setup(c)).run();
		expect(c.toasts[0]).toMatchObject({ message: "Abierto en terminal (terminal)", variant: "info" });
	});

	test("failed launch warns with the manual command and stays open", async () => {
		const stateDir = await stateWith({ ses_1: [{ conversationId: "conv-1" }] });
		const c = mockCtx({
			route: { type: "session", sessionID: "ses_1" },
			answers: ["launch_external", "__close__"],
			options: { stateDir, env: {}, openInteractiveSession: () => ({ success: false, reason: "x", command: "agy" }) },
		});
		await (await setup(c)).run();
		expect(c.toasts[0]).toMatchObject({ message: "Ejecuta: agy --conversation conv-1", variant: "warning" });
		expect(c.selects).toHaveLength(2);
	});

	test("transcript viewer shows turns and an alert for the selected one", async () => {
		const stateDir = await stateWith({ ses_1: [{ conversationId: "conv-1" }] });
		const home = await scratch(join(tmpdir(), "agy-tui-v2-home-"));
		const dir = join(home, ".gemini/antigravity-cli/brain/conv-1/.system_generated/logs");
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "transcript.jsonl"),
			[
				JSON.stringify({ type: "USER_INPUT", content: "<USER_REQUEST>hola</USER_REQUEST>" }),
				JSON.stringify({ type: "PLANNER_RESPONSE", content: "respuesta" }),
			].join("\n"),
		);
		const c = mockCtx({
			route: { type: "session", sessionID: "ses_1" },
			answers: ["view_transcript", "turn_1", "__close__"],
			options: { stateDir, env: { HOME: home } },
		});
		await (await setup(c)).run();
		expect(c.selects[1].title).toBe("Historial Agy · conv-1");
		expect(c.selects[1].options.slice(0, 2).map((o: any) => o.description)).toEqual(["hola", "respuesta"]);
		expect(c.alerts[0]).toEqual({ title: "🤖 Respuesta de Agy", message: "respuesta" });
	});
});

describe("resolveSessionWorktree", () => {
	test("project canonical root for a git project", () => {
		const c = mockCtx({ sessions: { s: { projectID: "p", location: { directory: "/r/sub" } } }, projects: { p: { canonical: "/r" } } });
		expect(resolveSessionWorktree(c.ctx as never, "s")).toBe("/r");
	});
	test("session directory for the global project", () => {
		const c = mockCtx({ sessions: { s: { projectID: "global", location: { directory: "/scratch" } } }, projects: { global: { canonical: "/" } } });
		expect(resolveSessionWorktree(c.ctx as never, "s")).toBe("/scratch");
	});
	test("ctx.location when the session is unknown", () => {
		const c = mockCtx({});
		expect(resolveSessionWorktree(c.ctx as never, "nope")).toBe("/fallback");
	});
});
