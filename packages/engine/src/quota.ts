/**
 * Passive quota selection for the agy router: pool by REQUESTED model
 * (never active_model), passive snapshot only, stale/missing data allows
 * exactly one real attempt that refreshes the routing hint.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
export type Pool = 'gemini' | '3p';
export interface PoolQuota {
	/** remaining_fraction of the rolling 5-hour window */
	fiveHour: number;
	/** remaining_fraction of the weekly budget */
	weekly: number;
	resetTime?: string;
}
export interface QuotaSnapshot {
	provider?: string;
	activeModel?: string;
	updatedAt?: string;
	pools: Record<Pool, PoolQuota>;
}
/** Below this remaining_fraction a pool counts as exhausted. */
export const DEFAULT_THRESHOLD = 0.05;
export interface PoolDecision { pool: Pool; allowed: boolean; reason: string; resetTime?: string }
export interface QuotaHint {
	schema: 'agy-explore/quota-hint@1';
	pool: Pool;
	blocked: boolean;
	resetTime?: string;
	savedAt: string;
}
function num(v: unknown): number | null {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
/** Parse the passive snapshot; null when it is not the expected shape. */
export function parseSnapshot(raw: unknown): QuotaSnapshot | null {
	const r = typeof raw === 'string' ? safeJson(raw) : raw;
	if (typeof r !== 'object' || r === null) return null;
	const o = r as Record<string, any>;
	const g5 = o.quota_gemini_5h ?? {}, gw = o.quota_gemini_weekly ?? {};
	const t5 = o.quota_3p_5h ?? {}, tw = o.quota_3p_weekly ?? {};
	const pools: Record<Pool, PoolQuota> = {
		gemini: { fiveHour: num(g5.remaining_fraction) ?? -1, weekly: num(gw.remaining_fraction) ?? -1, resetTime: g5.reset_time },
		'3p': { fiveHour: num(t5.remaining_fraction) ?? -1, weekly: num(tw.remaining_fraction) ?? -1, resetTime: t5.reset_time },
	};
	for (const p of Object.values(pools)) if (p.fiveHour < 0 || p.weekly < 0) return null;
	return { provider: o.provider, activeModel: o.active_model, updatedAt: o.updated_at, pools };
}

/** Statusline v2 file names per pool/window; the FILENAME (not the per-file provider field) is the source of truth. */
const SNAPSHOT_V2_FILES: Array<{ file: string; pool: Pool; window: 'fiveHour' | 'weekly' }> = [
	{ file: 'gemini-5h.json', pool: 'gemini', window: 'fiveHour' },
	{ file: 'gemini-weekly.json', pool: 'gemini', window: 'weekly' },
	{ file: 'gemini-3p-5h.json', pool: '3p', window: 'fiveHour' },
	{ file: 'gemini-3p-weekly.json', pool: '3p', window: 'weekly' },
];
/** Remaining fraction from a v2 window file (used/limit are percentages): clamp((limit - used) / limit, 0, 1); null when unusable. */
function remainingFraction(w: Record<string, any> | null): number | null {
	if (!w) return null;
	const used = num(w.used), limit = num(w.limit);
	if (used === null || limit === null || limit <= 0) return null;
	return Math.min(1, Math.max(0, (limit - used) / limit));
}
/**
 * Read the statusline v2 snapshot directory (one JSON file per pool/window).
 * A pool missing either window file gets no resetTime so decidePool takes the
 * fail-open stale path (one real attempt); null only when nothing is readable.
 */
export function parseSnapshotDir(dir: string): QuotaSnapshot | null {
	const found: Record<Pool, { fiveHour?: number; weekly?: number; resetTime?: string }> = { gemini: {}, '3p': {} };
	let any = false;
	let fetchedAt = '';
	for (const { file, pool, window: win } of SNAPSHOT_V2_FILES) {
		let w: Record<string, any> | null = null;
		try {
			const o = safeJson(readFileSync(`${dir}/${file}`, 'utf8'));
			w = typeof o === 'object' && o !== null ? (o as Record<string, any>) : null;
		} catch {
			w = null;
		}
		const frac = remainingFraction(w);
		if (frac === null) continue;
		any = true;
		const p = found[pool];
		p[win] = frac;
		if (win === 'fiveHour' && typeof w?.resets_at === 'string') p.resetTime = w.resets_at;
		if (typeof w?.fetched_at === 'string' && w.fetched_at > fetchedAt) fetchedAt = w.fetched_at;
	}
	if (!any) return null;
	const pools = {} as Record<Pool, PoolQuota>;
	for (const pool of Object.keys(found) as Pool[]) {
		const p = found[pool];
		pools[pool] = p.fiveHour !== undefined && p.weekly !== undefined
			? { fiveHour: p.fiveHour, weekly: p.weekly, resetTime: p.resetTime }
			: { fiveHour: -1, weekly: -1 };
	}
	return { updatedAt: fetchedAt || undefined, pools };
}
/** Gemini-prefixed requested models use the Gemini pool; everything else is 3P. */
export function poolForModel(model: string): Pool {
	return /^gemini/i.test(model.trim()) ? 'gemini' : '3p';
}
/** A pool is stale once its reset_time passed — the snapshot no longer describes the current window. */
export function isStale(snap: QuotaSnapshot, pool: Pool, now: Date): boolean {
	const reset = snap.pools[pool]?.resetTime;
	return reset ? new Date(reset).getTime() <= now.getTime() : false;
}
/** Decide whether the requested model's pool may run agy now. */
export function decidePool(snap: QuotaSnapshot, model: string, opts: { threshold?: number; now?: Date } = {}): PoolDecision {
	const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
	const now = opts.now ?? new Date();
	const pool = poolForModel(model);
	const q = snap.pools[pool];
	if (!q || !q.resetTime || isStale(snap, pool, now)) {
		// Missing/stale data permits one real attempt; its result refreshes the hint.
		return { pool, allowed: true, reason: 'stale_snapshot', resetTime: q?.resetTime };
	}
	if (q.fiveHour < threshold || q.weekly < threshold) {
		return { pool, allowed: false, reason: 'threshold_exhausted', resetTime: q.resetTime };
	}
	return { pool, allowed: true, reason: 'within_threshold', resetTime: q.resetTime };
}
export function readHint(path: string): QuotaHint | null {
	try {
		const h = safeJson(readFileSync(path, 'utf8')) as QuotaHint | null;
		return h && h.schema === 'agy-explore/quota-hint@1' && (h.pool === 'gemini' || h.pool === '3p') ? h : null;
	} catch {
		return null;
	}
}
export function writeHint(path: string, hint: QuotaHint): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(hint, null, '\t') + '\n');
}

/** A hint governs routing until its reset_time; after that it is expired. */
export function hintActive(hint: QuotaHint, now: Date): boolean {
	return hint.resetTime ? new Date(hint.resetTime).getTime() > now.getTime() : false;
}
