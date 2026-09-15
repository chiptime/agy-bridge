/**
 * Image-attachment pipeline for the agy bridge engine (design D1/D2 of the
 * pi-image-input promotion; originally spec image-input D3/D4): extract
 * image parts from the LAST user turn, then stage the decoded bytes as
 * content-addressed files under <workdir>/.agy-attachments/<hash16>.<ext>
 * where the agy agent's view_file can open them via --add-dir.
 * Host-agnostic by contract — nothing here may import a host adapter.
 *
 * Shape tolerance (pi-image-input D2): extraction accepts all THREE image
 * part shapes hosts deliver — AI SDK V3 `file` parts (data/mediaType),
 * legacy `image`/`image-url` parts (image/mediaType), and pi ImageContent
 * parts (base64 `data`/`mimeType`). Media type resolves as
 * `mediaType ?? mimeType`, inline bytes as `data ?? image`.
 *
 * All-or-nothing (image-input D3): a turn containing ANY unsupported part
 * yields no images at all, so the caller can reject before staging
 * anything. Threat matrix (process-integration row): the child runs with
 * skipped permissions and is told to open these files — staged names are
 * hex-hash + allowlisted extension only (no traversal, no executable
 * names), >20 MB or non-allowlisted media types throw AgyAttachmentError
 * BEFORE anything is staged, and staging never writes through a symlink.
 * pruneAttachments carries its own seven-day retention window
 * (ATTACHMENT_MAX_AGE_MS); hosts with an existing lifecycle (opencode's
 * SCRATCH_MAX_AGE_MS) keep that binding for their own scratch pruning and
 * may pass their window explicitly.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTextPart, type PromptContent, type PromptMessage, type PromptPart } from "./messages";

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

/** Staging directory inside the turn workdir (bridge-owned namespace). */
export const ATTACHMENTS_DIR = ".agy-attachments";

/** Retention window for staged attachments: seven days, one lifecycle. */
export const ATTACHMENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

/** Most specific name for an unsupported part: its declared media type
 * (mediaType ?? mimeType — hosts spell it both ways), else its type. */
function mediaTypeName(part: PromptPart): string {
	const mt = part["mediaType"] ?? part["mimeType"];
	return typeof mt === "string" && mt !== "" ? mt : String(part.type);
}

function oversizedError(bytes: number, url?: string): AgyAttachmentError {
	const mb = (bytes / (1024 * 1024)).toFixed(1);
	const src = url === undefined ? "" : ` (${url})`;
	return new AgyAttachmentError(
		`image attachment is ${mb} MB${src}, over the 20 MB limit — compress or resize the image before attaching it`,
	);
}

/** Inline bytes of an image part: base64 string or raw Uint8Array, read
 * from `data` (pi ImageContent / V3 payloads) or `image` (legacy shape).
 * Empty payloads are treated as absent — a zero-byte image is malformed. */
function inlineBytes(part: PromptPart): Uint8Array | undefined {
	const raw = part["data"] ?? part["image"];
	if (typeof raw === "string" && raw !== "") return new Uint8Array(Buffer.from(raw, "base64"));
	if (raw instanceof Uint8Array && raw.byteLength > 0) return new Uint8Array(raw);
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

/** Raw bytes from a data payload: Uint8Array, base64 string, or data-URL
 * string. Exported for host reuse (hosts pre-decode their own payloads). */
export function dataBytes(value: unknown): Uint8Array | undefined {
	if (value instanceof Uint8Array) return value.byteLength > 0 ? new Uint8Array(value) : undefined;
	if (typeof value === "string" && value !== "") {
		const m = value.match(/^data:[^;]*;base64,([\s\S]*)$/i);
		const b64 = m ? m[1] : value;
		const bytes = new Uint8Array(Buffer.from(b64, "base64"));
		return bytes.byteLength > 0 ? bytes : undefined;
	}
	return undefined;
}

/** URL string from a data payload: URL object, http(s) string, or nested
 * url. Exported for host reuse (hosts resolve their own remote parts). */
export function dataUrl(value: unknown, part: PromptPart): string | undefined {
	if (value instanceof URL) return value.toString();
	if (typeof value === "string" && value !== "" && /^https?:\/\//i.test(value)) return value;
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
		// AI SDK V3 shape: an image attachment is a `file` part whose mediaType
		// is image/*. The `data` payload is Uint8Array | base64 string | URL.
		if (type === "file") {
			const rawMediaType = part["mediaType"] ?? part["mimeType"];
			const isImageMedia = typeof rawMediaType === "string" && rawMediaType.toLowerCase().startsWith("image/");
			if (!isImageMedia) {
				unsupported.push(mediaTypeName(part));
				continue;
			}
			const partMediaType = normalizeMediaType(rawMediaType);
			if (partMediaType === undefined) {
				unsupported.push(mediaTypeName(part));
				continue;
			}
			const data = part["data"];
			const inline = dataBytes(data);
			if (inline !== undefined) {
				if (inline.byteLength > MAX_ATTACHMENT_BYTES) throw oversizedError(inline.byteLength);
				images.push({ data: inline, mediaType: partMediaType });
				continue;
			}
			const url = dataUrl(data, part);
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
			unsupported.push(mediaTypeName(part));
			continue;
		}
		if (type === "image" || type === "image-url") {
			// D2 shape tolerance: hosts declare the media type as `mediaType`
			// (AI SDK / opencode legacy) or `mimeType` (pi ImageContent).
			const declaredMediaType = part["mediaType"] ?? part["mimeType"];
			const partMediaType = normalizeMediaType(declaredMediaType);
			// a part-declared media type that is not allowlisted is hostile, full stop
			if (declaredMediaType !== undefined && partMediaType === undefined) {
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
 * Prune staged attachments older than the retention window (default:
 * ATTACHMENT_MAX_AGE_MS, seven days — one lifecycle). Hosts with their own
 * scratch lifecycle may pass that window explicitly. ONLY hash-named
 * entries are considered: session-mode workdirs are the user's worktree,
 * and foreign files inside the attachment directory must never be touched
 * (same philosophy as the opencode pruneScratch's agy-run- prefix).
 * Returns the number of pruned entries; a missing directory prunes nothing.
 */
export function pruneAttachments(workdir: string, now: Date = new Date(), maxAgeMs: number = ATTACHMENT_MAX_AGE_MS): number {
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
		if (mtime.getTime() > now.getTime() - maxAgeMs) continue;
		rmSync(path, { recursive: true, force: true });
		pruned++;
	}
	return pruned;
}

/**
 * D1 inspection directive (spec image-input R3, pi-image-input R4): fixed
 * literal + staged relative paths, deterministically PREPENDED to the
 * per-turn prompt. The per-turn prompt is rebuilt every turn, so the
 * directive is always delivered — unlike a system prefix, which hosts drop
 * on continuing conversations exactly when users paste images mid-session.
 */
export function attachmentDirective(staged: string[]): string | undefined {
	if (staged.length === 0) return undefined;
	return [
		...staged.map((rel) => `[Attached user image: ${rel}]`),
		"Please inspect each attached image above with view_file before responding.",
	].join("\n");
}

/**
 * True when the LAST user turn carries an image part (the exact shapes
 * extractAttachments recognizes: legacy `image`/`image-url`, V3 `file`
 * with an image mediaType, pi ImageContent). Scope is deliberately the
 * last user turn, matching the extraction contract: historical image parts
 * already follow the drop-by-design path.
 */
export function promptHasImage(messages: PromptMessage[]): boolean {
	const lastUser = [...messages].reverse().find((m) => m?.role === "user");
	if (!lastUser || !Array.isArray(lastUser.content)) return false;
	return lastUser.content.some((part) => {
		if (typeof part !== "object" || part === null) return false;
		if (part.type === "image" || part.type === "image-url") return true;
		const mt = part["mediaType"] ?? part["mimeType"];
		return typeof mt === "string" && mt.toLowerCase().startsWith("image/");
	});
}

/**
 * All-or-nothing rejection text for unsupported parts (spec image-input
 * R4): names every unsupported type and the text alternative.
 */
export function unsupportedAttachmentsMessage(types: string[]): string {
	return `unsupported attachment type(s) in the last user turn: ${types.join(", ")} — the agy image bridge accepts png, jpeg, gif and webp images only; remove the unsupported attachment or describe its content as text`;
}
