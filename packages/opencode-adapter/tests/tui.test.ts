import { describe, expect, it, mock } from "bun:test";
import { tui } from "../src/tui";
import { openSessionStore } from "../src/session-store";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, mkdirSync } from "node:fs";

describe("unit: tui plugin — interactive agy modal dialog", () => {
	it("registers /agy-open command and keybindings", async () => {
		let registeredCommand: any;
		let registeredLayer: any;

		const mockApi: any = {
			command: {
				register: (factory: () => any[]) => {
					registeredCommand = factory();
					return () => {};
				},
			},
			keymap: {
				registerLayer: (layer: any) => {
					registeredLayer = layer;
					return () => {};
				},
			},
			lifecycle: {
				onDispose: () => {},
			},
		};

		await tui(mockApi);

		expect(registeredCommand).toBeDefined();
		expect(registeredCommand[0].value).toBe("agy-open");
		expect(registeredCommand[0].slash.name).toBe("agy-open");
		expect(registeredCommand[0].slash.aliases).toContain("agy");

		expect(registeredLayer).toBeDefined();
		expect(registeredLayer.commands.some((c: any) => c.name === ":agy-open")).toBe(true);
		expect(registeredLayer.bindings.some((b: any) => b.key === "alt+a")).toBe(true);
	});

	it("renders no-session dialog when session is unbound", async () => {
		let replacedDialog: any;

		const mockApi: any = {
			route: {
				current: { name: "session", params: { sessionID: "unknown_session" } },
			},
			state: {
				session: { get: () => undefined },
				path: { worktree: "/test" },
			},
			ui: {
				dialog: {
					replace: (renderer: () => any) => {
						replacedDialog = renderer();
					},
					clear: () => {},
				},
				toast: () => {},
			},
			command: {
				register: (factory: () => any[]) => {
					const cmds = factory();
					// Trigger command
					cmds[0].onSelect();
					return () => {};
				},
			},
			keymap: { registerLayer: () => () => {} },
			lifecycle: { onDispose: () => {} },
		};

		await tui(mockApi);

		// Wait microtasks
		await new Promise((r) => setTimeout(r, 20));

		expect(replacedDialog).toBeDefined();
		expect(replacedDialog.title).toContain("Agy Bridge · Sin Sesión Vinculada");
	});

	it("renders session modal with actions when session is bound", async () => {
		const tempState = join(tmpdir(), `agy-test-${Date.now()}`);
		const stateDir = join(tempState, "agy-bridge");
		mkdirSync(stateDir, { recursive: true });
		process.env.XDG_STATE_HOME = tempState;

		const store = openSessionStore(join(stateDir, "opencode-sessions.json"));
		await store.bind("bound_ses_1", "test-conv-12345", ["hash1"], "gemini-2.5-pro");

		let replacedDialog: any;
		const toasts: any[] = [];

		let keymapCmd: any;
		const mockApi: any = {
			route: {
				current: { name: "session", params: { sessionID: "bound_ses_1" } },
			},
			state: {
				session: { get: () => undefined },
				path: { worktree: tempState },
			},
			ui: {
				dialog: {
					replace: (renderer: () => any) => {
						replacedDialog = renderer();
					},
					clear: () => {},
				},
				toast: (t: any) => toasts.push(t),
			},
			command: {
				register: () => () => {},
			},
			keymap: {
				registerLayer: (layer: any) => {
					keymapCmd = layer.commands.find((c: any) => c.name === ":agy-open");
					return () => {};
				},
			},
			lifecycle: { onDispose: () => {} },
		};

		await tui(mockApi);

		expect(keymapCmd).toBeDefined();
		keymapCmd.run();

		await new Promise((r) => setTimeout(r, 20));

		expect(replacedDialog).toBeDefined();
		expect(replacedDialog.title).toContain("Agy Bridge · Sesión Conectada");
		expect(replacedDialog.options.some((o: any) => o.value === "launch_split")).toBe(true);
		expect(replacedDialog.options.some((o: any) => o.value === "copy_cmd")).toBe(true);
		expect(replacedDialog.options.some((o: any) => o.value === "view_transcript")).toBe(true);

		// Test copying command
		const copyOpt = replacedDialog.options.find((o: any) => o.value === "copy_cmd");
		replacedDialog.onSelect(copyOpt);
		expect(toasts.some((t) => t.message.includes("Comando copiado"))).toBe(true);
	});
});
