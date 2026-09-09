/**
 * Session-map store (spec R7): opencode session id → agy conversation id in
 * `<state>/agy-bridge/opencode-sessions.json`. Every file mutation runs
 * under a process-wide mutex (serializes I/O within this process) and a
 * per-session keyed mutex (serializes same-session turns); writes are
 * temp-file + rename so concurrent writers never leave partial JSON.
 * Entries older than 30 days are pruned on load and on bind; a missing or
 * corrupt file is treated as empty and replaced atomically.
 *
 * v1.1 divergence baseline: each entry optionally carries `hashes` — the
 * ordered per-message hashes of the opencode prompt array AS FORWARDED for
 * that conversation (messages.messageHashes). Entries written before v1.1
 * have no hashes (unknown baseline): the adapter adopts them as-is for one
 * turn, then stores a baseline and protection is active.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionEntry {
	conversationId: string;
	/** Divergence baseline: ordered hashes of the forwarded prompt array. Absent on pre-upgrade entries (unknown baseline). */
	hashes?: string[];
}

interface StoredEntry extends SessionEntry {
	updatedAt: string;
}
interface StoreFile {
	version: 1;
	sessions: Record<string, StoredEntry>;
}

export interface SessionStore {
	get(sessionId: string): Promise<string | undefined>;
	/** Full entry including the v1.1 divergence baseline; undefined when unbound. */
	getEntry(sessionId: string): Promise<SessionEntry | undefined>;
	bind(sessionId: string, conversationId: string, hashes?: string[]): Promise<void>;
	/** Failed resume → drop the mapping so the next turn runs fresh. */
	rebind(sessionId: string): Promise<void>;
	/** Drop entries older than 30 days; returns the pruned count. */
	prune(now?: Date): Promise<number>;
}

function parseStore(raw: string): StoreFile {
	try {
		const parsed = JSON.parse(raw) as Partial<StoreFile>;
		if (parsed?.version === 1 && typeof parsed.sessions === "object" && parsed.sessions !== null) {
			return { version: 1, sessions: parsed.sessions };
		}
	} catch {
		/* corrupt → empty */
	}
	return { version: 1, sessions: {} };
}

export function openSessionStore(path: string): SessionStore {
	// Promise chains: the global chain serializes file I/O, the keyed chains
	// serialize same-session operations. Prior errors are swallowed so one
	// failed op never poisons the chain.
	const globalSlot = { current: Promise.resolve() as Promise<unknown> };
	const keyed = new Map<string, { current: Promise<unknown> }>();
	const chain = <T>(slot: { current: Promise<unknown> }, fn: () => T | PromiseLike<T>): Promise<Awaited<T>> => {
		const run = slot.current.then(fn, fn) as Promise<Awaited<T>>;
		slot.current = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};
	// Every load prunes: stale entries are invisible to get AND dropped from
	// the file by the next mutating op (bind persists the pruned view).
	const load = (): StoreFile => {
		let file: StoreFile;
		try {
			file = parseStore(readFileSync(path, "utf8"));
		} catch {
			return { version: 1, sessions: {} };
		}
		pruneInPlace(file, Date.now());
		return file;
	};
	const persist = (file: StoreFile): void => {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = join(dirname(path), `.${Math.random().toString(36).slice(2)}-${process.pid}-${randomUUID()}.tmp`);
		writeFileSync(tmp, `${JSON.stringify(file, null, "\t")}\n`);
		renameSync(tmp, path);
	};
	const pruneInPlace = (file: StoreFile, now: number): number => {
		let pruned = 0;
		for (const [id, entry] of Object.entries(file.sessions)) {
			if (!entry?.updatedAt || new Date(entry.updatedAt).getTime() <= now - SESSION_MAX_AGE_MS) {
				delete file.sessions[id];
				pruned++;
			}
		}
		return pruned;
	};
	return {
		get: (sessionId) => chain(globalSlot, () => load().sessions[sessionId]?.conversationId),
		getEntry: (sessionId) =>
			chain(globalSlot, () => {
				const entry = load().sessions[sessionId];
				if (!entry) return undefined;
				// Thin defense against a hand-edited file: a non-array or
				// non-string-element hashes field degrades to unknown baseline.
				const hashes = Array.isArray(entry.hashes)
					? entry.hashes.filter((h): h is string => typeof h === "string")
					: undefined;
				return hashes === undefined
					? { conversationId: entry.conversationId }
					: { conversationId: entry.conversationId, hashes };
			}),
		bind: (sessionId, conversationId, hashes) =>
			chain(keyedSlot(sessionId), () =>
				chain(globalSlot, () => {
					const file = load();
					file.sessions[sessionId] = {
						conversationId,
						updatedAt: new Date().toISOString(),
						...(hashes !== undefined ? { hashes } : {}),
					};
					persist(file);
				}),
			),
		rebind: (sessionId) =>
			chain(keyedSlot(sessionId), () =>
				chain(globalSlot, () => {
					const file = load();
					delete file.sessions[sessionId];
					persist(file);
				}),
			),
		prune: (now = new Date()) =>
			chain(globalSlot, () => {
				const file = load();
				const pruned = pruneInPlace(file, now.getTime());
				if (pruned > 0) persist(file);
				return pruned;
			}),
	};
	function keyedSlot(sessionId: string): { current: Promise<unknown> } {
		let slot = keyed.get(sessionId);
		if (!slot) keyed.set(sessionId, (slot = { current: Promise.resolve() }));
		return slot;
	}
}
