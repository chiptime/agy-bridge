/**
 * Layered file configuration (v0.2 spec R1, design D10): the global
 * `<agentDir>/agy-bridge.json` merges with the project
 * `<cwd>/.pi/agy-bridge.json`, per section and per key, project winning.
 * Parsing is TOLERANT (R1): a missing file is silently absent, while an
 * unreadable or malformed file is a collected warning plus "absent" — this
 * loader never throws. Values pass through raw and unvalidated:
 * resolveConfig remains the SINGLE validation gate (v0.1 R12), fed by
 * extensions/index.ts.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FileConfigLayer, PiAdapterOptions } from "./config";

/** The loader's output: the merged layer plus its tolerant-parse warnings. */
export interface LoadedFileConfig extends FileConfigLayer {
	/** Collected "warn + absent" diagnostics; the factory surfaces them. */
	warnings: string[];
}

export interface FileConfigDeps {
	/** Environment snapshot (HOME fallback); defaults to process.env. */
	env?: Record<string, string | undefined>;
	/** Project root: the file read is `<cwd>/.pi/agy-bridge.json`. */
	cwd: string;
	/** Test seam: replaces the resolved global agent dir (pi getAgentDir). */
	agentDir?: string;
	/** Test seam: file reader; returning undefined means the file is absent. */
	readFile?: (path: string) => string | undefined;
}

/** Scalar option keys lifted from files onto PiAdapterOptions. */
const SCALAR_KEYS = ["timeoutMs", "stateDir", "scratchRoot", "imageInput"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * pi's global agent dir (pi-coding-agent `getAgentDir`, dist/config.d.ts:78),
 * falling back to the documented `~/.pi/agent` when the host package cannot
 * be imported (the loader must stay usable outside a live pi process).
 */
async function resolveAgentDir(env: Record<string, string | undefined>): Promise<string> {
	try {
		const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
		return getAgentDir();
	} catch {
		return join(env["HOME"] || homedir(), ".pi", "agent");
	}
}

/**
 * Default reader: ENOENT is a silent absent (the common no-config case);
 * any other read failure is re-thrown so the caller turns it into a warning.
 */
function defaultReadFile(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
		return undefined;
	}
}

/**
 * Tolerant read+parse of one config file: absent → undefined silently;
 * unreadable, malformed, or non-object content → warning + undefined.
 */
function readConfigFile(
	path: string,
	read: (path: string) => string | undefined,
	label: string,
	warnings: string[],
): Record<string, unknown> | undefined {
	let raw: string | undefined;
	try {
		raw = read(path);
	} catch (error) {
		warnings.push(`${label}: unreadable, ignored (${errorText(error)})`);
		return undefined;
	}
	if (raw === undefined) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) {
			warnings.push(`${label}: not a JSON object, ignored`);
			return undefined;
		}
		return parsed;
	} catch (error) {
		warnings.push(`${label}: malformed JSON, ignored (${errorText(error)})`);
		return undefined;
	}
}

/** One named section of a document; a non-object value warns and vanishes. */
function sectionOf(
	doc: Record<string, unknown> | undefined,
	section: string,
	label: string,
	warnings: string[],
): Record<string, unknown> | undefined {
	const value = doc?.[section];
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		warnings.push(`${label}: "${section}" is not an object, ignored`);
		return undefined;
	}
	return value;
}

export async function loadFileConfig(deps: FileConfigDeps): Promise<LoadedFileConfig> {
	const warnings: string[] = [];
	const env = deps.env ?? process.env;
	const agentDir = deps.agentDir ?? (await resolveAgentDir(env));
	const globalPath = join(agentDir, "agy-bridge.json");
	const projectPath = join(deps.cwd, ".pi", "agy-bridge.json");
	const read = deps.readFile ?? defaultReadFile;
	const globalLabel = `global ${globalPath}`;
	const projectLabel = `project ${projectPath}`;
	const globalDoc = readConfigFile(globalPath, read, globalLabel, warnings);
	const projectDoc = readConfigFile(projectPath, read, projectLabel, warnings);

	const config: Partial<PiAdapterOptions> = {};
	for (const key of SCALAR_KEYS) {
		const value = projectDoc?.[key] ?? globalDoc?.[key];
		if (value !== undefined) (config as Record<string, unknown>)[key] = value;
	}
	const models = {
		...sectionOf(globalDoc, "models", globalLabel, warnings),
		...sectionOf(projectDoc, "models", projectLabel, warnings),
	};
	if (Object.keys(models).length > 0) {
		// Raw pass-through cast: resolveConfig validates surviving values.
		config.models = models as PiAdapterOptions["models"];
	}
	const askAgy = {
		...sectionOf(globalDoc, "askAgy", globalLabel, warnings),
		...sectionOf(projectDoc, "askAgy", projectLabel, warnings),
	};
	return { config, askAgy, warnings };
}
