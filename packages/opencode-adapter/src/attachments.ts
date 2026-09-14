/**
 * Image-attachment pipeline for the agy bridge (design D3/D4, spec
 * image-input): extract image parts from the LAST user turn (inline base64
 * or image-url fetch), then stage the decoded bytes as content-addressed
 * files under <workdir>/.agy-attachments/<hash16>.<ext> where the agy
 * agent's view_file can open them via --add-dir. All-or-nothing (D3): a
 * turn containing ANY unsupported part yields no images at all, so the
 * caller can reject before staging anything. Threat matrix
 * (process-integration row): the child runs with skipped permissions and
 * is told to open these files — staged names are hex-hash + allowlisted
 * extension only (no traversal, no executable names), >20 MB or
 * non-allowlisted media types throw AgyAttachmentError BEFORE anything is
 * staged, and staging never writes through a symlink. pruneAttachments
 * extends the workdir's 7-day lifecycle (SCRATCH_MAX_AGE_MS) to staged
 * files — one lifecycle, not two.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTextPart, type PromptContent, type PromptPart } from "agy-bridge-engine";
import { SCRATCH_MAX_AGE_MS } from "./workdir";

/** Media types the bridge can stage (D3 allowlist). */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** One decoded image ready to stage. */
export interface ExtractedImage {
	data: Uint8Array;
	mediaType: ImageMediaType;
}

/** Terminal attachment failure: detail is user-actionable guidance text. */
export class AgyAttachmentError extends Error {
	readonly code = "AGY_ATTACHMENT_INVALID" as const;
	constructor(public readonly detail: string) {
		super(detail);
		this.name = "AgyAttachmentError";
	}
}

/** Hard per-image cap (threat matrix: oversized image). */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** Staging directory inside the turn workdir (adapter-owned namespace). */
export const ATTACHMENTS_DIR = ".agy-attachments";

const EXT_BY_MEDIA_TYPE: Record<ImageMediaType, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};

/** Only exact allowlist members pass: lowercased, parameters stripped. */
function normalizeMediaType(raw: unknown): ImageMediaType | undefined {
	if (typeof raw !== "string") return undefined;
	const base = raw.toLowerCase().split(";")[0]?.trim() ?? "";
	return Object.hasOwn(EXT_BY_MEDIA_TYPE, base) ? (base as ImageMediaType) : undefined;
}

/** Most specific name for an unsupported part: its mediaType, else its type. */
function mediaTypeName(part: PromptPart): string {
	const mt = part["mediaType"];
	return typeof mt === "string" && mt !== "" ? mt : String(part.type);
}

function oversizedError(bytes: number, url?: string): AgyAttachmentError {
	const mb = (bytes / (1024 * 1024)).toFixed(1);
	const src = url === undefined ? "" : ` (${url})`;
	return new AgyAttachmentError(
		`image attachment is ${mb} MB${src}, over the 20 MB limit — compress or resize the image before attaching it`,
	);
}

/** Inline bytes of an image part: base64 string or raw Uint8Array.
 * Empty payloads are treated as absent — a zero-byte image is malformed. */
function inlineBytes(part: PromptPart): Uint8Array | undefined {
	const image = part["image"];
	if (typeof image === "string" && image !== "") return new Uint8Array(Buffer.from(image, "base64"));
	if (image instanceof Uint8Array && image.byteLength > 0) return new Uint8Array(image);
	return undefined;
}

/** URL of a remote image part: direct url or the openai-style nested shape. */
function urlOf(part: PromptPart): string | undefined {
	const direct = part["url"];
	if (typeof direct === "string" && direct !== "") return direct;
	const nested = part["image_url"];
	if (typeof nested === "object" && nested !== null) {
		const u = (nested as Record<string, unknown>)["url"];
		if (typeof u === "string" && u !== "") return u;
	}
	return undefined;
}

/** Injectable seams; fetch defaults to the global (URL images only). */
export interface AttachmentExtractionDeps {
	fetchImpl?: typeof fetch;
}

async function fetchUrlImage(
	url: string,
	fetchImpl: typeof fetch,
): Promise<{ data: Uint8Array; mediaTypeName: string | undefined }> {
	let res: Response;
	try {
		res = await fetchImpl(url);
	} catch (err) {
		throw new AgyAttachmentError(
			`failed to fetch image ${url}: ${err instanceof Error ? err.message : String(err)} — attach the image file itself instead of a URL`,
		);
	}
	if (!res.ok) {
		throw new AgyAttachmentError(
			`failed to fetch image ${url}: HTTP ${res.status} — attach the image file itself instead of a URL`,
		);
	}
	const declared = Number(res.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) throw oversizedError(declared, url);
	let buffer: ArrayBuffer;
	try {
		buffer = await res.arrayBuffer();
	} catch (err) {
		throw new AgyAttachmentError(
			`failed to read image ${url}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (buffer.byteLength > MAX_ATTACHMENT_BYTES) throw oversizedError(buffer.byteLength, url);
	return { data: new Uint8Array(buffer), mediaTypeName: res.headers.get("content-type") ?? undefined };
}

/**
 * Extract image parts from one user turn's content. Inline base64/bytes
 * stage directly; image-url parts are fetched once (20 MB cap, fetch
 * failure → AgyAttachmentError). Non-allowlisted media types and any
 * non-image part are collected by name in `unsupported`; extraction is
 * ALL-OR-NOTHING — if anything is unsupported, `images` is empty so no
 * part of the turn can stage (spec: unsupported turns stage nothing).
 */
export async function extractAttachments(
	content: PromptContent,
	deps: AttachmentExtractionDeps = {},
): Promise<{ images: ExtractedImage[]; unsupported: string[] }> {
	const images: ExtractedImage[] = [];
	const unsupported: string[] = [];
	if (typeof content === "string" || !Array.isArray(content)) return { images, unsupported };
	const fetchImpl = deps.fetchImpl ?? fetch;
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		if (isTextPart(part)) continue;
		const type = part.type;
		if (type === "image" || type === "image-url") {
			const partMediaType = normalizeMediaType(part["mediaType"]);
			// a part-declared mediaType that is not allowlisted is hostile, full stop
			if (part["mediaType"] !== undefined && partMediaType === undefined) {
				unsupported.push(mediaTypeName(part));
				continue;
			}
			const inline = type === "image" ? inlineBytes(part) : undefined;
			if (inline !== undefined) {
				if (partMediaType === undefined) {
					unsupported.push(mediaTypeName(part));
					continue;
				}
				if (inline.byteLength > MAX_ATTACHMENT_BYTES) throw oversizedError(inline.byteLength);
				images.push({ data: inline, mediaType: partMediaType });
				continue;
			}
			const url = urlOf(part);
			if (url !== undefined) {
				const fetched = await fetchUrlImage(url, fetchImpl);
				const mediaType = partMediaType ?? normalizeMediaType(fetched.mediaTypeName);
				if (mediaType === undefined) {
					unsupported.push(fetched.mediaTypeName ?? type);
					continue;
				}
				images.push({ data: fetched.data, mediaType });
				continue;
			}
			// image-shaped part with neither bytes nor a URL
			unsupported.push(mediaTypeName(part));
			continue;
		}
		unsupported.push(mediaTypeName(part));
	}
	if (unsupported.length > 0) return { images: [], unsupported };
	return { images, unsupported };
}

function validateImage(image: ExtractedImage): void {
	if (!Object.hasOwn(EXT_BY_MEDIA_TYPE, image.mediaType)) {
		throw new AgyAttachmentError(
			`unsupported image media type "${String(image.mediaType)}" — allowed: png, jpeg, gif, webp`,
		);
	}
	if (image.data.byteLength > MAX_ATTACHMENT_BYTES) throw oversizedError(image.data.byteLength);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	return a.byteLength === b.byteLength && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

/**
 * Stage decoded images into <workdir>/.agy-attachments/ as
 * <first-16-sha256-hex>.<allowlisted ext>, returning the RELATIVE paths
 * (the agent's cwd is the workdir). Identical bytes dedupe: an existing
 * regular file with the same content is reused, never rewritten. The whole
 * batch is re-validated BEFORE any filesystem change, and staging refuses
 * to write through a symlink at the staged path — or at the attachment
 * directory itself.
 */
export function stageAttachments(workdir: string, images: ExtractedImage[]): string[] {
	// An empty batch (rejected turn) must leave NO filesystem trace.
	if (images.length === 0) return [];
	for (const image of images) validateImage(image);
	const dir = join(workdir, ATTACHMENTS_DIR);
	if (existsSync(dir)) {
		const st = lstatSync(dir);
		if (st.isSymbolicLink()) {
			throw new AgyAttachmentError(
				`attachment directory ${ATTACHMENTS_DIR} is a symlink — refusing to stage outside the workdir`,
			);
		}
		if (!st.isDirectory()) {
			throw new AgyAttachmentError(
				`attachment directory ${ATTACHMENTS_DIR} exists and is not a directory — refusing to stage`,
			);
		}
	} else {
		mkdirSync(dir, { recursive: true });
	}
	const staged: string[] = [];
	for (const image of images) {
		const hash = createHash("sha256").update(image.data).digest("hex").slice(0, 16);
		const rel = `${ATTACHMENTS_DIR}/${hash}.${EXT_BY_MEDIA_TYPE[image.mediaType]}`;
		const abs = join(workdir, rel);
		if (existsSync(abs)) {
			const st = lstatSync(abs);
			if (st.isSymbolicLink()) {
				throw new AgyAttachmentError(`refusing to stage ${rel}: the path already exists as a symlink`);
			}
			if (!st.isFile()) {
				throw new AgyAttachmentError(`refusing to stage ${rel}: the path exists and is not a file`);
			}
			if (!bytesEqual(readFileSync(abs), image.data)) {
				throw new AgyAttachmentError(
					`refusing to stage ${rel}: a different file already occupies the content path`,
				);
			}
			// identical content: dedupe — the existing file is reused as-is
		} else {
			writeFileSync(abs, image.data);
		}
		staged.push(rel);
	}
	return staged;
}

const STAGED_NAME = /^[0-9a-f]{16}\.(png|jpg|gif|webp)$/;

/**
 * Prune staged attachments older than the scratch window (D4 reuses
 * SCRATCH_MAX_AGE_MS — one lifecycle). ONLY hash-named entries are
 * considered: session-mode workdirs are the user's worktree, and foreign
 * files inside the attachment directory must never be touched (same
 * philosophy as pruneScratch's agy-run- prefix). Returns the number of
 * pruned entries; a missing directory prunes nothing.
 */
export function pruneAttachments(workdir: string, now: Date = new Date()): number {
	const dir = join(workdir, ATTACHMENTS_DIR);
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return 0;
	}
	let pruned = 0;
	for (const entry of entries) {
		if (!STAGED_NAME.test(entry.name)) continue;
		const path = join(dir, entry.name);
		let mtime: Date;
		try {
			mtime = statSync(path).mtime;
		} catch {
			continue;
		}
		if (mtime.getTime() > now.getTime() - SCRATCH_MAX_AGE_MS) continue;
		rmSync(path, { recursive: true, force: true });
		pruned++;
	}
	return pruned;
}
