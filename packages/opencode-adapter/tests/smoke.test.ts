/**
 * Integration smoke (spec R3.s1, task 4.1) — tagged "integration" so it
 * filters with `bun test -t integration` and runs standalone with
 * `bun test tests/smoke.test.ts`. Validates BOTH package entries load
 * under the REAL installed host contracts, without launching the opencode
 * TUI or calling live agy: the pinned host binary must satisfy
 * opencode >=1.15 <2 and contain the AI SDK 6 runtime whose v2-compat
 * normalizer proves v3 models are the native path; the package exports
 * map must resolve "." and "./provider" the way a consumer resolves
 * them; the plugin root must default-export {id?, server}; and the
 * provider entry must expose a "create*"-named factory (the loader's
 * pick rule, verified against the 1.18.29 binary) whose models are
 * LanguageModelV3 instances under the host call shape
 * {name: providerID, ...options}.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));

/** Locate the real host binary (follows installer symlinks like linuxbrew's). */
function hostBinary(): string {
	const onPath = execFileSync("opencode", ["--version"], { encoding: "utf8" }).trim();
	// Skip match[0] (the full "1.18.29") — only the capture groups are numbers.
	const [, major, minor] = (onPath.match(/(\d+)\.(\d+)\.(\d+)/) ?? []).map(Number);
	expect(major).toBe(1);
	expect(minor).toBeGreaterThanOrEqual(15);
	return realpathSync(execFileSync("which", ["opencode"], { encoding: "utf8" }).trim());
}

/** Chunked marker search: scans a ~177MB host binary without loading it whole. */
function binaryContains(binPath: string, marker: string): boolean {
	const CHUNK = 1 << 23; // 8 MiB
	const overlap = Buffer.byteLength(marker) - 1;
	const buf = Buffer.alloc(CHUNK + Math.max(overlap, 0));
	const fd = openSync(binPath, "r");
	try {
		let carry = 0; // bytes kept from the previous chunk to bridge the marker
		for (;;) {
			const n = readSync(fd, buf, carry, CHUNK, null);
			if (n === 0) return false;
			if (buf.subarray(0, carry + n).includes(marker)) return true;
			carry = Math.min(overlap, n);
			buf.copy(buf, 0, n - carry, n);
		}
	} finally {
		closeSync(fd);
	}
}

describe("smoke(integration): host runtime contract (R3 pinned opencode)", () => {
	test("installed opencode is >=1.15.0 <2 and its AI SDK 6 runtime is v3-native", () => {
		const bin = hostBinary();
		expect(statSync(bin).isFile()).toBe(true);
		// The v2-compat normalizer's warning string: models declaring
		// specificationVersion "v3" pass through UNTOUCHED (WU3b binary
		// evidence) — the contract our LanguageModelV3 relies on.
		expect(binaryContains(bin, "v2 specification compatibility mode")).toBe(true);
	});
});

describe("smoke(integration): package exports map serves both entries (R3.s1)", () => {
	test('subpaths "." and "./provider" resolve to existing bundled targets a consumer can import', async () => {
		const pkg = JSON.parse(readFileSync(`${pkgRoot}package.json`, "utf8"));
		for (const sub of [".", "./provider"]) {
			expect(pkg.exports[sub]).toBeDefined();
			const target = pkg.exports[sub].default as string;
			// Distribution contract: the default targets are the BUNDLED dist
			// files (engine inlined, host SDKs externalized) so a consumer
			// outside the workspace needs no workspace:* resolution.
			expect(target.startsWith("./dist/")).toBe(true);
			expect(target.endsWith(".js")).toBe(true);
			expect(existsSync(`${pkgRoot}${target.replace("./", "")}`)).toBe(true);
		}
		// Real consumer resolution: self-reference goes through the exports
		// map exactly like the host's npm-entry import does.
		const root = await import("agy-bridge-opencode");
		const providerEntry = await import("agy-bridge-opencode/provider");
		expect(root.default).toBeTypeOf("object");
		expect(Object.keys(providerEntry)).toContain("createAgyProvider");
	});
});

describe("smoke(integration): plugin entry default-exports {id?, server}", () => {
	test("server is a function plugin whose chat.params hook installs the agy channel", async () => {
		const root = await import("agy-bridge-opencode");
		const plugin = root.default as { id?: string; server: (input: unknown) => Promise<unknown> };
		expect(plugin.id === undefined || typeof plugin.id === "string").toBe(true);
		expect(plugin.server).toBeTypeOf("function");
		const hooks = (await plugin.server({ worktree: "/tmp" })) as Record<string, unknown>;
		expect(typeof hooks["chat.params"]).toBe("function");
	});
});

describe("smoke(integration): provider factory yields LanguageModelV3 models", () => {
	test("create*-named export under the host call shape resolves default + gemini ids to v3", async () => {
		const entry = await import("agy-bridge-opencode/provider");
		const factoryName = Object.keys(entry).find((k) => k.startsWith("create"));
		expect(factoryName).toBe("createAgyProvider");
		const factories = entry as unknown as Record<string, (o: Record<string, unknown>) => unknown>;
		const create = factories[factoryName!];
		// Host call shape {name: providerID, ...mergedOptions}; temp state
		// keeps the smoke free of real session-map side effects.
		const stateDir = await mkdtemp("/tmp/agy-smoke-state-");
		const provider = create({ name: "agy", stateDir }) as {
			specificationVersion: string;
			languageModel: (id: string) => {
				specificationVersion: string;
				provider: string;
				modelId: string;
				doStream: unknown;
				doGenerate: unknown;
			};
		};
		expect(provider.specificationVersion).toBe("v3");
		for (const id of ["agy/default", "agy/gemini-3.8-flash-high"]) {
			const model = provider.languageModel(id);
			expect(model.specificationVersion).toBe("v3");
			expect(model.provider).toBe("agy");
			expect(model.modelId).toBe(id);
			expect(model.doStream).toBeTypeOf("function");
			expect(model.doGenerate).toBeTypeOf("function");
		}
	});
});
