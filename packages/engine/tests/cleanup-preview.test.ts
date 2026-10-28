import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewCleanup } from "../src/cleanup-preview";
import { acquireConversationLock } from "../src/conversation-lock";

const roots: string[] = [];
const databases: Database[] = [];
const NOW = Date.parse("2026-10-28T00:00:00Z");
const OLD = "2026-09-01T00:00:00Z";
const id = (n: number) => `11111111-1111-1111-1111-${String(n).padStart(12, "0")}`;

afterEach(() => {
	for (const db of databases.splice(0)) db.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(wal = false) {
	const homeDir = mkdtempSync(join(tmpdir(), "agy-preview-test-"));
	roots.push(homeDir);
	const base = join(homeDir, ".gemini", "antigravity-cli");
	const stateDir = join(homeDir, "state");
	mkdirSync(base, { recursive: true });
	mkdirSync(stateDir);
	const db = new Database(join(base, "conversation_summaries.db"));
	databases.push(db);
	if (wal) db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
	db.exec(`CREATE TABLE conversation_summaries (
		conversation_id TEXT PRIMARY KEY, parent_conversation_id TEXT,
		last_modified_time TEXT, status TEXT, not_fully_idle INTEGER
	)`);
	return {
		homeDir, stateDir, base, db,
		options: { homeDir, stateDir, now: () => NOW },
		add(n: number, parent: string | null = id(99), date: string | null = OLD, status = "IDLE", busy: number | null = 0) {
			db.query("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)").run(id(n), parent, date, status, busy);
			mkdirSync(join(base, "brain", id(n)), { recursive: true });
			writeFileSync(join(base, "brain", id(n), "artifact.txt"), "fixture");
		},
	};
}

function hashes(root: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) Object.assign(result, hashes(path));
		else result[path] = createHash("sha256").update(readFileSync(path)).digest("hex");
	}
	return result;
}

describe("read-only cleanup preview", () => {
	test.each([
		"2020-02-30T00:00:00Z",
		"2023-02-29T00:00:00Z",
		"2020-04-31T00:00:00Z",
		"2020-01-01T24:00:00Z",
	])("invalid calendar date %s is protected without changing sources", async (date) => {
		const f = fixture(); f.add(1, id(99), date);
		const before = hashes(f.homeDir);
		const result = await previewCleanup(f.options);
		expect(result.entries[0].protectionReasons).toContain("unknown_date");
		expect(result.entries[0].modifiedAt).toBeNull();
		expect(result.totals.candidates).toBe(0);
		expect(hashes(f.homeDir)).toEqual(before);
	});

	test("accepts real leap-day dates with UTC, offsets, and submillisecond precision", async () => {
		for (const date of ["2024-02-29T00:00:00Z", "2024-02-29T01:00:00+01:00", "2024-02-29T00:00:00.123456789Z"]) {
			const f = fixture(); f.add(1, id(99), date);
			const result = await previewCleanup(f.options);
			expect(result.totals.candidates).toBe(1);
			expect(result.entries[0].protectionReasons).not.toContain("unknown_date");
		}
	});

	test("reports old structured subagents, reads WAL, and leaves every source byte and file unchanged", async () => {
		const f = fixture(true);
		f.add(1);
		mkdirSync(join(f.homeDir, ".gemini", "config"));
		writeFileSync(join(f.homeDir, ".gemini", "config", "mcp_config.json"), "{\"mcpServers\":{\"pi-bridge-123\":{}}}");
		const before = hashes(f.homeDir);
		const result = await previewCleanup(f.options);
		expect(result.readOnly).toBe(true);
		expect(result.complete).toBe(true);
		expect(result.entries[0]).toMatchObject({ conversationId: id(1), category: "native_subagent", disposition: "candidate", estimatedBytes: 7 });
		expect(result.totals.candidates).toBe(1);
		expect(hashes(f.homeDir)).toEqual(before);
	});

	test("protects persisted bindings, including expired OpenCode v2 and Pi v1 rows, without pruning", async () => {
		const f = fixture();
		f.add(1); f.add(2);
		writeFileSync(join(f.stateDir, "opencode-sessions.json"), JSON.stringify({ version: 2, sessions: { old: [{ conversationId: id(1), updatedAt: OLD }] } }));
		writeFileSync(join(f.stateDir, "pi-sessions.json"), JSON.stringify({ version: 1, sessions: { "old:ask": { conversationId: id(2), updatedAt: OLD } } }));
		const before = hashes(f.homeDir);
		const result = await previewCleanup(f.options);
		expect(result.entries.every((e) => e.protectionReasons.includes("bridge_binding"))).toBe(true);
		expect(result.totals.candidates).toBe(0);
		expect(hashes(f.homeDir)).toEqual(before);
	});

	test("protects active, unknown-activity, unknown-date, recent, and locked conversations", async () => {
		const f = fixture();
		f.add(1, id(99), OLD, "ACTIVE", 1);
		f.add(2, id(99), OLD, "NEW_UNKNOWN_STATUS");
		f.add(3, id(99), "2026-09-01T00:00:00");
		f.add(4, id(99), "2026-10-27T00:00:00Z");
		f.add(5);
		const lock = await acquireConversationLock(join(f.stateDir, "conversation-locks"), id(5));
		try {
			const before = hashes(f.homeDir);
			const result = await previewCleanup(f.options);
			expect(result.entries.map((e) => e.protectionReasons)).toEqual([
				expect.arrayContaining(["active"]), expect.arrayContaining(["unknown_activity"]),
				expect.arrayContaining(["unknown_date"]), expect.arrayContaining(["within_retention"]),
				expect.arrayContaining(["conversation_lock"]),
			]);
			expect(result.totals.candidates).toBe(0);
			expect(hashes(f.homeDir)).toEqual(before);
		} finally { lock.release(); }
	});

	test("never uses transcript probe text or a missing brain as deletion evidence", async () => {
		const f = fixture();
		f.add(1, null); f.add(2, null);
		writeFileSync(join(f.base, "brain", id(1), "transcript.jsonl"), "Please explain mapping and typing. ping");
		rmSync(join(f.base, "brain", id(2)), { recursive: true });
		mkdirSync(join(f.base, "conversations"));
		writeFileSync(join(f.base, "conversations", `${id(2)}.db`), "preserve");
		const before = hashes(f.homeDir);
		const result = await previewCleanup(f.options);
		expect(result.entries.every((e) => e.disposition === "unclassified")).toBe(true);
		expect(result.totals.candidates).toBe(0);
		expect(JSON.stringify(result)).not.toContain("Please explain");
		expect(hashes(f.homeDir)).toEqual(before);
	});

	test("corrupt or unknown binding formats protect every conversation and mark incomplete evidence", async () => {
		const f = fixture(); f.add(1);
		for (const contents of ["{broken", JSON.stringify({ version: 99, sessions: {} })]) {
			writeFileSync(join(f.stateDir, "pi-sessions.json"), contents);
			const before = hashes(f.homeDir);
			const result = await previewCleanup(f.options);
			expect(result.complete).toBe(false);
			expect(result.entries[0].protectionReasons).toContain("unknown_binding_state");
			expect(result.totals.candidates).toBe(0);
			expect(hashes(f.homeDir)).toEqual(before);
		}
	});

	test("an unavailable SQLite backend returns a protected filesystem inventory instead of throwing", async () => {
		const f = fixture(); f.add(1);
		const before = hashes(f.homeDir);
		let snapshotPath = "";
		const result = await previewCleanup({ ...f.options, openSnapshot: async (path) => {
			snapshotPath = path;
			expect(path.startsWith(f.homeDir)).toBe(false);
			throw new Error("unsupported runtime");
		} });
		expect(result.complete).toBe(false);
		expect(result.entries[0].protectionReasons).toContain("metadata_unavailable");
		expect(result.warnings).toContain("summary_metadata_unavailable");
		expect(existsSync(snapshotPath)).toBe(false);
		expect(hashes(f.homeDir)).toEqual(before);
	});

	test("does not traverse a brain symlink into unrelated files", async () => {
		const f = fixture(); f.add(1);
		const external = mkdtempSync(join(tmpdir(), "agy-preview-external-"));
		roots.push(external);
		writeFileSync(join(external, "private.txt"), "unrelated private content");
		rmSync(join(f.base, "brain", id(1)), { recursive: true });
		symlinkSync(external, join(f.base, "brain", id(1)), "dir");
		const before = hashes(external);
		const result = await previewCleanup(f.options);
		expect(result.entries[0]).toMatchObject({ disposition: "protected", estimatedBytes: null });
		expect(result.entries[0].protectionReasons).toContain("filesystem_unavailable");
		expect(JSON.stringify(result)).not.toContain("unrelated private content");
		expect(hashes(external)).toEqual(before);
	});

	test("reports truncation instead of claiming a complete bounded inventory", async () => {
		const f = fixture();
		const insert = f.db.query("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?)");
		f.db.transaction(() => {
			for (let n = 1; n <= 501; n++) insert.run(id(n), id(999), OLD, "IDLE", 0);
		})();
		const result = await previewCleanup(f.options);
		expect(result.entries).toHaveLength(500);
		expect(result.complete).toBe(false);
		expect(result.warnings).toContain("inventory_truncated");
	});

	test("rejects negative/fractional TTL and unknown apply options before reading any state", async () => {
		for (const ttlDays of [-1, 1.5, NaN]) {
			await expect(previewCleanup({ ttlDays })).rejects.toThrow("ttlDays");
		}
		await expect(previewCleanup({ apply: true } as any)).rejects.toThrow("apply");
	});
});
