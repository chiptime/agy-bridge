/**
 * Lifecycle recycle registry (spec R6, design #3). The bridge's
 * IN-MEMORY layer in front of the persisted session store:
 *
 * - binding read-cache: defined entries only (an unbound key re-reads
 *   the store so another process's bind is never shadowed);
 * - per-key single-flight lookup slots: concurrent lookups of the same
 *   key share one store read;
 * - in-flight turn tracking (identity-tokened: an overlapped turn can
 *   never end its successor's registration);
 * - the 24h models discovery cache — the documented EXCEPTION: it
 *   survives recycle because `agy models` is a slow external probe and
 *   /reload's dedicated rebuild path refreshes it instead.
 *
 * pi's SessionStartEvent / SessionShutdownEvent carry NO session id
 * (only `reason`), so per-key clearing is impossible by construction:
 * both handlers clear ALL in-memory state for ANY reason
 * (start: startup|reload|new|resume|fork; shutdown: quit|reload|new|
 * resume|fork) and never latch — state repopulates on the next turn.
 * Persisted pi-sessions.json rows are untouched: they are keyed by
 * `options.sessionId ?? cwd` re-read per turn. `reason:"reload"` on
 * session_start fires the injected rebuildDiscovery seam.
 */
import type { SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import type { DiscoveredEntry } from "./models";
import type { SessionEntry, SessionStore } from "./session-store";

/** Design #3 / R2: discovery is cached for 24h; only /reload (or TTL expiry) rebuilds. */
export const DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

/** One live turn: the registration token endTurn must match to remove it. */
export interface InFlightTurn {
	sessionKey: string;
	startedAt: number;
	/** Tapped agy conversation id, once one is known. */
	conversationId?: string;
}

export interface DiscoverySnapshot {
	rows: readonly DiscoveredEntry[];
	fetchedAt: number;
	ageMs: number;
	fresh: boolean;
}

export interface BridgeStateSnapshot {
	cachedBindings: number;
	pendingLookups: number;
	inFlightTurns: number;
}

export interface BridgeState {
	/** Cached-or-store binding lookup with per-key single flight; undefined results are never cached. */
	lookupBinding(store: SessionStore, key: string): Promise<SessionEntry | undefined>;
	/** Coherence hook for bind sites: replace the cached entry. */
	cacheBinding(key: string, entry: SessionEntry): void;
	/** Coherence hook for rebind/clear sites: drop the cached entry. */
	dropBinding(key: string): void;
	/** Register an in-flight turn; the returned token removes it via endTurn. */
	beginTurn(key: string, now?: number): InFlightTurn;
	/** Remove a turn registration, but only if `turn` is still the live one. */
	endTurn(key: string, turn: InFlightTurn): void;
	currentTurn(key: string): InFlightTurn | undefined;
	/** Attach a tapped conversation id to the live turn for that key. */
	noteConversationId(key: string, conversationId: string): void;
	/** Cache one discovery round (the raw rows, not the collapsed registry). */
	setDiscovery(rows: readonly DiscoveredEntry[], now?: number): void;
	discoverySnapshot(now?: number): DiscoverySnapshot | undefined;
	/** Clear ALL in-memory state (R6). The discovery cache survives. */
	recycle(): void;
	/** Size report for tests and /agy status. */
	snapshot(): BridgeStateSnapshot;
}

export function createBridgeState(): BridgeState {
	const bindingCache = new Map<string, SessionEntry>();
	const pendingLookups = new Map<string, Promise<SessionEntry | undefined>>();
	const inFlightTurns = new Map<string, InFlightTurn>();
	let discovery: { rows: readonly DiscoveredEntry[]; fetchedAt: number } | undefined;

	return {
		async lookupBinding(store, key) {
			const hit = bindingCache.get(key);
			if (hit !== undefined) return hit;
			const shared = pendingLookups.get(key);
			if (shared !== undefined) return shared;
			// The flight closure compares against its own registration; it
			// only runs that check after the first await, by which point
			// `flight` is assigned and registered below.
			let flight!: Promise<SessionEntry | undefined>;
			flight = (async () => {
				const entry = await store.getEntry(key);
				// Identity guard: a recycle that cleared our slot means this
				// late result must not resurrect recycled state.
				if (pendingLookups.get(key) === flight) {
					pendingLookups.delete(key);
					if (entry !== undefined) bindingCache.set(key, entry);
				}
				return entry;
			})();
			pendingLookups.set(key, flight);
			return flight;
		},
		cacheBinding(key, entry) {
			bindingCache.set(key, entry);
		},
		dropBinding(key) {
			bindingCache.delete(key);
		},
		beginTurn(key, now = Date.now()) {
			const turn: InFlightTurn = { sessionKey: key, startedAt: now };
			inFlightTurns.set(key, turn);
			return turn;
		},
		endTurn(key, turn) {
			if (inFlightTurns.get(key) === turn) inFlightTurns.delete(key);
		},
		currentTurn(key) {
			return inFlightTurns.get(key);
		},
		noteConversationId(key, conversationId) {
			const turn = inFlightTurns.get(key);
			if (turn !== undefined) turn.conversationId = conversationId;
		},
		setDiscovery(rows, now = Date.now()) {
			discovery = { rows, fetchedAt: now };
		},
		discoverySnapshot(now = Date.now()) {
			if (discovery === undefined) return undefined;
			const ageMs = now - discovery.fetchedAt;
			return { rows: discovery.rows, fetchedAt: discovery.fetchedAt, ageMs, fresh: ageMs < DISCOVERY_TTL_MS };
		},
		recycle() {
			bindingCache.clear();
			pendingLookups.clear();
			inFlightTurns.clear();
		},
		snapshot() {
			return {
				cachedBindings: bindingCache.size,
				pendingLookups: pendingLookups.size,
				inFlightTurns: inFlightTurns.size,
			};
		},
	};
}

export interface LifecycleDeps {
	state: BridgeState;
	/**
	 * /reload refresh (R2): fired ONLY for session_start reason "reload".
	 * The D4 factory's implementation re-runs discovery and updates the
	 * registry; it must catch its own errors — a failed probe must not
	 * break the reload itself.
	 */
	rebuildDiscovery?: () => void | Promise<void>;
}

export interface BridgeLifecycle {
	/** Directly registerable: pi.on("session_start", lifecycle.onSessionStart). */
	onSessionStart: (event: SessionStartEvent) => Promise<void>;
	/** Directly registerable: pi.on("session_shutdown", lifecycle.onSessionShutdown). */
	onSessionShutdown: (event: SessionShutdownEvent) => Promise<void>;
}

/**
 * Build the two session-event handlers. Both recycle ALL in-memory
 * state for ANY reason; only session_start reason "reload" additionally
 * awaits the discovery rebuild.
 */
export function createLifecycle(deps: LifecycleDeps): BridgeLifecycle {
	return {
		async onSessionStart(event) {
			deps.state.recycle();
			if (event.reason === "reload") await deps.rebuildDiscovery?.();
		},
		async onSessionShutdown() {
			deps.state.recycle();
		},
	};
}
