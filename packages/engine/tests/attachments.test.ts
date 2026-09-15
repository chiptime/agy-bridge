/**
 * Engine tests for the attachment pipeline (design pi-image-input D1–D3):
 * the opencode-adapter suite migrated VERBATIM on promotion (the shim
 * re-exports the engine bindings, so these cases still guard the opencode
 * surface unchanged) plus the pi additions — the ImageContent shape
 * {type:"image", data: base64, mimeType} (D2 three-shape tolerance), the
 * missing threat-matrix cases (content-path collision), the widened
 * pruneAttachments(workdir, now?, maxAgeMs?) window, and the promoted
 * helpers (attachmentDirective, promptHasImage,
 * unsupportedAttachmentsMessage, dataBytes/dataUrl).
 *
 * Threat matrix (process-integration row): the module writes into the cwd
 * of a permissions-skipped child that is told to open these files — names
 * are hex-hash + allowlisted extension only (no traversal, no executable
 * names), oversize or hostile mediaType/mimeType reject BEFORE anything is
 * staged, and staged paths never write through a symlink.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	AgyAttachmentError,
	attachmentDirective,
	ATTACHMENT_MAX_AGE_MS,
	dataBytes,
	dataUrl,
	extractAttachments,
	promptHasImage,
	pruneAttachments,
	stageAttachments,
	unsupportedAttachmentsMessage,
	type ExtractedImage,
} from "../src/attachments";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_BYTES = 20 * 1024 * 1024;

const backdate = (path: string, days: number) => {
	const old = new Date(Date.now() - days * DAY_MS);
	utimesSync(path, old, old);
};

/** Independent hash computation — the naming contract is asserted against
 * a from-scratch sha256, never against the module's own helper. */
const hash16 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex").slice(0, 16);

const pngBytes = new TextEncoder().encode("fake-png-bytes-for-hash");
const jpegBytes = new TextEncoder().encode("fake-jpeg-bytes");
const gifBytes = new TextEncoder().encode("fake-gif-bytes");
const webpBytes = new TextEncoder().encode("fetched-webp-bytes");

const b64 = (data: Uint8Array) => Buffer.from(data).toString("base64");

const pngPart = (over: Record<string, unknown> = {}) => ({
	type: "image",
	image: b64(pngBytes),
	mediaType: "image/png",
	...over,
});

/** pi ImageContent shape (design D2): base64 data + mimeType fields. */
const piPart = (over: Record<string, unknown> = {}) => ({
	type: "image",
	data: b64(pngBytes),
	mimeType: "image/png",
	...over,
});

const img = (
	data: Uint8Array = pngBytes,
	mediaType: ExtractedImage["mediaType"] = "image/png",
): ExtractedImage => ({ data, mediaType });

/** Test double for the injectable fetch (bun's `typeof fetch` carries extra
 * properties like preconnect, so the cast goes through unknown). */
const fakeFetch = (fn: (input: string | URL | Request) => Promise<Response>): typeof fetch =>
	fn as unknown as typeof fetch;

describe("unit: attachments — threat matrix (staging into a permissions-skipped child cwd)", () => {
	test("threat: hostile part filenames never reach the staged path (hash16 + allowlisted ext only)", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-threat-");
		const { images, unsupported } = await extractAttachments([
			pngPart({ filename: "../../../../etc/cron.d/evil" }),
			{
				type: "image",
				image: b64(jpegBytes),
				mediaType: "image/jpeg",
				filename: "/absolutely/evil.sh",
			},
		]);
		expect(unsupported).toEqual([]);
		expect(images.length).toBe(2);
		const rels = stageAttachments(workdir, images);
		for (const rel of rels) {
			expect(rel).toMatch(/^\.agy-attachments\/[0-9a-f]{16}\.(png|jpg|gif|webp)$/);
			// containment: the file lands directly in the attachment dir, nowhere else
			expect(dirname(resolve(workdir, rel))).toBe(resolve(workdir, ".agy-attachments"));
		}
		expect(readdirSync(join(workdir, ".agy-attachments")).sort()).toEqual(
			[`${hash16(pngBytes)}.png`, `${hash16(jpegBytes)}.jpg`].sort(),
		);
	});

	test("threat: inline image >20 MB → AgyAttachmentError naming the limit, nothing staged", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-oversize-");
		const huge = Buffer.alloc(MAX_BYTES + 1, 7).toString("base64");
		let err: unknown;
		try {
			await extractAttachments([{ type: "image", image: huge, mediaType: "image/png" }]);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(AgyAttachmentError);
		expect((err as AgyAttachmentError).detail).toMatch(/20 MB/);
		expect(existsSync(join(workdir, ".agy-attachments"))).toBe(false);
	});

	test("threat: hostile/non-allowlisted mediaType → unsupported names the type, all-or-nothing, nothing staged", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-hostile-");
		const { images, unsupported } = await extractAttachments([
			pngPart(),
			{ type: "image", image: b64(pngBytes), mediaType: "image/svg+xml" },
			{ type: "file", data: "%PDF-1.7", mediaType: "application/pdf" },
			{ type: "audio", data: "x", mediaType: "audio/mpeg" },
		]);
		expect(unsupported).toContain("image/svg+xml");
		expect(unsupported).toContain("application/pdf");
		expect(unsupported).toContain("audio/mpeg");
		// all-or-nothing: the valid png must NOT survive a turn with unsupported parts
		expect(images).toEqual([]);
		const staged = stageAttachments(workdir, images);
		expect(staged).toEqual([]);
		expect(existsSync(join(workdir, ".agy-attachments"))).toBe(false);
	});

	test("threat: pre-existing symlink at a staged path → refuse write, victim untouched", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-symlink-");
		const dir = join(workdir, ".agy-attachments");
		mkdirSync(dir);
		const victim = join(workdir, "victim.txt");
		writeFileSync(victim, "precious");
		symlinkSync(victim, join(dir, `${hash16(pngBytes)}.png`));
		let err: unknown;
		try {
			stageAttachments(workdir, [img()]);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(AgyAttachmentError);
		expect((err as AgyAttachmentError).detail).toMatch(/symlink/);
		// the write was refused: the victim still holds its own content
		expect(readFileSync(victim, "utf8")).toBe("precious");
	});

	test("threat: .agy-attachments itself a symlink → refuse (writes must stay under the workdir)", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-dirlink-");
		const outside = await mkdtemp("/tmp/agy-attach-outside-");
		symlinkSync(outside, join(workdir, ".agy-attachments"));
		let err: unknown;
		try {
			stageAttachments(workdir, [img()]);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(AgyAttachmentError);
		expect(readdirSync(outside)).toEqual([]);
	});

	test("threat: content-path collision — a different file already occupies the staged path → refuse, squatter untouched", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-collision-");
		const dir = join(workdir, ".agy-attachments");
		mkdirSync(dir);
		writeFileSync(join(dir, `${hash16(pngBytes)}.png`), "different-content-entirely");
		let err: unknown;
		try {
			stageAttachments(workdir, [img()]);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(AgyAttachmentError);
		expect((err as AgyAttachmentError).detail).toMatch(/content path/);
		// refusal never rewrites foreign content: the occupying file survives verbatim
		expect(readFileSync(join(dir, `${hash16(pngBytes)}.png`), "utf8")).toBe("different-content-entirely");
	});
});

describe("unit: attachments — extraction (D3)", () => {
	test("single inline base64 image extracts with exact bytes and mediaType; text parts ignored", async () => {
		const { images, unsupported } = await extractAttachments([
			{ type: "text", text: "what is in this picture?" },
			pngPart(),
		]);
		expect(unsupported).toEqual([]);
		expect(images.length).toBe(1);
		expect(new TextDecoder().decode(images[0]!.data)).toBe("fake-png-bytes-for-hash");
		expect(images[0]!.mediaType).toBe("image/png");
	});

	test("inline image part carrying raw Uint8Array bytes (shape tolerance)", async () => {
		const { images, unsupported } = await extractAttachments([
			{ type: "image", image: webpBytes, mediaType: "image/webp" },
		]);
		expect(unsupported).toEqual([]);
		expect(images.length).toBe(1);
		expect(images[0]!.mediaType).toBe("image/webp");
		expect(new TextDecoder().decode(images[0]!.data)).toBe("fetched-webp-bytes");
	});

	test("AI SDK V3 file part with image/* mediaType extracts (real host shape, base64 data)", async () => {
		const { images, unsupported } = await extractAttachments([
			{ type: "text", text: "what is in this picture?" },
			{ type: "file", data: b64(pngBytes), mediaType: "image/png" },
		]);
		expect(unsupported).toEqual([]);
		expect(images.length).toBe(1);
		expect(new TextDecoder().decode(images[0]!.data)).toBe("fake-png-bytes-for-hash");
		expect(images[0]!.mediaType).toBe("image/png");
	});

	test("AI SDK V3 file part with raw Uint8Array data extracts", async () => {
		const { images, unsupported } = await extractAttachments([
			{ type: "file", data: webpBytes, mediaType: "image/webp" },
		]);
		expect(unsupported).toEqual([]);
		expect(images.length).toBe(1);
		expect(images[0]!.mediaType).toBe("image/webp");
		expect(new TextDecoder().decode(images[0]!.data)).toBe("fetched-webp-bytes");
	});

	test("file part with non-image mediaType is unsupported, nothing extracted", async () => {
		const { images, unsupported } = await extractAttachments([
			{ type: "file", data: "%PDF-1.7", mediaType: "application/pdf" },
		]);
		expect(unsupported).toEqual(["application/pdf"]);
		expect(images).toEqual([]);
	});

	test("multiple inline images (png/jpeg/gif) extract in order", async () => {
		const { images, unsupported } = await extractAttachments([
			{ type: "image", image: b64(pngBytes), mediaType: "image/png" },
			{ type: "image", image: b64(jpegBytes), mediaType: "image/jpeg" },
			{ type: "image", image: b64(gifBytes), mediaType: "image/gif" },
		]);
		expect(unsupported).toEqual([]);
		expect(images.map((i) => i.mediaType)).toEqual(["image/png", "image/jpeg", "image/gif"]);
	});

	test("duplicate parts extract twice — dedupe is a staging concern", async () => {
		const { images } = await extractAttachments([pngPart(), pngPart()]);
		expect(images.length).toBe(2);
		expect(new TextDecoder().decode(images[0]!.data)).toBe(new TextDecoder().decode(images[1]!.data));
	});

	test("plain string content → no images, no unsupported", async () => {
		const result = await extractAttachments("just text, nothing attached");
		expect(result).toEqual({ images: [], unsupported: [] });
	});

	test("image part with empty bytes is malformed → unsupported, nothing extracted", async () => {
		const emptyString = await extractAttachments([{ type: "image", image: "", mediaType: "image/png" }]);
		expect(emptyString.unsupported).toEqual(["image/png"]);
		expect(emptyString.images).toEqual([]);
		const emptyBytes = await extractAttachments([
			{ type: "image", image: new Uint8Array(0), mediaType: "image/png" },
		]);
		expect(emptyBytes.unsupported).toEqual(["image/png"]);
		expect(emptyBytes.images).toEqual([]);
	});

	test("image-url part is fetched once; bytes and content-type mediaType survive", async () => {
		let calls = 0;
		const fetchImpl = fakeFetch(async () => {
			calls++;
			return new Response(webpBytes, { headers: { "content-type": "image/webp" } });
		});
		const { images, unsupported } = await extractAttachments(
			[{ type: "image-url", url: "https://example.test/pic" }],
			{ fetchImpl },
		);
		expect(unsupported).toEqual([]);
		expect(calls).toBe(1);
		expect(images.length).toBe(1);
		expect(new TextDecoder().decode(images[0]!.data)).toBe("fetched-webp-bytes");
		expect(images[0]!.mediaType).toBe("image/webp");
	});

	test("image-url part mediaType outranks the response content-type", async () => {
		const fetchImpl = fakeFetch(async () =>
			new Response(gifBytes, { headers: { "content-type": "image/png" } }),
		);
		const { images } = await extractAttachments(
			[{ type: "image-url", url: "https://example.test/pic", mediaType: "image/gif" }],
			{ fetchImpl },
		);
		expect(images.length).toBe(1);
		expect(images[0]!.mediaType).toBe("image/gif");
	});

	test("image-url fetch failure (network) → AgyAttachmentError naming the URL", async () => {
		const fetchImpl = fakeFetch(async () => {
			throw new Error("ECONNREFUSED dial tcp");
		});
		let err: unknown;
		try {
			await extractAttachments([{ type: "image-url", url: "https://example.test/pic" }], { fetchImpl });
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(AgyAttachmentError);
		expect((err as AgyAttachmentError).detail).toMatch(/example\.test/);
		expect((err as AgyAttachmentError).detail).toMatch(/fetch/i);
	});

	test("image-url non-2xx response → AgyAttachmentError with the status", async () => {
		const fetchImpl = fakeFetch(async () => new Response("gone", { status: 404 }));
		let err: unknown;
		try {
			await extractAttachments([{ type: "image-url", url: "https://example.test/pic" }], { fetchImpl });
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(AgyAttachmentError);
		expect((err as AgyAttachmentError).detail).toMatch(/404/);
	});

	test("image-url body >20 MB → AgyAttachmentError naming the limit", async () => {
		const fetchImpl = fakeFetch(async () => new Response(new Uint8Array(MAX_BYTES + 1)));
		let err: unknown;
		try {
			await extractAttachments([{ type: "image-url", url: "https://example.test/pic" }], { fetchImpl });
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(AgyAttachmentError);
		expect((err as AgyAttachmentError).detail).toMatch(/20 MB/);
	});

	test("image-url with non-allowlisted content type → unsupported, nothing extracted", async () => {
		const fetchImpl = fakeFetch(async () =>
			new Response("<html>", { headers: { "content-type": "text/html" } }),
		);
		const { images, unsupported } = await extractAttachments(
			[{ type: "image-url", url: "https://example.test/pic" }],
			{ fetchImpl },
		);
		expect(unsupported).toContain("text/html");
		expect(images).toEqual([]);
	});
});

describe("unit: attachments — pi ImageContent shape (design D2 three-shape tolerance)", () => {
	test("pi image part {type:'image', data: base64, mimeType} extracts with exact bytes and mediaType", async () => {
		const { images, unsupported } = await extractAttachments([
			{ type: "text", text: "what is in this picture?" },
			piPart(),
		]);
		expect(unsupported).toEqual([]);
		expect(images.length).toBe(1);
		expect(new TextDecoder().decode(images[0]!.data)).toBe("fake-png-bytes-for-hash");
		expect(images[0]!.mediaType).toBe("image/png");
	});

	test("pi image part with raw Uint8Array data extracts (bytes tolerance)", async () => {
		const { images, unsupported } = await extractAttachments([
			{ type: "image", data: gifBytes, mimeType: "image/gif" },
		]);
		expect(unsupported).toEqual([]);
		expect(images.length).toBe(1);
		expect(images[0]!.mediaType).toBe("image/gif");
		expect(new TextDecoder().decode(images[0]!.data)).toBe("fake-gif-bytes");
	});

	test("all three shapes in one turn extract in order (legacy image, V3 file, pi)", async () => {
		const { images, unsupported } = await extractAttachments([
			{ type: "text", text: "compare these" },
			{ type: "image", image: b64(pngBytes), mediaType: "image/png" },
			{ type: "file", data: b64(jpegBytes), mediaType: "image/jpeg" },
			{ type: "image", data: b64(gifBytes), mimeType: "image/gif" },
		]);
		expect(unsupported).toEqual([]);
		expect(images.map((i) => i.mediaType)).toEqual(["image/png", "image/jpeg", "image/gif"]);
		expect(new TextDecoder().decode(images[0]!.data)).toBe("fake-png-bytes-for-hash");
		expect(new TextDecoder().decode(images[1]!.data)).toBe("fake-jpeg-bytes");
		expect(new TextDecoder().decode(images[2]!.data)).toBe("fake-gif-bytes");
	});

	test("hostile pi mimeType → unsupported names it, all-or-nothing, nothing staged", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-pi-hostile-");
		const { images, unsupported } = await extractAttachments([
			piPart({ mimeType: "image/svg+xml" }),
		]);
		expect(unsupported).toEqual(["image/svg+xml"]);
		expect(images).toEqual([]);
		const staged = stageAttachments(workdir, images);
		expect(staged).toEqual([]);
		expect(existsSync(join(workdir, ".agy-attachments"))).toBe(false);
	});

	test("pi image >20 MB → AgyAttachmentError naming the limit, nothing staged", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-pi-oversize-");
		const huge = Buffer.alloc(MAX_BYTES + 1, 7).toString("base64");
		let err: unknown;
		try {
			await extractAttachments([{ type: "image", data: huge, mimeType: "image/png" }]);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(AgyAttachmentError);
		expect((err as AgyAttachmentError).detail).toMatch(/20 MB/);
		expect(existsSync(join(workdir, ".agy-attachments"))).toBe(false);
	});

	test("pi image mixed with a PDF file part rejects all-or-nothing (threat 6)", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-pi-mixed-");
		const { images, unsupported } = await extractAttachments([
			piPart(),
			{ type: "file", data: "%PDF-1.7", mediaType: "application/pdf" },
		]);
		expect(unsupported).toContain("application/pdf");
		// the valid pi image must NOT survive a turn with an unsupported part
		expect(images).toEqual([]);
		const staged = stageAttachments(workdir, images);
		expect(staged).toEqual([]);
		expect(existsSync(join(workdir, ".agy-attachments"))).toBe(false);
	});

	test("pi image without mimeType → unsupported (no declared media type)", async () => {
		const { images, unsupported } = await extractAttachments([
			{ type: "image", data: b64(pngBytes) },
		]);
		expect(unsupported).toEqual(["image"]);
		expect(images).toEqual([]);
	});
});

describe("unit: attachments — staging (hash16 + ext naming, dedupe, defense)", () => {
	test("staged filename is first-16 sha256 hex + allowlisted ext for every media type", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-naming-");
		const rels = stageAttachments(workdir, [
			img(pngBytes, "image/png"),
			img(jpegBytes, "image/jpeg"),
			img(gifBytes, "image/gif"),
			img(webpBytes, "image/webp"),
		]);
		expect(rels).toEqual([
			`.agy-attachments/${hash16(pngBytes)}.png`,
			`.agy-attachments/${hash16(jpegBytes)}.jpg`,
			`.agy-attachments/${hash16(gifBytes)}.gif`,
			`.agy-attachments/${hash16(webpBytes)}.webp`,
		]);
		// staged bytes round-trip exactly
		expect(readFileSync(join(workdir, rels[0]!), "utf8")).toBe("fake-png-bytes-for-hash");
		expect(readFileSync(join(workdir, rels[3]!), "utf8")).toBe("fetched-webp-bytes");
	});

	test("identical bytes staged twice in one call → one file on disk, same relative path twice", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-dedupe-");
		const rels = stageAttachments(workdir, [img(), img()]);
		expect(rels[0]).toBe(rels[1]);
		expect(readdirSync(join(workdir, ".agy-attachments"))).toEqual([`${hash16(pngBytes)}.png`]);
	});

	test("identical bytes staged again later → the existing file is reused, not rewritten", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-reuse-");
		const first = stageAttachments(workdir, [img()]);
		const dir = join(workdir, ".agy-attachments");
		const file = join(dir, first[0]!.split("/")[1]!);
		backdate(file, 3);
		const before = statSync(file).mtimeMs;
		const second = stageAttachments(workdir, [img()]);
		expect(second[0]).toBe(first[0]);
		// reuse (not rewrite): the original mtime survives the second stage
		expect(statSync(file).mtimeMs).toBe(before);
		expect(readdirSync(dir)).toEqual([`${hash16(pngBytes)}.png`]);
	});

	test("stageAttachments re-validates: >20 MB image throws before any write", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-stage-cap-");
		let err: unknown;
		try {
			stageAttachments(workdir, [img(new Uint8Array(MAX_BYTES + 1))]);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(AgyAttachmentError);
		expect(existsSync(join(workdir, ".agy-attachments"))).toBe(false);
	});

	test("stageAttachments re-validates: non-allowlisted mediaType throws before any write", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-stage-mt-");
		let err: unknown;
		try {
			stageAttachments(workdir, [img(pngBytes, "image/svg+xml" as ExtractedImage["mediaType"])]);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(AgyAttachmentError);
		expect((err as AgyAttachmentError).detail).toMatch(/svg/);
		expect(existsSync(join(workdir, ".agy-attachments"))).toBe(false);
	});

	test("staging an empty list is a no-op returning no paths", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-empty-");
		expect(stageAttachments(workdir, [])).toEqual([]);
		expect(existsSync(join(workdir, ".agy-attachments"))).toBe(false);
	});
});

describe("unit: attachments — prune lifecycle (one 7-day default, widened window)", () => {
	test("prune removes stale hash-named entries, keeps fresh ones and foreign files", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-prune-");
		const dir = join(workdir, ".agy-attachments");
		mkdirSync(dir);
		writeFileSync(join(dir, "aaaa1111aaaa1111.png"), "old");
		backdate(join(dir, "aaaa1111aaaa1111.png"), 8);
		writeFileSync(join(dir, "bbbb2222bbbb2222.jpg"), "fresh");
		writeFileSync(join(dir, "notes.txt"), "not ours");
		backdate(join(dir, "notes.txt"), 30);
		const pruned = pruneAttachments(workdir);
		expect(pruned).toBe(1);
		expect(readdirSync(dir).sort()).toEqual(["bbbb2222bbbb2222.jpg", "notes.txt"]);
	});

	test("prune honors the injected now: an entry 8 days old by that clock is removed", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-prune-now-");
		const dir = join(workdir, ".agy-attachments");
		mkdirSync(dir);
		const file = join(dir, "cccc3333cccc3333.png");
		writeFileSync(file, "stale");
		const asOf = new Date(Date.now() + 8 * DAY_MS);
		expect(pruneAttachments(workdir, asOf)).toBe(1);
		expect(existsSync(file)).toBe(false);
	});

	test("prune of a workdir without .agy-attachments returns 0", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-prune-missing-");
		expect(pruneAttachments(workdir)).toBe(0);
	});

	test("prune honors an explicit maxAgeMs narrower than the default window", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-prune-window-");
		const dir = join(workdir, ".agy-attachments");
		mkdirSync(dir);
		const file = join(dir, "dddd4444dddd4444.png");
		writeFileSync(file, "recent-but-stale-by-a-custom-clock");
		backdate(file, 2); // fresh by the 7-day default, stale by a 1-day window
		expect(pruneAttachments(workdir, new Date(), DAY_MS)).toBe(1);
		expect(existsSync(file)).toBe(false);
	});

	test("prune with an explicit maxAgeMs wider than the default keeps entries it would drop", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-prune-wide-");
		const dir = join(workdir, ".agy-attachments");
		mkdirSync(dir);
		const file = join(dir, "eeee5555eeee5555.png");
		writeFileSync(file, "old-by-default");
		backdate(file, 8); // stale by the 7-day default
		expect(pruneAttachments(workdir, new Date(), 30 * DAY_MS)).toBe(0);
		expect(existsSync(file)).toBe(true);
	});

	test("ATTACHMENT_MAX_AGE_MS is the seven-day retention window", () => {
		expect(ATTACHMENT_MAX_AGE_MS).toBe(7 * DAY_MS);
	});
});

describe("unit: attachments — promoted helpers (D1: directive, detection, rejection text)", () => {
	test("attachmentDirective: nothing staged → undefined", () => {
		expect(attachmentDirective([])).toBeUndefined();
	});

	test("attachmentDirective: names every staged image and directs view_file inspection before responding", () => {
		const directive = attachmentDirective([
			`.agy-attachments/${hash16(pngBytes)}.png`,
			`.agy-attachments/${hash16(jpegBytes)}.jpg`,
		]);
		expect(directive).toBeDefined();
		const lines = directive!.split("\n");
		expect(lines.slice(0, 2)).toEqual([
			`[Attached user image: .agy-attachments/${hash16(pngBytes)}.png]`,
			`[Attached user image: .agy-attachments/${hash16(jpegBytes)}.jpg]`,
		]);
		expect(lines[2]).toBe("Please inspect each attached image above with view_file before responding.");
	});

	test("promptHasImage: pi image part in the last user turn → true", () => {
		expect(promptHasImage([{ role: "user", content: [piPart()] }])).toBe(true);
	});

	test("promptHasImage: legacy image, image-url, and file image mediaType shapes → true", () => {
		expect(promptHasImage([{ role: "user", content: [pngPart()] }])).toBe(true);
		expect(
			promptHasImage([{ role: "user", content: [{ type: "image-url", url: "https://x/y.png" }] }]),
		).toBe(true);
		expect(
			promptHasImage([{ role: "user", content: [{ type: "file", data: "aGk=", mediaType: "image/png" }] }]),
		).toBe(true);
	});

	test("promptHasImage: text-only / plain-string / empty / non-image mediaType → false", () => {
		expect(promptHasImage([{ role: "user", content: [{ type: "text", text: "q" }] }])).toBe(false);
		expect(promptHasImage([{ role: "user", content: "plain question" }])).toBe(false);
		expect(promptHasImage([])).toBe(false);
		expect(
			promptHasImage([{ role: "user", content: [{ type: "file", data: "%PDF", mediaType: "application/pdf" }] }]),
		).toBe(false);
	});

	test("promptHasImage: scoped to the LAST user turn — earlier images and assistant images don't trip the gate", () => {
		expect(promptHasImage([{ role: "assistant", content: [piPart()] }])).toBe(false);
		expect(
			promptHasImage([
				{ role: "user", content: [piPart()] },
				{ role: "assistant", content: "earlier answer" },
				{ role: "user", content: [{ type: "text", text: "follow-up" }] },
			]),
		).toBe(false);
	});

	test("unsupportedAttachmentsMessage names every type and the text alternative", () => {
		const message = unsupportedAttachmentsMessage(["application/pdf", "image/svg+xml"]);
		expect(message).toContain("application/pdf");
		expect(message).toContain("image/svg+xml");
		expect(message).toContain("png, jpeg, gif and webp");
		expect(message).toMatch(/describe its content as text/);
	});
});

describe("unit: attachments — data payload helpers (exported for host reuse)", () => {
	test("dataBytes: base64 string, data-URL string, and Uint8Array all decode; empty payloads are absent", () => {
		expect(new TextDecoder().decode(dataBytes(b64(pngBytes))!)).toBe("fake-png-bytes-for-hash");
		expect(new TextDecoder().decode(dataBytes(`data:image/png;base64,${b64(pngBytes)}`)!)).toBe(
			"fake-png-bytes-for-hash",
		);
		expect(new TextDecoder().decode(dataBytes(pngBytes)!)).toBe("fake-png-bytes-for-hash");
		expect(dataBytes("")).toBeUndefined();
		expect(dataBytes(new Uint8Array(0))).toBeUndefined();
	});

	test("dataUrl: URL object, http(s) string, and nested image_url resolve; anything else is absent", () => {
		expect(dataUrl(new URL("https://example.test/a.png"), { type: "file" })).toBe("https://example.test/a.png");
		expect(dataUrl("https://example.test/b.png", { type: "file" })).toBe("https://example.test/b.png");
		expect(
			dataUrl(undefined, { type: "image-url", image_url: { url: "https://example.test/c.png" } }),
		).toBe("https://example.test/c.png");
		expect(dataUrl("not-a-url", { type: "file" })).toBeUndefined();
	});
});
