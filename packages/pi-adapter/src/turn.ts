/**
 * Turn orchestration for pi turns (specs R3, R7, R8) — extracted from the
 * C2 streamSimple bridge so stream-simple.ts owns ONLY the pi event
 * protocol. One runTurn call = session lookup → divergence decision →
 * at most two runAgyStream attempts (a second attempt only for the
 * timeout family, resuming the captured conversation id exactly once):
 *
 * Divergence policy (decided BEFORE any spawn):
 * - no stored entry → fresh agy conversation, last-user-turn prompt;
 * - stored entry WITHOUT hashes (pre-upgrade) → adopt once and treat the
 *   turn as linear (resuming preserves agy's context), then baseline;
 * - stored hashes a PREFIX of the incoming hashes → linear continuation
 *   via --conversation;
 * - otherwise (earlier messages edited/deleted/reordered) → DIVERGED:
 *   fresh agy conversation with the engine-rendered bounded seed, the
 *   onDiverged hook fires (the host renders DIVERGED_NOTICE), and the
 *   new conversation id + incoming hashes become the baseline.
 *
 * Success binds the session mapping (R5 key `options.sessionId ?? cwd`);
 * a failed resumed attempt rebinds so the next turn runs fresh; every
 * other failure throws TurnError carrying the mapped pi semantics.
 * Abort SIGTERMs the child through the stream tap, persists the tapped
 * conversation id, then throws TurnAborted.
 *
 * Spawn boundary: the child's cwd is exactly `deps.workdir ??
 * options.cwd ?? process.cwd()`; `--add-dir` only ever carries that same
 * authority value. The prompt travels argv by default (frozen transport)
 * or — with deps.promptViaStdin — on the child's stdin, never argv.
 */
import {
	AgyAttachmentError,
	attachmentDirective,
	classifyRun,
	extractAttachments,
	hashesArePrefix,
	messageHashes,
	parseStreamLine,
	promptHasImage,
	pruneAttachments,
	renderSeed,
	runAgyStream,
	stageAttachments,
	unsupportedAttachmentsMessage,
	type Classification,
	type SpawnRun,
} from "agy-bridge-engine";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { DebugLogger } from "./debug";
import type { BridgeState } from "./lifecycle";
import { mapClassification, type ErrorMapping } from "./errors";
import { mapPiPrompt, toPromptMessages } from "./messages";
import { sessionKey, type SessionStore } from "./session-store";

/** Matches the plugin-era explore budget documented in the engine (1230s). */
export const DEFAULT_TURN_TIMEOUT_MS = 1_230_000;

/** Host status line for the divergence re-seed (R7) — rendered by stream-simple as a thinking delta. */
export const DIVERGED_NOTICE = "⟲ history diverged — new agy conversation seeded\n";

/** Host status line for the resume-once retry (v0.2 R8/D7) — rendered by stream-simple as a thinking delta. */
export const RETRY_NOTICE = "⟲ turn timed out — resuming agy conversation\n";

/**
 * Default-off fail-safe message (pi-image-input R1/D4): names BOTH pi
 * config paths (project, then global) AND the text alternative, so a
 * rejected image turn is actionable instead of mysterious. Mirrors the
 * opencode IMAGE_INPUT_DISABLED_MESSAGE contract with pi's spellings.
 */
export const PI_IMAGE_INPUT_DISABLED_MESSAGE =
	"the agy provider received an image but image input is disabled by default — enable it with imageInput: true in .pi/agy-bridge.json (project) or ~/.pi/agent/agy-bridge.json (global), or describe the image in text instead";

/**
 * Host status line for a missed inspection (pi-image-input R6/D7) —
 * rendered by stream-simple as a thinking delta after the turn, so the
 * uninspected image is never silently treated as seen. Mirrors the
 * opencode IMAGE_NOT_INSPECTED_NOTICE wording.
 */
export const PI_IMAGE_NOT_INSPECTED_NOTICE =
	"⚠ an attached image was not inspected with view_file — the response below may not account for it\n";

/** One engine attempt: classification + captured run + resume bookkeeping. */
interface AttemptResult {
	classification: Classification;
	run: SpawnRun;
	resumed: boolean;
	conversationId?: string;
}

export interface TurnResult extends AttemptResult {
	/** v1.1: the visible thread diverged from agy's history; a fresh, seeded conversation was started. */
	diverged: boolean;
	/** Absolute path of this turn's run.log (fresh agy-run-* scratch dir under deps.logRoot). */
	logPath: string;
	/** The prompt actually forwarded this turn (directive + divergence/seed decision). */
	prompt: string;
	/** Relative paths (workdir-relative) of staged attachment files; unset when nothing staged. */
	stagedAttachments?: string[];
	/** True when every staged image was inspected via view_file (vacuously true when nothing staged). */
	attachmentsInspected?: boolean;
}

export interface TurnRequest {
	/** pi Context (systemPrompt + the full visible thread); reduced to the last user turn. */
	context: Context;
	/** pi SimpleStreamOptions: sessionId / cwd (session key), signal (abort). */
	options?: SimpleStreamOptions;
	/** Resolved --model value; undefined means agy picks its own default. */
	modelArg?: string;
	/** Live step_update payloads (the host narrates them as progress). */
	onStep?: (step: Record<string, unknown>) => void;
	/** Announces the divergence re-seed (the host renders DIVERGED_NOTICE). */
	onDiverged?: () => void;
	/**
	 * v0.2 R8/D7: announces the resume-once retry, fired immediately BEFORE
	 * the resume attempt so the host can close the streamed text and start
	 * a fresh block (only the final attempt reconciles).
	 */
	onRetry?: () => void;
	/**
	 * v0.2 R5/D4: engine mode for AskAgy delegations. Provider turns pass
	 * NOTHING — their argv stays byte-identical to v0.1 (agy's own default
	 * = accept-edits).
	 */
	mode?: "plan" | "accept-edits";
	/**
	 * v0.3 R2/D3: resume-always — set ONLY by the ask tool's non-isolated
	 * execute (the tool prompt IS the whole input). Skips the R7 divergence
	 * decision AND the hash-less adopt-once clause entirely: every call
	 * resumes the stored thread conversation (fresh on the session's first
	 * call) and binds hash-less. Provider turns pass NOTHING — the ladder
	 * and bind sites stay byte-identical to v0.2 (R6); the flag never
	 * reaches argv.
	 */
	resumeAlways?: boolean;
}

export interface TurnDeps {
	/** agy binary (config.agyBin). */
	bin: string;
	store: SessionStore;
	/** Per-attempt hard cap; default DEFAULT_TURN_TIMEOUT_MS. */
	timeoutMs?: number;
	/** Child cwd override; default the pi turn's cwd (options.cwd ?? process.cwd()). */
	workdir?: string;
	/** Scratch root for per-turn run.log dirs; default os.tmpdir(). */
	logRoot?: string;
	/** Injectable spawn for tests (fed to the stream tap). */
	spawnFn?: typeof spawn;
	/**
	 * Additive engine seam: the prompt rides the child's stdin, never
	 * argv. Default off = the frozen argv transport (--print <prompt>).
	 */
	promptViaStdin?: boolean;
	/**
	 * Lifecycle registry (R6): when present, the turn registers itself
	 * in-flight, notes tapped conversation ids, and keeps the binding
	 * cache coherent with bind/rebind. Purely additive — absent means
	 * today's direct-store behavior (frozen suites).
	 */
	state?: BridgeState;
	/**
	 * Opt-in debug sink (v0.2 R11/D11): when present, id/code/duration facts
	 * append to the unified bridge log. NEVER the prompt body — the log
	 * carries session keys, conversation ids, classification codes, and
	 * durations only. Absent → silent.
	 */
	debug?: DebugLogger;
	/**
	 * pi-image-input R1: image bridge opt-in (config.imageInput, default
	 * false). When false/absent, an image in the last user turn rejects
	 * BEFORE staging or spawning with PI_IMAGE_INPUT_DISABLED_MESSAGE.
	 */
	imageInput?: boolean;
}

/** Terminal turn failure carrying the mapped pi error semantics (errors.ts). */
export class TurnError extends Error {
	constructor(public readonly mapping: ErrorMapping) {
		super(mapping.message);
		this.name = "TurnError";
	}
}

/**
 * The caller's signal aborted the turn; the tapped conversation id was
 * already persisted. v0.2 probe 2a: when the real binary flushed a partial
 * result envelope before dying, `response` carries it so the host can
 * reconcile the open text block — the stream never dangles.
 */
export class TurnAborted extends Error {
	constructor(public readonly response?: string) {
		super("agy turn aborted");
		this.name = "TurnAborted";
	}
}

/**
 * stdout tap for live progress and abort control (ported from the proven
 * opencode stream-tap): attaches a second 'data' listener on child.stdout
 * INSIDE the spawnImpl call — the same synchronous tick in which
 * runAgyStream later attaches its readline — so Node broadcasts every
 * chunk to both consumers and no bytes are lost. The wrapper retains the
 * ChildProcess so an abort can SIGTERM it; the engine then resolves
 * SpawnRun normally and the tapped conversationId survives as the resume
 * handle. One tap per run attempt: resume attempts create a fresh tap.
 */
interface StreamTap {
	spawnImpl: typeof spawn;
	abort(): void;
	readonly conversationId: string | undefined;
}

function createTap(opts: {
	signal?: AbortSignal;
	spawnFn?: typeof spawn;
	onStep: (step: Record<string, unknown>) => void;
	/** pi-image-input R6/D7: raw NDJSON line hook — the inspection matcher
	 * runs on the RAW line (shape-tolerant substring test, exactly like the
	 * proven opencode tap), before any parsing side effects. */
	onRawLine?: (line: string) => void;
}): StreamTap {
	const spawnFn = opts.spawnFn ?? spawn;
	let child: ChildProcess | undefined;
	let buffer = "";
	let conversationId: string | undefined;
	// Inner step_update payload of a stream-json line, when present.
	const stepUpdateOf = (line: string): Record<string, unknown> | undefined => {
		try {
			const parsed: unknown = JSON.parse(line);
			if (typeof parsed === "object" && parsed !== null) {
				const inner = (parsed as Record<string, unknown>)["step_update"];
				if (typeof inner === "object" && inner !== null) return inner as Record<string, unknown>;
			}
		} catch {
			/* not JSON — nothing to narrate */
		}
		return undefined;
	};
	const consume = (line: string) => {
		if (line === "") return;
		opts.onRawLine?.(line);
		const got = parseStreamLine(line);
		if (got.conversationId !== undefined) conversationId = got.conversationId;
		const step = stepUpdateOf(line);
		if (step !== undefined) opts.onStep(step);
	};
	const tap: StreamTap = {
		// Attach the tap listener synchronously at spawn time, before the
		// engine's readline: chunk broadcast then reaches both consumers.
		spawnImpl: ((...args: Parameters<typeof spawn>) => {
			child = spawnFn(...args);
			child.stdout?.on("data", (chunk: Buffer) => {
				buffer += chunk.toString("utf8");
				let nl: number;
				while ((nl = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 1);
					consume(line);
				}
			});
			// Mirror readline: a final unterminated line still counts on exit.
			child.on("exit", () => {
				if (buffer !== "") {
					const rest = buffer;
					buffer = "";
					consume(rest);
				}
			});
			return child;
		}) as typeof spawn,
		abort: () => {
			if (child && !child.killed) child.kill("SIGTERM");
		},
		get conversationId() {
			return conversationId;
		},
	};
	opts.signal?.addEventListener("abort", () => tap.abort(), { once: true });
	return tap;
}

/**
 * True for a part shape extractAttachments recognizes as an image (D2):
 * legacy `image`/`image-url` parts, pi ImageContent parts, and V3 `file`
 * parts with an image mediaType — the exact promptHasImage recognition set,
 * so the sanitized clone drops precisely what was staged.
 */
function isImagePartShape(part: unknown): boolean {
	if (typeof part !== "object" || part === null) return false;
	const type = (part as { type?: unknown }).type;
	if (type === "image" || type === "image-url") return true;
	if (type !== "file") return false;
	const mt = (part as { mediaType?: unknown; mimeType?: unknown }).mediaType ?? (part as { mimeType?: unknown }).mimeType;
	return typeof mt === "string" && mt.toLowerCase().startsWith("image/");
}

/**
 * pi-image-input D5: clone the Context with the LAST user turn's image
 * parts filtered out (boundary cast mirrors messages.ts — pi's content
 * parts are a closed union). The RAW context stays untouched: hashes and
 * the divergence seed keep their identity, image or not.
 */
function contextWithLastUserImagesDropped(context: Context, lastUserIdx: number): Context {
	const msg = context.messages[lastUserIdx];
	if (msg === undefined || !Array.isArray(msg.content)) return context;
	const filtered = msg.content.filter((part) => !isImagePartShape(part));
	return {
		...context,
		messages: context.messages.map((m, i) =>
			i === lastUserIdx ? ({ ...m, content: filtered } as typeof m) : m,
		),
	};
}

/**
 * Run one pi turn: divergence decision, at most two engine attempts,
 * session persistence, and the typed terminal (TurnResult on success,
 * TurnError / TurnAborted otherwise — stream-simple maps both onto the
 * AssistantMessageEvent error terminal).
 */
export async function runTurn(deps: TurnDeps, req: TurnRequest): Promise<TurnResult> {
	const signal = req.options?.signal;
	if (signal?.aborted) throw new TurnAborted();
	// Session key (R5): explicit sessionId, else the pi turn's cwd.
	const options = req.options;
	const sid = options?.sessionId !== undefined && options.sessionId !== "" ? options.sessionId : undefined;
	const optionsCwd = (options as { cwd?: string } | undefined)?.cwd;
	const cwd = optionsCwd ?? process.cwd();
	const key = sessionKey(sid, cwd);
	// Wall-clock origin for the debug duration facts (v0.2 R11).
	const startedAt = Date.now();
	// In-flight registration (R6): spans the whole turn, ends on every
	// exit path; the identity token means an overlapped turn for the
	// same key can never end its successor's registration.
	const tracked = deps.state?.beginTurn(key);
	const note = (id: string | undefined) => {
		if (id !== undefined) deps.state?.noteConversationId(key, id);
	};
	try {
		// Workdir authority: only deps/config or the pi turn's own cwd — never
		// anything derived from prompt content (threat row b).
		const workdir = deps.workdir ?? cwd;
		// Prompt reduction + divergence decision (R4/R7): the stored hash
		// baseline picks linear resume vs fresh re-seed; hash-less entries are
		// adopted once. With a registry wired, the lookup rides the binding
		// cache's per-key single flight (lifecycle.ts).
		const incoming = toPromptMessages(req.context.messages);
		const hashes = messageHashes(incoming);
		// pi-image-input R1 fail-safe (D4/D5): advertised capabilities can
		// desync from config, so the flag is re-checked here. Disabled +
		// image in the LAST user turn rejects BEFORE any staging, store
		// write, or spawn — nothing stages, the agent never runs, and the
		// message names both enablement paths plus the text alternative.
		if (deps.imageInput !== true && promptHasImage(incoming)) {
			throw new TurnError({
				retryable: false,
				resumeEligible: false,
				finalize: "error",
				message: PI_IMAGE_INPUT_DISABLED_MESSAGE,
			});
		}
		// pi-image-input R2–R4 seam (D5): enabled turns extract the LAST user
		// turn's image parts ALL-OR-NOTHING (any unsupported part rejects
		// the whole turn before staging or spawning), stage the decoded bytes
		// under <workdir>/.agy-attachments, sweep stale entries on the same
		// 7-day window, and map the prompt from a CLONED Context with the
		// staged image parts filtered out — the RAW incoming array above
		// stays the hash/seed identity. Every AgyAttachmentError maps onto
		// the D4 TurnError terminal (stream-simple already renders it).
		const attachmentFailure = (detail: string): TurnError =>
			new TurnError({ retryable: false, resumeEligible: false, finalize: "error", message: detail });
		let staged: string[] = [];
		let directive: string | undefined;
		let mappingContext = req.context;
		if (deps.imageInput === true) {
			let lastUserIdx = -1;
			for (let i = incoming.length - 1; i >= 0; i--) {
				if (incoming[i]?.role === "user") {
					lastUserIdx = i;
					break;
				}
			}
			const lastUserContent = lastUserIdx >= 0 ? incoming[lastUserIdx].content : undefined;
			if (Array.isArray(lastUserContent) && lastUserContent.length > 0) {
				let extracted: Awaited<ReturnType<typeof extractAttachments>>;
				try {
					extracted = await extractAttachments(lastUserContent);
				} catch (err) {
					if (err instanceof AgyAttachmentError) throw attachmentFailure(err.detail);
					throw err;
				}
				if (extracted.unsupported.length > 0) {
					throw attachmentFailure(unsupportedAttachmentsMessage(extracted.unsupported));
				}
				if (extracted.images.length > 0) {
					try {
						staged = stageAttachments(workdir, extracted.images);
					} catch (err) {
						if (err instanceof AgyAttachmentError) throw attachmentFailure(err.detail);
						throw err;
					}
					// R5 retention: session workdirs are the user's worktree, so
					// staged entries join the 7-day prune explicitly.
					pruneAttachments(workdir);
					directive = attachmentDirective(staged);
					mappingContext = contextWithLastUserImagesDropped(req.context, lastUserIdx);
				}
			}
		}
		// R6 inspection-tap state (D7): vacuously true when nothing staged;
		// the tap below flips it on a view_file step naming a staged file.
		let attachmentsInspected = staged.length === 0;
		const stagedNames = staged.map((rel) => basename(rel));
		const entry = await (deps.state?.lookupBinding(deps.store, key) ?? deps.store.getEntry(key));
		let diverged = false;
		let resumeId: string | undefined;
		if (req.resumeAlways === true) {
			// Thread path (v0.3 R2/D3): the tool prompt IS the whole input, so
			// the divergence table never applies — always resume the stored
			// thread conversation (undefined on the first call → fresh), no
			// compare, no re-seed, no ⟲ notice, no adopt-once clause. The bind
			// stays hash-less via the baseline below.
			resumeId = entry?.conversationId;
		} else if (entry === undefined) {
			resumeId = undefined; // first turn: fresh, last-user-turn only
		} else if (entry.hashes === undefined) {
			resumeId = entry.conversationId; // unknown baseline: adopt once, then protected
		} else if (hashesArePrefix(entry.hashes, hashes)) {
			resumeId = entry.conversationId; // linear continuation
		} else {
			diverged = true; // edited/deleted/reordered history → fresh re-seed
			req.onDiverged?.();
			deps.debug?.log("diverged", { key });
		}
		const isNewConversation = entry === undefined || diverged;
		// Baseline persisted at the bind/cache sites: thread turns bind
		// hash-less (resume-always needs no protection); provider turns keep
		// the incoming hashes byte-identical to v0.1/v0.2 (R6).
		const baseline = req.resumeAlways === true ? undefined : hashes;
		const seedInfo = diverged ? renderSeed(incoming) : undefined;
		// D5: map from the CLONED context (image parts of the last user turn
		// filtered once anything staged), then PREPEND the deterministic
		// inspection directive to the effective prompt — rebuilt every turn,
		// so the directive survives continuing conversations.
		const mapping = mapPiPrompt(mappingContext, { isNewConversation, seed: seedInfo?.seed });
		// Image-only turns map to an empty prompt — the directive alone is
		// the effective prompt (no trailing blank separators).
		const prompt =
			directive === undefined
				? mapping.prompt
				: mapping.prompt !== ""
					? `${directive}\n\n${mapping.prompt}`
					: directive;
		// Turn-start fact line (R11): ids and codes only — never the prompt.
		deps.debug?.log("turn_start", {
			key,
			workdir,
			...(req.modelArg !== undefined ? { model: req.modelArg } : {}),
			...(req.mode !== undefined ? { mode: req.mode } : {}),
			resume: resumeId !== undefined,
			diverged,
		});
		// Per-turn scratch dir keeps run.log out of the user's project.
		const logPath = join(mkdtempSync(join(deps.logRoot ?? tmpdir(), "agy-run-")), "run.log");
		const attempt = async (
			resumeConversationId: string | undefined,
			resumed: boolean,
		): Promise<AttemptResult> => {
			const tap = createTap({
				signal,
				spawnFn: deps.spawnFn,
				onStep: (step) => req.onStep?.(step),
				// D7 inspection tap (pi-image-input R6): a step line naming
				// view_file AND a staged filename marks the images inspected.
				// Shape-tolerant substring test on the RAW line — verified
				// against the recorded real-binary shape (tests/fixtures/
				// agy-view-file-steps.ndjson, task 3.4 finding): the matcher
				// needs NO adaptation under pi's stream shape. Turn-scoped
				// state: a flip on ANY attempt (resume included) counts.
				...(stagedNames.length > 0
					? {
							onRawLine: (line: string) => {
								if (
									!attachmentsInspected &&
									line.includes("view_file") &&
									stagedNames.some((name) => line.includes(name))
								) {
									attachmentsInspected = true;
								}
							},
						}
					: {}),
			});
			const run = await runAgyStream({
				bin: deps.bin,
				prompt,
				workdir,
				timeoutMs: deps.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
				model: req.modelArg,
				resumeConversationId,
				logPath,
				spawnImpl: tap.spawnImpl,
				...(deps.promptViaStdin !== undefined ? { promptViaStdin: deps.promptViaStdin } : {}),
				...(req.mode !== undefined ? { mode: req.mode } : {}),
			});
			const classification = classifyRun({
				exitCode: run.exitCode,
				log: run.log,
				spawnError: run.spawnError,
				timedOut: run.timedOut,
				stalled: run.stalled,
				envelope: run.envelope,
				expectArtifact: false,
			});
			const conversationId = run.conversationId ?? tap.conversationId;
			deps.debug?.log("classified", {
				key,
				classification: classification.outcome,
				resumed,
				durationMs: Date.now() - startedAt,
				...(conversationId !== undefined ? { conversationId } : {}),
			});
			return { classification, run, resumed, conversationId };
		};
		const resumeAttemptId = diverged ? undefined : entry?.conversationId;
		let result = await attempt(resumeAttemptId, resumeAttemptId !== undefined);
		note(result.conversationId);
		const persistAndThrowAbort = async (r: AttemptResult): Promise<never> => {
			deps.debug?.log("turn_aborted", {
				key,
				durationMs: Date.now() - startedAt,
				...(r.conversationId !== undefined ? { conversationId: r.conversationId } : {}),
			});
			if (r.conversationId !== undefined) {
				await deps.store.bind(key, r.conversationId, baseline);
				deps.state?.cacheBinding(key, { conversationId: r.conversationId, ...(baseline !== undefined ? { hashes: baseline } : {}) });
			}
			// Probe 2a: a graceful-flush abort still resolved a partial envelope.
			throw new TurnAborted(r.run.envelope?.response);
		};
		if (signal?.aborted) await persistAndThrowAbort(result);
		// R8 resume-once: only the timeout family, only with a captured id, and
		// only when this run was not already the one resume.
		const canResume =
			result.classification.outcome === "timeout" && !result.resumed && result.conversationId !== undefined;
		if (canResume) {
			deps.debug?.log("resume", { key, ...(result.conversationId !== undefined ? { conversationId: result.conversationId } : {}) });
			// D7: announce BEFORE the resume attempt so the host closes the
			// streamed text and starts a fresh block.
			req.onRetry?.();
			result = await attempt(result.conversationId, true);
			note(result.conversationId);
			if (signal?.aborted) await persistAndThrowAbort(result);
		}
		if (result.classification.outcome === "success") {
			if (result.conversationId !== undefined) {
				await deps.store.bind(key, result.conversationId, baseline);
				deps.state?.cacheBinding(key, { conversationId: result.conversationId, ...(baseline !== undefined ? { hashes: baseline } : {}) });
			}
			deps.debug?.log("turn_end", {
				key,
				classification: "success",
				resumed: result.resumed,
				durationMs: Date.now() - startedAt,
				...(result.conversationId !== undefined ? { conversationId: result.conversationId } : {}),
			});
			return {
				...result,
				diverged,
				logPath,
				prompt,
				...(staged.length > 0 ? { stagedAttachments: staged } : {}),
				attachmentsInspected,
			};
		}
		// Terminal failure: a failed resumed attempt rebinds so the next turn
		// runs fresh; every family maps onto the pi error terminal.
		if (result.resumed) {
			await deps.store.rebind(key);
			deps.state?.dropBinding(key);
		}
		deps.debug?.log("turn_error", {
			key,
			classification: result.classification.outcome,
			resumed: result.resumed,
			durationMs: Date.now() - startedAt,
			...(result.conversationId !== undefined ? { conversationId: result.conversationId } : {}),
		});
		throw new TurnError(
			mapClassification(result.classification, {
				logPath,
				conversationId: result.conversationId,
				resumed: result.resumed,
				detail: result.run.envelope?.error,
			}),
		);
	} finally {
		if (tracked !== undefined) deps.state?.endTurn(key, tracked);
	}
}
