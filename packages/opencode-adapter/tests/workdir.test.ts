/**
 * Unit tests for workdir preparation (spec R9 + threat matrix cwd/dir
 * authority): scratch mode runs every turn in a fresh mkdtemp dir under the
 * configured root; session mode uses the plugin worktree VERBATIM as cwd;
 * a relative or missing worktree is a typed config error raised BEFORE any
 * spawn can happen. Scratch pruning removes the contents of dirs older
 * than 7 days while keeping run.log (R6 error messages must keep resolving).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { AgyConfigError } from "../src/config";
import { prepareWorkdir, pruneScratch } from "../src/workdir";

const DAY_MS = 24 * 60 * 60 * 1000;
const backdate = (path: string, days: number) => {
	const old = new Date(Date.now() - days * DAY_MS);
	utimesSync(path, old, old);
};

describe("unit: workdir — scratch/session authority (R9, threat matrix)", () => {
	test("threat (1): scratch mode prepares a per-run mkdtemp dir under the configured root", async () => {
		const root = await mkdtemp("/tmp/agy-workdir-");
		const prepared = prepareWorkdir("scratch", { scratchRoot: root });
		expect(prepared.scratch).toBe(true);
		expect(prepared.dir.startsWith(join(root, "agy-run-"))).toBe(true);
		expect(statSync(prepared.dir).isDirectory()).toBe(true);
		const second = prepareWorkdir("scratch", { scratchRoot: root });
		expect(second.dir).not.toBe(prepared.dir);
	});

	test("threat (2): session mode uses the worktree verbatim as the run cwd", async () => {
		const worktree = await mkdtemp("/tmp/agy-session-");
		const prepared = prepareWorkdir("session", { worktree });
		expect(prepared.scratch).toBe(false);
		expect(prepared.dir).toBe(worktree);
	});

	test("threat (3): relative or missing worktree → typed AgyConfigError, no dir handed to a spawn", () => {
		expect(() => prepareWorkdir("session", { worktree: "relative/path" })).toThrow(AgyConfigError);
		expect(() => prepareWorkdir("session", { worktree: "/absolutely/missing" })).toThrow(AgyConfigError);
		expect(() => prepareWorkdir("session", {})).toThrow(AgyConfigError);
		try {
			prepareWorkdir("session", { worktree: "relative/path" });
		} catch (err) {
			expect((err as AgyConfigError).field).toBe("worktree");
			expect((err as AgyConfigError).message).toMatch(/absolute/i);
		}
	});

	test('threat (3b): the filesystem root "/" is absolute and exists but is NEVER a valid worktree → typed AgyConfigError', () => {
		expect(() => prepareWorkdir("session", { worktree: "/" })).toThrow(AgyConfigError);
		try {
			prepareWorkdir("session", { worktree: "/" });
		} catch (err) {
			expect((err as AgyConfigError).field).toBe("worktree");
			expect((err as AgyConfigError).message).toMatch(/filesystem root/i);
			expect((err as AgyConfigError).message).toMatch(/git worktree/i);
		}
	});

	test("R9.s1: scratch prune >7d clears old dir contents but keeps run.log; fresh dirs untouched", async () => {
		const root = await mkdtemp("/tmp/agy-prune-");
		const old = join(root, "agy-run-old");
		const fresh = join(root, "agy-run-fresh");
		for (const dir of [old, fresh]) {
			mkdirSync(dir);
			writeFileSync(join(dir, "run.log"), "log\n");
			writeFileSync(join(dir, "artifact.bin"), "x");
			mkdirSync(join(dir, "state"));
		}
		backdate(old, 8);
		const pruned = pruneScratch(root);
		expect(pruned).toBe(1);
		expect(statSync(join(old, "run.log")).isFile()).toBe(true);
		expect(readdirSync(old)).toEqual(["run.log"]);
		expect(readdirSync(fresh).sort()).toEqual(["artifact.bin", "run.log", "state"]);
	});

	test("R9.s1: prune never touches dirs younger than the window even when named like ours", async () => {
		const root = await mkdtemp("/tmp/agy-prune-young-");
		const young = join(root, "agy-run-young");
		mkdirSync(young);
		writeFileSync(join(young, "run.log"), "log\n");
		backdate(young, 6);
		expect(pruneScratch(root)).toBe(0);
		expect(readdirSync(young)).toEqual(["run.log"]);
	});

	test("threat: prune ignores foreign dirs in a shared root (default root is os.tmpdir())", async () => {
		const root = await mkdtemp("/tmp/agy-prune-foreign-");
		const foreign = join(root, "someone-else-old");
		mkdirSync(foreign);
		writeFileSync(join(foreign, "data.txt"), "not ours\n");
		backdate(foreign, 30);
		expect(pruneScratch(root)).toBe(0);
		expect(readdirSync(foreign)).toEqual(["data.txt"]);
	});
});
