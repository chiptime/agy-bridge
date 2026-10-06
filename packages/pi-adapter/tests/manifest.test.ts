/**
 * Contract test for the package manifest (spec R1): pi discovers the
 * extension through `pi.extensions` pointing at the bundle built into
 * dist/ (the engine is inlined, so the published package is self-contained),
 * with `*` peer ranges on the pi host packages so any 0.x host can load us.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json";

describe("unit: manifest — pi extension packaging contract (R1)", () => {
	test("package identity: agy-bridge-pi v0.5.1, ESM", () => {
		expect(pkg.name).toBe("agy-bridge-pi");
		expect(pkg.version).toBe("0.5.1");
		expect(pkg.type).toBe("module");
	});

	test("pi.extensions points at the bundled factory in dist/", () => {
		expect(pkg.pi?.extensions).toEqual(["./dist/index.js"]);
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

	test("engine is bundled, never a runtime dependency; only the bundle ships", () => {
		// npm cannot resolve `workspace:*` for consumers (EUNSUPPORTEDPROTOCOL),
		// so the engine is inlined into dist/ and kept as a dev-only workspace link.
		expect(pkg).not.toHaveProperty("dependencies");
		expect(pkg.devDependencies?.["agy-bridge-engine"]).toBe("workspace:*");
		expect(pkg.files).toEqual(["dist", "README.md"]);
		// prepack guarantees `npm publish` ships a fresh bundle (dist/ is gitignored).
		expect(pkg.scripts?.prepack).toBe("bun run build");
		expect(pkg.scripts?.build).toContain("--external typebox");
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
