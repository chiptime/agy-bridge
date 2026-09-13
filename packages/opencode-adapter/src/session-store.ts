/**
 * Schema v2 (multi-conversation store): one opencode sessionID issues
 * MULTIPLE model calls (side agents, compaction, future features), so each
 * session maps to a LIST of conversation bindings instead of a single one.
 * A binding is `{ conversationId, hashes?, updatedAt }`. v1 files migrate
 * transparently: each old single entry loads wrapped as a one-element list;
 * malformed entries degrade to an empty store (same tolerance as v1).
 *
 * Prefix routing (`resolve`): the incoming turn hashes pick WHICH binding
 * this call continues — the binding whose baseline hashes are a prefix of
 * the incoming ones (longest prefix wins); else a binding WITHOUT hashes
 * (pre-upgrade adopt-once); else undefined → fresh conversation.
 *
 * Binding (`bind`): upsert semantics — same conversationId updates in
 * place; a binding whose hashes are a prefix of the new hashes is
 * REPLACED in place (a linear continuation rewrites its parent);
 * otherwise the new binding is APPENDED. The list is capped at
 * MAX_BINDINGS_PER_SESSION (3), evicting the oldest by updatedAt.
 */
import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { hashesArePrefix } from "./messages";

export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Total time spent waiting for the cross-process lock before giving up. */
export const LOCK_WAIT_MS = 3000;
/** Lock age beyond which its holder is presumed dead and the lock is taken over. */
export const LOCK_STALE_MS = 3000;
/** Poll interval while waiting for a fresh lock. */
export const LOCK_POLL_MS = 20;
/** Max conversation bindings kept per opencode session (oldest evicted). */
export const MAX_BINDINGS_PER_SESSION = 3;

/** Thrown when the cross-process lock could not be acquired within LOCK_WAIT_MS. */
export class SessionStoreBusyError extends Error {
	constructor(readonly lockPath: string) {
		super(`session store busy: lock not acquired within ${LOCK_WAIT_MS}ms: ${lockPath}`);
		this.name = "SessionStoreBusyError";
	}
}

export interface SessionEntry {
	conversationId: string;
	/** Divergence baseline: ordered hashes of the forwarded prompt array. Absent on pre-upgrade entries (unknown baseline). */
	hashes?: string[];
}

interface StoredEntry extends SessionEntry {
	updatedAt: string;
}
interface StoreFile {
	version: 2;
	sessions: Record<string, StoredEntry[]>;
}

export interface SessionStore {
	get(sessionId: string): Promise<string | undefined>;
	/** Latest binding (by updatedAt) for the session; undefined when unbound. */
	getEntry(sessionId: string): Promise<SessionEntry | undefined>;
	/**
	 * v2 prefix routing: the binding this incoming call continues — whose
	 * hashes are a prefix of incomingHashes (longest prefix wins), else a
	 * binding without hashes (adopt-once), else undefined (fresh conversation).
	 */
	resolve(sessionId: string, incomingHashes: string[]): Promise<SessionEntry | undefined>;
	/**
	 * v2 upsert: same conversationId updates in place; a binding whose
	 * hashes prefix the new ones is replaced (linear continuation rewrites
	 * its parent); otherwise appended. List capped at MAX_BINDINGS_PER_SESSION.
	 */
	bind(sessionId: string, conversationId: string, hashes?: string[]): Promise<void>;
	/** Drop ONLY the named failed binding; without a conversationId, drop ALL bindings for the session. */
	rebind(sessionId: string, conversationId?: string): Promise<void>;
	/** Drop bindings older than 30 days; returns the pruned count. */
	prune(now?: Date): Promise<number>;
}

/** Lock tuning and clock/sleep seams (mainly for tests); all fields optional. */
export interface SessionStoreOptions {
	/** Bounded wait for the cross-process lock. Default LOCK_WAIT_MS. */
	lockWaitMs?: number;
	/** Lock age treated as stale (holder presumed dead). Default LOCK_STALE_MS. */
	lockStaleMs?: number;
	/** Wall clock seam. Default Date.now. */
	now?: () => number;
	/** Retry sleep seam. Default a LOCK_POLL_MS setTimeout. */
	sleep?: (ms: number) => Promise<void>;
}

/** A stored binding is valid when it has a string conversationId; hashes and updatedAt are sanitized separately. */
function validEntry(value: unknown): value is StoredEntry {
	if (typeof value !== "object" || value === null) return false;
	const rec = value as Record<string, unknown>;
	return typeof rec["conversationId"] === "string";
}

function parseStore(raw: string): StoreFile {
	const empty: StoreFile = { version: 2, sessions: {} };
	try {
		const parsed = JSON.parse(raw) as Partial<StoreFile> & { sessions?: unknown };
		if (typeof parsed?.sessions !== "object" || parsed.sessions === null) return empty;
		const sessions: Record<string, StoredEntry[]> = {};
		if (parsed.version === 2) {
			for (const [id, list] of Object.entries(parsed.sessions as Record<string, unknown>)) {
				if (!Array.isArray(list)) continue;
				const kept = list.filter(validEntry);
				if (kept.length > 0) sessions[id] = kept;
			}
			return { version: 2, sessions };
		}
		if (parsed.version === 1) {
			// Migration v1→v2: each single entry wraps as a one-element list.
			for (const [id, entry] of Object.entries(parsed.sessions as Record<string, unknown>)) {
				if (validEntry(entry)) sessions[id] = [entry];
			}
			return { version: 2, sessions };
		}
	} catch {
		/* corrupt → empty */
	}
	return empty;
}

export function openSessionStore(path: string, options: SessionStoreOptions = {}): SessionStore {
	const lockPath = `${path}.lock`;
	const lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
	const lockStaleMs = options.lockStaleMs ?? LOCK_STALE_MS;
	const nowMs = options.now ?? Date.now;
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

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
	const load = (withPrune = true): StoreFile => {
		let file: StoreFile;
		try {
			file = parseStore(readFileSync(path, "utf8"));
		} catch {
			return { version: 2, sessions: {} };
		}
		if (withPrune) pruneInPlace(file, Date.now());
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
		for (const [id, list] of Object.entries(file.sessions)) {
			const kept = list.filter((entry) => {
				const stale = !entry?.updatedAt || new Date(entry.updatedAt).getTime() <= now - SESSION_MAX_AGE_MS;
				if (stale) pruned++;
				return !stale;
			});
			if (kept.length === 0) delete file.sessions[id];
			else file.sessions[id] = kept;
		}
		return pruned;
	};
	// Sanitize a stored binding for the public surface: a non-array or
	// non-string-element hashes field degrades to unknown baseline (thin
	// defense against a hand-edited file).
	const publicEntry = (entry: StoredEntry): SessionEntry => {
		const hashes = Array.isArray(entry.hashes)
			? entry.hashes.filter((h): h is string => typeof h === "string")
			: undefined;
		return hashes === undefined
			? { conversationId: entry.conversationId }
			: { conversationId: entry.conversationId, hashes };
	};
	/** Latest binding by updatedAt (iso strings sort chronologically). */
	const latest = (list: StoredEntry[]): StoredEntry | undefined =>
		list.reduce<StoredEntry | undefined>(
			(best, e) => (!best || (e.updatedAt ?? "") >= (best.updatedAt ?? "") ? e : best),
			undefined,
		);
	// Release must tolerate ENOENT: a stale takeover by another waiter may
	// already have removed our aged-out lock file.
	const releaseLock = (fd: number): void => {
		closeSync(fd);
		try {
			unlinkSync(lockPath);
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
		}
	};
	// Exclusive create (O_EXCL) is the cross-process arbiter: atomic at the
	// OS level, no native flock dependency. On EEXIST the holder is either
	// alive (mtime fresh → poll, bounded by lockWaitMs → SessionStoreBusyError)
	// or dead (mtime older than lockStaleMs → unlink and take over, so a
	// crashed process can never deadlock the store). If two waiters race to
	// steal the same stale lock, O_EXCL re-arbitrates the takeover.
	const acquireLock = async (): Promise<number> => {
		const deadline = nowMs() + lockWaitMs;
		for (;;) {
			// The lock lives next to the state file, so the directory must
			// exist before the first exclusive create (recursive mkdir is
			// idempotent; persist's own mkdir stays as belt and braces).
			mkdirSync(dirname(path), { recursive: true });
			let fd: number | undefined;
			try {
				fd = openSync(lockPath, "wx");
			} catch (err) {
				if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
			}
			if (fd !== undefined) {
				try {
					writeSync(fd, `${process.pid}\n`); // holder pid: diagnostics for stale locks
					return fd;
				} catch (err) {
					try {
						releaseLock(fd);
					} catch {
						/* best effort — the create itself already succeeded */
					}
					throw err;
				}
			}
			let fresh: boolean;
			try {
				fresh = nowMs() - statSync(lockPath).mtimeMs <= lockStaleMs;
			} catch {
				// Vanished between the failed create and the stat: retry the
				// create immediately, but stay inside the bounded wait.
				if (nowMs() >= deadline) throw new SessionStoreBusyError(lockPath);
				continue;
			}
			if (!fresh) {
				try {
					unlinkSync(lockPath);
				} catch {
					/* another waiter already removed it */
				}
				continue;
			}
			if (nowMs() >= deadline) throw new SessionStoreBusyError(lockPath);
			await sleep(LOCK_POLL_MS);
		}
	};
	// Every op — mutating read-modify-write AND pure read — runs under the
	// file lock so a cycle never interleaves with another process's cycle:
	// lock → read fresh → (mutate) → atomic rename → unlock. The `finally`
	// guarantees the lock dies with the op even when the body throws. The
	// body is synchronous, so Promise<T> (not Awaited<T>) is exact.
	const withFileLock = async <T>(fn: () => T): Promise<T> => {
		const fd = await acquireLock();
		try {
			return fn();
		} finally {
			releaseLock(fd);
		}
	};
	return {
		get: (sessionId) =>
			chain(globalSlot, () => withFileLock(() => latest(load().sessions[sessionId] ?? [])?.conversationId)),
		getEntry: (sessionId) =>
			chain(globalSlot, () =>
				withFileLock(() => {
					const entry = latest(load().sessions[sessionId] ?? []);
					return entry ? publicEntry(entry) : undefined;
				}),
			),
		resolve: (sessionId, incomingHashes) =>
			chain(globalSlot, () =>
				withFileLock(() => {
					const list = load().sessions[sessionId] ?? [];
					// Longest strict-prefix baseline wins; a hashes-less binding is
					// the adopt-once fallback; anything else is a fresh conversation.
					let best: StoredEntry | undefined;
					let bestLen = -1;
					let adopt: StoredEntry | undefined;
					for (const entry of list) {
						const hashes = Array.isArray(entry.hashes)
							? entry.hashes.filter((h): h is string => typeof h === "string")
							: undefined;
						if (hashes !== undefined && hashes.length > 0 && hashesArePrefix(hashes, incomingHashes)) {
							if (hashes.length > bestLen) {
								best = entry;
								bestLen = hashes.length;
							}
						} else if (hashes === undefined && adopt === undefined) {
							adopt = entry;
						}
					}
					const pick = best ?? adopt;
					return pick ? publicEntry(pick) : undefined;
				}),
			),
		bind: (sessionId, conversationId, hashes) =>
			chain(keyedSlot(sessionId), () =>
				chain(globalSlot, () =>
					withFileLock(() => {
						const file = load();
						const list = file.sessions[sessionId] ?? [];
						const updatedAt = new Date().toISOString();
						const next = hashes !== undefined ? { hashes } : {};
						// Upsert-by-conversationId: same conversation updates in place.
						const sameIdx = list.findIndex((e) => e.conversationId === conversationId);
						if (sameIdx >= 0) {
							list[sameIdx] = { conversationId, updatedAt, ...next };
						} else {
							// Linear continuation: a binding whose hashes prefix the new
							// ones IS this conversation's parent — replace it in place.
							const prefixIdx =
								hashes !== undefined
									? list.findIndex(
											(e) =>
											Array.isArray(e.hashes) &&
											e.hashes.length > 0 &&
											hashesArePrefix(e.hashes, hashes),
										)
									: -1;
							if (prefixIdx >= 0) {
								list[prefixIdx] = { conversationId, updatedAt, ...next };
							} else {
								list.push({ conversationId, updatedAt, ...next });
							}
						}
						// Cap the list: evict oldest by updatedAt (never the just-bound one).
						while (list.length > MAX_BINDINGS_PER_SESSION) {
							let oldestIdx = 0;
							for (let i = 1; i < list.length; i++) {
								if ((list[i].updatedAt ?? "") < (list[oldestIdx].updatedAt ?? "")) oldestIdx = i;
							}
							list.splice(oldestIdx, 1);
						}
						file.sessions[sessionId] = list;
						persist(file);
					}),
				),
			),
		rebind: (sessionId, conversationId) =>
			chain(keyedSlot(sessionId), () =>
				chain(globalSlot, () =>
					withFileLock(() => {
						const file = load();
						if (conversationId === undefined) {
							if (file.sessions[sessionId] === undefined) return;
							delete file.sessions[sessionId];
						} else {
							const list = file.sessions[sessionId];
							if (!list) return;
							const kept = list.filter((e) => e.conversationId !== conversationId);
							if (kept.length === list.length) return; // nothing dropped
							if (kept.length === 0) delete file.sessions[sessionId];
							else file.sessions[sessionId] = kept;
						}
						persist(file);
					}),
				),
			),
		prune: (now = new Date()) =>
			chain(globalSlot, () =>
				withFileLock(() => {
					// Load WITHOUT the implicit prune so this op can count what it
					// removes itself, then persist the pruned view.
					const file = load(false);
					const pruned = pruneInPlace(file, now.getTime());
					if (pruned > 0) persist(file);
					return pruned;
				}),
			),
	};
	function keyedSlot(sessionId: string): { current: Promise<unknown> } {
		let slot = keyed.get(sessionId);
		if (!slot) keyed.set(sessionId, (slot = { current: Promise.resolve() }));
		return slot;
	}
}
