/**
 * Contract test for the package manifest (spec R1): pi discovers the
 * extension through `pi.extensions` pointing at TypeScript source loaded
 * by jiti — no build step — with `*` peer ranges on the pi host packages
 * so any 0.x host can load us, and the engine linked via the workspace.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";

describe("unit: manifest — pi extension packaging contract (R1)", () => {
	test("package identity: agy-bridge-pi v0.4.0, ESM", () => {
		expect(pkg.name).toBe("agy-bridge-pi");
		expect(pkg.version).toBe("0.4.0");
		expect(pkg.type).toBe("module");
	});

	test("pi.extensions points at the TS factory (jiti loads source, no build)", () => {
		expect(pkg.pi?.extensions).toEqual(["./extensions/index.ts"]);
	});

	test("every pi host peer is a wildcard range", () => {
		expect(pkg.peerDependencies).toEqual({
			"@earendil-works/pi-coding-agent": "*",
			"@earendil-works/pi-ai": "*",
			"@earendil-works/pi-tui": "*",
			"typebox": "*",
		});
	});

	test("dev-pin keeps a concrete pi host available for typecheck and tests", () => {
		expect(pkg.devDependencies?.["@earendil-works/pi-coding-agent"]).toBe("^0.85");
		expect(pkg.devDependencies?.["@types/bun"]).toBeDefined();
		expect(pkg.devDependencies?.typescript).toBeDefined();
	});

	test("engine rides the workspace; shipped files are source, not build output", () => {
		expect(pkg.dependencies).toEqual({ "agy-bridge-engine": "workspace:*" });
		// `src` must ship: the entry imports ../src/* at runtime (smoke.test.ts guards this).
		expect(pkg.files).toEqual(["extensions", "src", "README.md"]);
	});

	test("tsconfig follows the house contract: strict, noEmit, source roots", () => {
		const path = join(import.meta.dir, "..", "tsconfig.json");
		expect(existsSync(path)).toBe(true);
		const tsconfig = JSON.parse(readFileSync(path, "utf8")) as {
			compilerOptions: Record<string, unknown>;
		};
		expect(tsconfig.compilerOptions.strict).toBe(true);
		expect(tsconfig.compilerOptions.noEmit).toBe(true);
	});
});
