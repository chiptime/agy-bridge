/**
 * Smoke test for the extension entry (specs R1, R2; tasks E.1): load
 * `extensions/index.ts` the way pi does — through jiti, resolved from the
 * pi-coding-agent package so it is pi's own loader dependency, never ours —
 * and drive the default export with a recording ExtensionAPI stub.
 *
 * The default export takes no injection seams, so discovery is redirected
 * through the environment exactly as a user would: `AGY_BIN` points at a
 * fake executable that answers `agy models` with a TSV and leaves a marker
 * file per invocation, and `XDG_STATE_HOME` points at a temp dir. The real
 * binary is never touched.
 *
 * Also guards the published surface: every runtime import reachable from
 * the entry must live under a directory listed in `package.json#files`,
 * otherwise the npm form of the package cannot load.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ProviderConfig, ToolDefinition } from "@earendil-works/pi-coding-agent";
import pkg from "../package.json";

const PACKAGE_ROOT = resolve(import.meta.dir, "..");
const ENTRY = join(PACKAGE_ROOT, "extensions", "index.ts");

// --- harness ------------------------------------------------------------------

interface PiCalls {
	providers: { name: string; config: ProviderConfig }[];
	tools: ToolDefinition[];
	commands: { name: string; description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }[];
	handlers: Record<string, unknown[]>;
}

/** Recording ExtensionAPI stub: the only fake boundary in this file. */
function stubPi(): { pi: ExtensionAPI; calls: PiCalls } {
	const calls: PiCalls = { providers: [], tools: [], commands: [], handlers: {} };
	const pi = {
		registerProvider: (name: string, config: ProviderConfig) => calls.providers.push({ name, config }),
		registerTool: (tool: ToolDefinition) => calls.tools.push(tool),
		registerCommand: (name: string, options: { description?: string; handler: PiCalls["commands"][number]["handler"] }) =>
			calls.commands.push({ name, description: options.description, handler: options.handler }),
		on: (event: string, handler: unknown) => {
			(calls.handlers[event] ??= []).push(handler);
		},
	} as unknown as ExtensionAPI;
	return { pi, calls };
}

const TSV = "agy v1.1.28\ngemini-3.8-flash-high\tFlash High\ngemini-3.8-flash-medium\tFlash Med\ngemini-3.8-flash-low\tFlash Low\n";

/** Fake `agy` on disk: answers `models` with TSV and records each spawn. */
function writeFakeAgy(dir: string): { bin: string; marker: string } {
	const bin = join(dir, "fake-agy");
	const marker = join(dir, "spawned");
	// printf FORMAT (not '%s') so the escaped newlines become real lines.
	writeFileSync(bin, `#!/bin/sh\necho called >> "${marker}"\nif [ "$1" = "models" ]; then printf '${TSV.replace(/\n/g, "\\n")}'; exit 0; fi\nexit 1\n`);
	chmodSync(bin, 0o755);
	return { bin, marker };
}

type Factory = (pi: ExtensionAPI) => Promise<void>;

/** Load the entry through jiti, resolved from pi's own package (pi's loader). */
async function loadEntryLikePi(): Promise<{ factory: unknown; loader: "jiti" | "dynamic-import" }> {
	try {
		const piEntry = createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent");
		const jitiPath = createRequire(pathToFileURL(piEntry)).resolve("jiti/static");
		// jiti is pi's dependency, not ours: no type import, minimal structural type.
		type Jiti = { import: (id: string, opts: { default: true }) => Promise<unknown> };
		const { createJiti } = (await import(jitiPath)) as {
			createJiti: (url: string, opts: { moduleCache: boolean }) => Jiti;
		};
		const jiti = createJiti(import.meta.url, { moduleCache: false });
		return { factory: await jiti.import(ENTRY, { default: true }), loader: "jiti" };
	} catch {
		// jiti not resolvable from this checkout: fall back to the runtime's
		// own TS import so the registration contract is still exercised.
		return { factory: (await import(ENTRY)).default, loader: "dynamic-import" };
	}
}

/** Collect package-relative top-level dirs of every runtime import reachable from the entry. */
function runtimeImportRoots(file: string, seen = new Set<string>()): Set<string> {
	seen.add(file);
	const src = readFileSync(file, "utf8");
	for (const m of src.matchAll(/^import\s+(?!type\s)[^"']*?from\s+["'](\.[^"']+)["']/gm)) {
		const target = resolveTs(dirname(file), m[1]!);
		if (seen.has(target)) continue;
		seen.add(target);
		runtimeImportRoots(target, seen);
	}
	return new Set([...seen].map((p) => relative(PACKAGE_ROOT, p).split("/")[0]!));
}

function resolveTs(from: string, spec: string): string {
	const base = resolve(from, spec);
	for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
		if (existsSync(candidate) && readdirSync(dirname(candidate)).includes(candidate.split("/").pop()!)) return candidate;
	}
	throw new Error(`unresolvable import ${spec} from ${from}`);
}

// --- environment --------------------------------------------------------------

let root: string;
let fake: { bin: string; marker: string };
const savedEnv = { AGY_BIN: process.env["AGY_BIN"], XDG_STATE_HOME: process.env["XDG_STATE_HOME"] };
let loaded: { factory: unknown; loader: "jiti" | "dynamic-import" };

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "agy-pi-smoke-"));
	fake = writeFakeAgy(root);
	process.env["AGY_BIN"] = fake.bin;
	process.env["XDG_STATE_HOME"] = join(root, "state");
	loaded = await loadEntryLikePi();
});

afterAll(() => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(root, { recursive: true, force: true });
});

// --- tests --------------------------------------------------------------------

describe("smoke: extensions/index.ts loaded like pi (R1, R2)", () => {
	test("the loaded default export is a factory function (pi rejects anything else)", () => {
		expect(typeof loaded.factory).toBe("function");
		if (loaded.loader !== "jiti") console.warn("smoke: jiti not resolvable; loaded via dynamic import");
	});

	test("one invocation registers provider agy (default first), AskAgy, /agy, and both lifecycle hooks once", async () => {
		const { pi, calls } = stubPi();
		await (loaded.factory as Factory)(pi);

		expect(calls.providers.map((p) => p.name)).toEqual(["agy"]);
		const models = calls.providers[0]!.config.models ?? [];
		expect(models[0]?.id).toBe("default");
		const flash = models.find((m) => m.id === "gemini-3.8-flash");
		expect(flash?.reasoning).toBe(true);
		expect(flash?.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "gemini-3.8-flash-low",
			medium: "gemini-3.8-flash-medium",
			high: "gemini-3.8-flash-high",
			xhigh: null,
			max: null,
		});
		expect(typeof calls.providers[0]!.config.streamSimple).toBe("function");

		expect(calls.tools.map((t) => t.name)).toEqual(["AskAgy"]);
		const params = calls.tools[0]!.parameters as { required?: string[]; properties: Record<string, unknown> };
		expect(params.required).toEqual(["prompt"]);
		expect(Object.keys(params.properties).sort()).toEqual(["isolated", "model", "prompt", "scope", "skills", "thinking"]);

		expect(calls.commands.map((c) => c.name)).toEqual(["agy"]);
		expect(calls.commands[0]!.description).toContain("agy bridge");
		expect(typeof calls.commands[0]!.handler).toBe("function");

		expect(Object.keys(calls.handlers).sort()).toEqual(["session_shutdown", "session_start"]);
		expect(calls.handlers["session_start"]).toHaveLength(1);
		expect(calls.handlers["session_shutdown"]).toHaveLength(1);

		// Discovery went through the env-redirected binary, never the real one.
		expect(readFileSync(fake.marker, "utf8")).toBe("called\n");
	});

	test("a second invocation on a fresh host registers again — no module-level latch", async () => {
		const { pi, calls } = stubPi();
		await (loaded.factory as Factory)(pi);
		expect(calls.providers.map((p) => p.name)).toEqual(["agy"]);
		expect(calls.tools.map((t) => t.name)).toEqual(["AskAgy"]);
		expect(calls.commands.map((c) => c.name)).toEqual(["agy"]);
		expect(calls.handlers["session_start"]).toHaveLength(1);
		expect(calls.handlers["session_shutdown"]).toHaveLength(1);
	});

	test("a relative stateDir throws the typed config error before any registration or spawn (R12)", async () => {
		const { createAgyExtension } = (await import(ENTRY)) as { createAgyExtension: (pi: ExtensionAPI, deps: unknown) => Promise<void> };
		const { pi, calls } = stubPi();
		rmSync(fake.marker, { force: true });
		const err = await createAgyExtension(pi, { options: { stateDir: "relative/state" } }).then(
			() => undefined,
			(e: unknown) => e as { name: string; code: string; field: string },
		);
		expect(err?.name).toBe("AgyConfigError");
		expect(err?.code).toBe("AGY_CONFIG_INVALID");
		expect(err?.field).toBe("stateDir");
		expect(calls.providers).toHaveLength(0);
		expect(calls.tools).toHaveLength(0);
		expect(calls.commands).toHaveLength(0);
		expect(existsSync(fake.marker)).toBe(false);
	});

	test("package.json#files covers every directory the entry imports at runtime", () => {
		const roots = runtimeImportRoots(ENTRY);
		expect(roots.has("extensions")).toBe(true);
		expect(roots.has("src")).toBe(true);
		for (const dir of roots) expect(pkg.files).toContain(dir);
	});
});
