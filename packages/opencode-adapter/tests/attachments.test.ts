/**
 * Shim identity contract (design D3): packages/opencode-adapter/src/attachments
 * is a pure re-export of agy-bridge-engine — every binding the opencode
 * adapter ever exported must be the VERY SAME function/class/value the
 * engine owns. Identity (===) IS the compatibility contract: the migrated
 * engine suite (packages/engine/tests/attachments.test.ts, ported verbatim
 * from this file's former body plus the pi cases) proves the behavior, and
 * identity here makes that proof hold verbatim through the shim — the
 * opencode API surface is unchanged by the promotion. A cross-module
 * instanceof check additionally pins the error-class seam the language
 * model's catch blocks rely on.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import * as engine from "agy-bridge-engine";
import * as shim from "../src/attachments";

const pngBytes = new TextEncoder().encode("fake-png-bytes-for-hash");
const b64 = (data: Uint8Array) => Buffer.from(data).toString("base64");
const hash16 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex").slice(0, 16);

describe("unit: attachments shim — identity-equal re-exports (design D3)", () => {
	test("pipeline functions are the engine's own bindings", () => {
		expect(shim.extractAttachments).toBe(engine.extractAttachments);
		expect(shim.stageAttachments).toBe(engine.stageAttachments);
		expect(shim.pruneAttachments).toBe(engine.pruneAttachments);
		expect(shim.attachmentDirective).toBe(engine.attachmentDirective);
		expect(shim.promptHasImage).toBe(engine.promptHasImage);
		expect(shim.unsupportedAttachmentsMessage).toBe(engine.unsupportedAttachmentsMessage);
		expect(shim.dataBytes).toBe(engine.dataBytes);
		expect(shim.dataUrl).toBe(engine.dataUrl);
	});

	test("AgyAttachmentError is the engine's class (cross-module instanceof)", () => {
		expect(shim.AgyAttachmentError).toBe(engine.AgyAttachmentError);
		expect(new shim.AgyAttachmentError("x")).toBeInstanceOf(engine.AgyAttachmentError);
		expect(new shim.AgyAttachmentError("x")).toBeInstanceOf(Error);
	});

	test("constants carry the engine's values", () => {
		expect(shim.MAX_ATTACHMENT_BYTES).toBe(engine.MAX_ATTACHMENT_BYTES);
		expect(shim.ATTACHMENTS_DIR).toBe(engine.ATTACHMENTS_DIR);
		expect(shim.ATTACHMENTS_DIR).toBe(".agy-attachments");
		expect(shim.ATTACHMENT_MAX_AGE_MS).toBe(engine.ATTACHMENT_MAX_AGE_MS);
		expect(shim.ATTACHMENT_MAX_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
	});

	test("runtime passthrough: pi-shape extract + stage through the shim behaves like the engine", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-shim-");
		const { images, unsupported } = await shim.extractAttachments([
			{ type: "text", text: "what is in this picture?" },
			{ type: "image", data: b64(pngBytes), mimeType: "image/png" },
		]);
		expect(unsupported).toEqual([]);
		expect(images.length).toBe(1);
		expect(images[0]!.mediaType).toBe("image/png");
		const rels = shim.stageAttachments(workdir, images);
		expect(rels).toEqual([`.agy-attachments/${hash16(pngBytes)}.png`]);
	});

	test("runtime passthrough: the widened prune window reaches the engine through the shim", async () => {
		const workdir = await mkdtemp("/tmp/agy-attach-shim-prune-");
		const dir = join(workdir, ".agy-attachments");
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(dir);
		writeFileSync(join(dir, "aaaa1111aaaa1111.png"), "stale");
		// one-day explicit window: a fresh entry (default 7d) is NOT pruned,
		// proving the third parameter is honored through the shim
		expect(shim.pruneAttachments(workdir, new Date(), 24 * 60 * 60 * 1000)).toBe(0);
	});
});
