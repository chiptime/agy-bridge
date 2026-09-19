/**
 * Cross-process, per-conversation exclusion lock shared by BOTH host
 * adapters (opencode + pi): before a turn RESUMES a known agy conversation,
 * runTurn acquires the lock for that conversation id so two concurrent
 * requests can never drive the same agy conversation at once. Zero host
 * imports — engine-host-agnostic by contract.
 *
 * Mechanics mirror the proven session-store lock: the lock file lives at
 * `<lockDir>/<sha256(key)>.lock` (hex name — conversation keys are opaque
 * ids and NEVER become raw filename bytes, PRD section 3), is created
 * exclusively with openSync(..., "wx") mode 0o600 (owner-restricted), and
 * holds JSON `{pid, acquiredAt}`. Contention is resolved by bounded
 * polling (pollMs up to waitMs, then ConversationBusyError); the lock is
 * taken over ONLY when the holder is provably gone — its recorded pid is
 * dead (process.kill(pid, 0) → ESRCH) OR the file mtime is older than
 * staleMs (crash-recovery fallback; a racing takeover re-arbitrates via
 * the exclusive create).
 *
 * Honest limits (by design, not by accident):
 * - Same-machine only: pid liveness means nothing across hosts, and an
 *   NFS/network filesystem gives no O_EXCL or mtime guarantees.
 * - A recycled pid can briefly force a false "busy": the recorded pid
 *   exists (as someone else) until the lock ages past staleMs — which is
 *   why staleMs defaults to ONE HOUR, deliberately longer than the
 *   worst-case legitimate hold (two attempts × timeoutMs + termination
 *   bounds), so staleness can never steal a live run's lock.
 */
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Total time spent waiting for the lock before giving up (bounded busy wait). */
export const CONVERSATION_LOCK_WAIT_MS = 3_000;
/**
 * Lock age beyond which the holder is presumed dead. Must comfortably
 * exceed the worst-case legitimate hold (two attempts at timeoutMs each
 * plus the termination bounds) so a live run is never stolen from.
 */
export const CONVERSATION_LOCK_STALE_MS = 60 * 60 * 1000;
/** Poll interval while waiting for a fresh lock. */
export const CONVERSATION_LOCK_POLL_MS = 20;

/** Thrown when the lock could not be acquired within the bounded wait. */
export class ConversationBusyError extends Error {
	constructor(
		readonly conversationKey: string,
		readonly lockPath: string,
	) {
		super(
			`conversation busy: another agy request holds the lock for conversation ${conversationKey} (not acquired within the bounded wait): ${lockPath}`,
		);
		this.name = "ConversationBusyError";
	}
}

export interface ConversationLockOptions {
	/** Bounded wait for the lock. Default CONVERSATION_LOCK_WAIT_MS. */
	waitMs?: number;
	/** Lock age treated as stale (holder presumed dead). Default CONVERSATION_LOCK_STALE_MS. */
	staleMs?: number;
	/** Poll interval while waiting. Default CONVERSATION_LOCK_POLL_MS. */
	pollMs?: number;
	/** Wall-clock seam. Default Date.now. */
	now?: () => number;
	/** Holder-pid liveness seam. Default process.kill(pid, 0). */
	isPidAlive?: (pid: number) => boolean;
}

export interface ConversationLock {
	/** Delete the lock file. Tolerates ENOENT (a stale takeover may already have removed it); NEVER throws. */
	release(): void;
}

/** Default pid liveness: signal 0 probes existence without delivering a signal. */
function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH: no such process — provably dead. EPERM: the process EXISTS
		// (permission denied) — treat as alive.
		return (err as NodeJS.ErrnoException)?.code !== "ESRCH";
	}
}

/** Undo a half-acquired lock (write failure path): close and best-effort unlink, never throw. */
function abandonLock(lockPath: string, fd: number): void {
	try {
		closeSync(fd);
	} catch {
		/* already closed */
	}
	try {
		unlinkSync(lockPath);
	} catch {
		/* best effort */
	}
}

/**
 * Acquire the per-conversation exclusion lock for `key`, waiting at most
 * `waitMs`. Exclusive create (O_EXCL) is the cross-process arbiter; on
 * EEXIST the holder is either alive (recorded pid alive AND mtime fresh →
 * poll until the deadline) or provably gone (dead pid OR stale mtime →
 * unlink and retry the create, which re-arbitrates a takeover race
 * between two waiters).
 */
export async function acquireConversationLock(
	lockDir: string,
	key: string,
	opts: ConversationLockOptions = {},
): Promise<ConversationLock> {
	const waitMs = opts.waitMs ?? CONVERSATION_LOCK_WAIT_MS;
	const staleMs = opts.staleMs ?? CONVERSATION_LOCK_STALE_MS;
	const pollMs = opts.pollMs ?? CONVERSATION_LOCK_POLL_MS;
	const nowMs = opts.now ?? Date.now;
	const isPidAlive = opts.isPidAlive ?? defaultIsPidAlive;
	// Hex sha256 of the opaque key: raw conversation ids never become
	// filename bytes (PRD section 3).
	const lockPath = join(lockDir, `${createHash("sha256").update(key).digest("hex")}.lock`);
	mkdirSync(lockDir, { recursive: true, mode: 0o700 });
	const deadline = nowMs() + waitMs;
	// The vanished-between-create-and-stat path retries the create WITHOUT
	// sleeping (the lock is free — take it now); the spin cap keeps that
	// tight loop bounded even under a mocked constant clock.
	let vanishedSpins = 0;
	for (;;) {
		let fd: number | undefined;
		try {
			fd = openSync(lockPath, "wx", 0o600);
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
		}
		if (fd !== undefined) {
			try {
				writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
			} catch (err) {
				abandonLock(lockPath, fd);
				throw err;
			}
			closeSync(fd);
			return {
				release: () => {
					try {
						unlinkSync(lockPath);
					} catch {
						/* ENOENT after another waiter's stale takeover, or any
						   release race — a release NEVER throws by contract. */
					}
				},
			};
		}
		// Contended. Take over ONLY on provable holder death.
		let holderGone = false;
		try {
			const holder = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
			if (typeof holder?.pid === "number" && !isPidAlive(holder.pid)) holderGone = true;
		} catch {
			/* unreadable/corrupt record — the mtime fallback decides below */
		}
		if (!holderGone) {
			try {
				if (nowMs() - statSync(lockPath).mtimeMs > staleMs) holderGone = true;
			} catch {
				// Vanished between the failed create and the stat: retry the
				// create immediately, bounded by the deadline and the spin cap.
				if (nowMs() >= deadline || ++vanishedSpins > 10_000) {
					throw new ConversationBusyError(key, lockPath);
				}
				continue;
			}
		}
		if (holderGone) {
			try {
				unlinkSync(lockPath);
			} catch {
				/* another waiter already removed it */
			}
			continue; // the exclusive create re-arbitrates the takeover
		}
		if (nowMs() >= deadline) throw new ConversationBusyError(key, lockPath);
		await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
	}
}
