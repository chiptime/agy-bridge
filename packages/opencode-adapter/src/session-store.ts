/**
 * Session-map store (spec R7): opencode session id → agy conversation id in
 * `<state>/agy-bridge/opencode-sessions.json`. Every read-modify-write cycle
 * is serialized at three levels:
 *
 * 1. In-process mutexes — a global chain (file I/O) plus per-session keyed
 *    chains (same-session turns), unchanged from v1.
 * 2. A cross-process lockfile — each opencode instance is a SEPARATE OS
 *    process, so mutexes alone still let two read-modify-write cycles
 *    interleave (A reads, B reads, A writes, B writes → A's binding is
 *    lost). Before touching the file, the store takes `<state-file>.lock`
 *    via an exclusive create (`openSync(lockPath, "wx")`, i.e. O_EXCL) and
 *    releases it in a `finally` (close fd + unlink, tolerating ENOENT), so
 *    every op — pure reads included — reads and publishes a consistent
 *    whole-file view. O_EXCL is the arbiter because it is atomic across
 *    processes and needs no native flock dependency.
 * 3. Atomic temp-file + rename writes, so concurrent writers or a crash
 *    mid-write never leave partial JSON.
 *
 * Lock contract (bounded wait): acquisition retries every 20ms for at most
 * 3000ms; if the lock is still held, it throws `SessionStoreBusyError`
 * naming the lock path (failing a turn fast beats blocking it forever). A
 * lock whose mtime is older than 3000ms is STALE — its holder died before
 * releasing (e.g. SIGKILL) — so it is unlinked and taken over instead of
 * deadlocking the store for every future process. The 3000ms stale age is
 * safe because a locked section is read + stringify + write + rename —
 * milliseconds; a holder genuinely stuck longer could have its lock stolen,
 * and the atomic rename still prevents corruption (the residual race — a
 * stale holder later unlinking a successor's lock — is accepted: the next
 * acquirer re-creates the file and O_EXCL re-arbitrates).
 *
 * Entries older than 30 days are pruned on load and on bind; a missing or
 * corrupt file is treated as empty and replaced atomically.
 *
 * v1.1 divergence baseline: each entry optionally carries `hashes` — the
 * ordered per-message hashes of the opencode prompt array AS FORWARDED for
 * that conversation (messages.messageHashes). Entries written before v1.1
 * have no hashes (unknown baseline): the adapter adopts them as-is for one
 * turn, then stores a baseline and protection is active.
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

export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Total time spent waiting for the cross-process lock before giving up. */
export const LOCK_WAIT_MS = 3000;
/** Lock age beyond which its holder is presumed dead and the lock is taken over. */
export const LOCK_STALE_MS = 3000;
/** Poll interval while waiting for a fresh lock. */
export const LOCK_POLL_MS = 20;

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
		get: (sessionId) => chain(globalSlot, () => withFileLock(() => load().sessions[sessionId]?.conversationId)),
		getEntry: (sessionId) =>
			chain(globalSlot, () =>
				withFileLock(() => {
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
			),
		bind: (sessionId, conversationId, hashes) =>
			chain(keyedSlot(sessionId), () =>
				chain(globalSlot, () =>
					withFileLock(() => {
						const file = load();
						file.sessions[sessionId] = {
							conversationId,
							updatedAt: new Date().toISOString(),
							...(hashes !== undefined ? { hashes } : {}),
						};
						persist(file);
					}),
				),
			),
		rebind: (sessionId) =>
			chain(keyedSlot(sessionId), () =>
				chain(globalSlot, () =>
					withFileLock(() => {
						const file = load();
						delete file.sessions[sessionId];
						persist(file);
					}),
				),
			),
		prune: (now = new Date()) =>
			chain(globalSlot, () =>
				withFileLock(() => {
					const file = load();
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
