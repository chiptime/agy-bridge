/** Advisory inventory only. There is deliberately no apply/delete operation. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, opendirSync, readSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

export const CLEANUP_PREVIEW_DESCRIPTION = "Inspect Antigravity conversation cleanup candidates without deleting anything. Reports structured subagent evidence, retained bridge bindings, activity/lock protections, estimated bytes, and missing evidence. Advisory snapshot only, never authorization to delete. No apply option; MCP configuration is excluded.";
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const DAY = 86_400_000;
const MAX_ENTRIES = 500;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const IDLE_STATUSES = new Set(["IDLE", "DONE", "COMPLETED", "CASCADE_RUN_STATUS_IDLE", "CASCADE_RUN_STATUS_DONE", "CASCADE_RUN_STATUS_COMPLETED"]);

export interface CleanupSnapshotDatabase {
	all(sql: string): unknown[];
	close(): void;
}

export interface CleanupPreviewOptions {
	homeDir?: string;
	stateDir?: string;
	ttlDays?: number;
	now?: () => number;
	/** Test seam; receives only an owned temporary snapshot, never a source DB. */
	openSnapshot?: (path: string) => Promise<CleanupSnapshotDatabase>;
}

export interface CleanupPreviewEntry {
	conversationId: string;
	category: "native_subagent" | "unclassified";
	disposition: "candidate" | "protected" | "unclassified";
	evidence: string[];
	protectionReasons: string[];
	modifiedAt: string | null;
	estimatedBytes: number | null;
}

export interface CleanupPreview {
	readOnly: true;
	ttlDays: number;
	complete: boolean;
	warnings: string[];
	entries: CleanupPreviewEntry[];
	totals: { inspected: number; candidates: number; protected: number; estimatedCandidateBytes: number };
	note: string;
}

interface Summary {
	conversationId: string;
	parentConversationId: unknown;
	modifiedAt: unknown;
	status: unknown;
	notFullyIdle: unknown;
}

function validateTtl(value: unknown): asserts value is number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 36_500) {
		throw new Error("ttlDays must be an integer from 0 to 36500");
	}
}

function parseSummaryTime(value: unknown): number {
	if (typeof value !== "string") return NaN;
	const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
	if (!match) return NaN;
	const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
	const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
	// Date.parse normalizes impossible dates and 24:00 instead of rejecting them.
	if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]
		|| hour > 23 || minute > 59 || second > 59
		|| Number(match[8] ?? 0) > 23 || Number(match[9] ?? 0) > 59) return NaN;
	return Date.parse(value);
}

/** Enforce the tool boundary even when a host bypasses schema validation. */
export function parseCleanupPreviewParameters(input: unknown): { ttlDays?: number } {
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Cleanup preview parameters must be an object");
	for (const key of Object.keys(input)) {
		if (key !== "ttlDays") throw new Error(`Unsupported cleanup preview parameter: ${key}`);
	}
	const ttlDays = (input as Record<string, unknown>).ttlDays;
	if (ttlDays === undefined) return {};
	validateTtl(ttlDays);
	return { ttlDays };
}

function stat(path: string) {
	try { return lstatSync(path); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function plainDirectory(path: string): void {
	const info = stat(path);
	if (info && (!info.isDirectory() || info.isSymbolicLink())) throw new Error("unsafe_directory");
}

/** Never follow a file symlink; detect replacement/growth while copying. */
function readBounded(path: string, maxBytes: number): Buffer {
	if (stat(path)?.isSymbolicLink()) throw new Error("unsafe_file");
	const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const before = fstatSync(fd);
		if (!before.isFile() || before.size > maxBytes) throw new Error("file_limit");
		const buffer = Buffer.alloc(before.size + 1);
		let length = 0;
		while (length < buffer.length) {
			const count = readSync(fd, buffer, length, buffer.length - length, null);
			if (!count) break;
			length += count;
		}
		const bytes = buffer.subarray(0, length);
		const after = fstatSync(fd);
		if (bytes.length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("file_changed");
		return bytes;
	} finally { closeSync(fd); }
}

function stamp(path: string): string {
	const info = stat(path);
	if (!info) return "missing";
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe_file");
	return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(":");
}

async function openNativeSnapshot(path: string): Promise<CleanupSnapshotDatabase> {
	// A variable import keeps both native modules optional in the Node/Bun bundles.
	const moduleName = process.versions.bun ? "bun:sqlite" : "node:sqlite";
	const native = await import(moduleName);
	if (process.versions.bun) {
		const db = new native.Database(path, { readonly: true, create: false });
		return { all: (sql) => db.query(sql).all(), close: () => db.close(true) };
	}
	const db = new native.DatabaseSync(path, { readOnly: true });
	return { all: (sql) => db.prepare(sql).all(), close: () => db.close() };
}

async function readSummaries(base: string, open: NonNullable<CleanupPreviewOptions["openSnapshot"]>, warnings: string[]): Promise<Summary[] | undefined> {
	let scratch: string | undefined;
	let db: CleanupSnapshotDatabase | undefined;
	try {
		plainDirectory(base);
		const source = join(base, "conversation_summaries.db");
		if (!stat(source)) { warnings.push("summary_database_missing"); return undefined; }
		// A rollback journal means a multi-file snapshot is not safely interpretable.
		if (stat(`${source}-journal`)) throw new Error("journal_present");
		const paths = [source, `${source}-wal`];
		const before = paths.map(stamp);
		const copies = paths.map((path, index) => before[index] === "missing" ? undefined : readBounded(path, MAX_SNAPSHOT_BYTES));
		if (copies.reduce((sum, bytes) => sum + (bytes?.length ?? 0), 0) > MAX_SNAPSHOT_BYTES) throw new Error("snapshot_limit");
		if (paths.some((path, index) => stamp(path) !== before[index]) || stat(`${source}-journal`)) throw new Error("snapshot_changed");
		scratch = mkdtempSync(join(tmpdir(), "agy-cleanup-preview-"));
		const snapshot = join(scratch, "summaries.db");
		writeFileSync(snapshot, copies[0]!, { flag: "wx", mode: 0o600 });
		if (copies[1]) writeFileSync(`${snapshot}-wal`, copies[1], { flag: "wx", mode: 0o600 });
		// SQLite may create SHM files here, but never in the original state directory.
		db = await open(snapshot);
		const rows = db.all(`SELECT conversation_id AS conversationId,
			parent_conversation_id AS parentConversationId, last_modified_time AS modifiedAt,
			status, not_fully_idle AS notFullyIdle FROM conversation_summaries
			ORDER BY conversation_id LIMIT ${MAX_ENTRIES + 1}`);
		if (rows.length > MAX_ENTRIES) warnings.push("inventory_truncated");
		if (!rows.every((row) => row !== null && typeof row === "object" && UUID.test(String((row as Summary).conversationId)))) throw new Error("invalid_summary");
		return rows.slice(0, MAX_ENTRIES) as Summary[];
	} catch { warnings.push("summary_metadata_unavailable"); return undefined; }
	finally {
		try { db?.close(); }
		catch { warnings.push("snapshot_close_failed"); }
		if (scratch) {
			try { rmSync(scratch, { recursive: true, force: true }); }
			catch { warnings.push("snapshot_cleanup_failed"); }
		}
	}
}

function readBindings(stateDir: string, warnings: string[]): { ids: Set<string>; known: boolean } {
	const ids = new Set<string>();
	let known = true;
	for (const name of ["opencode-sessions.json", "pi-sessions.json"]) {
		try {
			plainDirectory(stateDir);
			const path = join(stateDir, name);
			if (stat(`${path}.lock`)) throw new Error("store_locked");
			if (!stat(path)) continue;
			const data = JSON.parse(readBounded(path, 4 * 1024 * 1024).toString("utf8"));
			if (!data || (data.version !== 1 && !(name === "opencode-sessions.json" && data.version === 2)) || !data.sessions || typeof data.sessions !== "object" || Array.isArray(data.sessions)) throw new Error("unknown_store");
			for (const value of Object.values(data.sessions)) {
				const entries = data.version === 2 ? value : [value];
				if (!Array.isArray(entries)) throw new Error("invalid_entries");
				for (const entry of entries) {
					if (!entry || typeof entry.conversationId !== "string" || !UUID.test(entry.conversationId)) throw new Error("invalid_binding");
					ids.add(entry.conversationId);
				}
			}
			if (stat(`${path}.lock`)) throw new Error("store_changed");
		} catch { known = false; warnings.push("binding_state_unavailable"); }
	}
	return { ids, known };
}

function filesystemIds(base: string, warnings: string[]): Set<string> {
	const ids = new Set<string>();
	for (const name of ["brain", "conversations"]) {
		try {
			const root = join(base, name);
			plainDirectory(root);
			if (!stat(root)) continue;
			const dir = opendirSync(root);
			try {
				let entry;
				while ((entry = dir.readSync())) {
					const id = name === "conversations" ? entry.name.replace(/\.db(?:-wal|-shm)?$/, "") : entry.name;
					if (UUID.test(id)) ids.add(id);
					if (ids.size > MAX_ENTRIES) { warnings.push("inventory_truncated"); break; }
				}
			} finally { dir.closeSync(); }
		} catch { warnings.push("filesystem_inventory_unavailable"); }
	}
	return ids;
}

function sizeOf(path: string, budget: { remaining: number }): number {
	const info = stat(path);
	if (!info) return 0;
	if (--budget.remaining < 0 || info.isSymbolicLink()) throw new Error("size_unavailable");
	if (info.isFile()) return info.size;
	if (!info.isDirectory()) throw new Error("size_unavailable");
	let total = 0;
	const dir = opendirSync(path);
	try {
		let entry;
		while ((entry = dir.readSync())) total += sizeOf(join(path, entry.name), budget);
	} finally { dir.closeSync(); }
	return total;
}

export async function previewCleanup(options: CleanupPreviewOptions = {}): Promise<CleanupPreview> {
	const allowed = new Set(["homeDir", "stateDir", "ttlDays", "now", "openSnapshot"]);
	for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`Unsupported cleanup preview option: ${key}`);
	const ttlDays = options.ttlDays ?? 7;
	validateTtl(ttlDays);
	const home = options.homeDir ?? homedir();
	const stateDir = options.stateDir ?? join(process.env.XDG_STATE_HOME ?? join(home, ".local", "state"), "agy-bridge");
	if (!isAbsolute(home) || !isAbsolute(stateDir)) throw new Error("Cleanup preview roots must be absolute");
	const now = (options.now ?? Date.now)();
	if (!Number.isFinite(now)) throw new Error("Invalid cleanup preview clock");
	const warnings: string[] = [];
	const base = join(home, ".gemini", "antigravity-cli");
	try { plainDirectory(join(home, ".gemini")); plainDirectory(base); }
	catch {
		return { readOnly: true, ttlDays, complete: false, warnings: ["unsafe_source_directory"], entries: [], totals: { inspected: 0, candidates: 0, protected: 0, estimatedCandidateBytes: 0 }, note: "Advisory snapshot only; no deletion is implemented or authorized." };
	}
	const summaries = await readSummaries(base, options.openSnapshot ?? openNativeSnapshot, warnings);
	const bindings = readBindings(stateDir, warnings);
	const ids = filesystemIds(base, warnings);
	const byId = new Map(summaries?.map((row) => [row.conversationId, row]));
	for (const id of byId.keys()) ids.add(id);
	if (ids.size > MAX_ENTRIES) warnings.push("inventory_truncated");
	const budget = { remaining: 10_000 };
	const entries: CleanupPreviewEntry[] = [];
	for (const conversationId of [...ids].sort().slice(0, MAX_ENTRIES)) {
		const row = byId.get(conversationId);
		const protectionReasons: string[] = [];
		const evidence: string[] = [];
		const parent = row?.parentConversationId;
		const native = typeof parent === "string" && UUID.test(parent) && parent !== conversationId;
		if (native) evidence.push("structured_parent");
		if (!row) protectionReasons.push("metadata_unavailable");
		if (!bindings.known) protectionReasons.push("unknown_binding_state");
		if (bindings.ids.has(conversationId)) protectionReasons.push("bridge_binding");
		try {
			const lockDir = join(stateDir, "conversation-locks");
			plainDirectory(lockDir);
			// Inspect the existing lock naming contract without acquiring or pruning it.
			const hash = createHash("sha256").update(conversationId).digest("hex");
			if (stat(join(lockDir, `${hash}.lock`))) protectionReasons.push("conversation_lock");
		} catch { protectionReasons.push("unknown_lock_state"); warnings.push("lock_state_unavailable"); }
		if (row?.notFullyIdle === 1 || row?.status === "ACTIVE" || row?.status === "CASCADE_RUN_STATUS_RUNNING") protectionReasons.push("active");
		else if (row && (row.notFullyIdle !== 0 || !IDLE_STATUSES.has(String(row.status)))) protectionReasons.push("unknown_activity");
		const time = parseSummaryTime(row?.modifiedAt);
		const modifiedAt = Number.isFinite(time) ? new Date(time).toISOString() : null;
		if (!Number.isFinite(time) || time <= 0 || time > now) protectionReasons.push("unknown_date");
		else if (time > now - ttlDays * DAY) protectionReasons.push("within_retention");
		let estimatedBytes: number | null = null;
		try {
			plainDirectory(join(base, "brain")); plainDirectory(join(base, "conversations"));
			estimatedBytes = sizeOf(join(base, "brain", conversationId), budget);
			for (const ext of [".db", ".db-wal", ".db-shm"]) estimatedBytes += sizeOf(join(base, "conversations", `${conversationId}${ext}`), budget);
		} catch { estimatedBytes = null; protectionReasons.push("filesystem_unavailable"); warnings.push("size_estimate_unavailable"); }
		entries.push({ conversationId, category: native ? "native_subagent" : "unclassified", disposition: protectionReasons.length ? "protected" : native ? "candidate" : "unclassified", evidence, protectionReasons, modifiedAt, estimatedBytes });
	}
	return {
		readOnly: true, ttlDays, complete: warnings.length === 0, warnings: [...new Set(warnings)], entries,
		totals: { inspected: entries.length, candidates: entries.filter((e) => e.disposition === "candidate").length, protected: entries.filter((e) => e.disposition === "protected").length, estimatedCandidateBytes: entries.reduce((sum, e) => sum + (e.disposition === "candidate" ? e.estimatedBytes ?? 0 : 0), 0) },
		note: "Advisory snapshot only; no deletion is implemented or authorized. Missing evidence is protected. MCP configuration and transcript content are not inspected.",
	};
}
