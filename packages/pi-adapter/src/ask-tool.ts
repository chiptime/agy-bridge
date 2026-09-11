/**
 * The AskAgy delegation tool (spec R9): one self-contained sub-task →
 * exactly ONE engine run (turn.ts runTurn — reused, never duplicated).
 *
 * Containment (threat-matrix "Git repository selection" row): the ONLY
 * workdir authorities are the scope decision itself — scope "scratch"
 * (the default) spawns in a FRESH agy-run-* tmp dir under the validated
 * scratch root (scratch.ts, with the 7d prune), scope "worktree" spawns
 * in exactly ctx.cwd. The schema exposes NO path parameter, and nothing
 * in the prompt text can move the workdir: caller-supplied paths (extra
 * params, path-like prompt content) never reach the child's cwd or argv.
 *
 * Continuity: non-isolated calls keep conversation continuity keyed by
 * the pi session (ctx.cwd — pi exposes no session id at the tool
 * boundary, and runTurn derives the key as `options.sessionId ?? cwd`).
 * isolated:true swaps in a throwaway in-memory store, so the persistent
 * pi-sessions.json is never read or written for that call and
 * --conversation is never passed (a one-shot by construction).
 *
 * Skills: pi exposes no skills API, so the catalog arrives through the
 * deps.skillsCatalog seam (the reference bridge re-scans the skill
 * dirs); it is injected ONLY when params.skills is true, as a section
 * prepended to the user prompt.
 *
 * Registration is D4's factory job — this module only exports the
 * ToolDefinition builder (createAskAgyTool) and the pure model
 * resolution helper.
 */
import { tmpdir } from "node:os";
import type { spawn } from "node:child_process";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { BridgeState } from "./lifecycle";
import type { PiAgyModel } from "./models";
import { formatStepUpdate } from "./progress";
import type { SessionStore } from "./session-store";
import { prepareScratchWorkdir } from "./scratch";
import { normalizeResponseText } from "./stream-simple";
import { runTurn, TurnAborted, TurnError } from "./turn";

const ASK_AGY_DESCRIPTION = `Delegate a self-contained sub-task to agy. agy runs its OWN tool loop (read, write, edit, exec) and returns its final answer; it cannot see this conversation, so the prompt must carry ALL the context it needs. Use for isolated sub-tasks you do not need to drive step-by-step.

Containment: by default (scope "scratch") agy runs in a fresh temporary directory — your project files are NOT visible to it. Pass scope "worktree" ONLY when the sub-task must operate on the current project directory.

Continuity: calls in the same session continue one agy conversation by default; pass isolated:true for a one-shot with no memory of prior calls.

Skills: pass skills:true to prepend the available skill catalog (names + one-line descriptions) to the prompt.`;

const askAgyParams = Type.Object({
	prompt: Type.String({
		description: "Self-contained task for agy, with all the context it needs (it cannot see this conversation).",
	}),
	model: Type.Optional(
		Type.String({ description: "agy model id (bare id, e.g. \"gemini-3.8-flash\"); omit for agy's default." }),
	),
	thinking: Type.Optional(
		Type.Union(
			[
				Type.Literal("minimal"),
				Type.Literal("low"),
				Type.Literal("medium"),
				Type.Literal("high"),
				Type.Literal("xhigh"),
				Type.Literal("max"),
			],
			{ description: "Thinking level; routes through the model's tier map (e.g. gemini-3.8-flash + high)." },
		),
	),
	scope: Type.Optional(
		Type.Union([Type.Literal("scratch"), Type.Literal("worktree")], {
			description:
				"Where agy runs: 'scratch' (default) = fresh tmp dir under the validated scratch root, project NOT visible; 'worktree' = the current project directory.",
			default: "scratch",
		}),
	),
	isolated: Type.Optional(
		Type.Boolean({ description: "true = one-shot: no conversation continuity (no stored context, no resume)." }),
	),
	skills: Type.Optional(
		Type.Boolean({ description: "true = prepend the skill catalog (names + descriptions) to the prompt. Default off." }),
	),
});

export type AskAgyParams = Static<typeof askAgyParams>;
export type AskAgyScope = "scratch" | "worktree";
export type AskAgyThinking = NonNullable<AskAgyParams["thinking"]>;

export interface AskAgyDetails {
	scope: AskAgyScope;
	isolated: boolean;
	/** True when a non-empty skills catalog section was injected. */
	skillsInjected: boolean;
	/** The delegated child's cwd: fresh scratch dir (scratch) or ctx.cwd (worktree). */
	workdir: string;
	/** Absolute run.log path of this delegation (set on completion). */
	logPath: string;
	/** agy conversation id for continuity (present when agy reported one). */
	conversationId?: string;
	/** Requested model id and the resolved --model value. */
	model?: string;
	modelArg?: string;
	thinking?: AskAgyThinking;
	durationMs: number;
}

/** v0.2 R4: configured metadata overrides for the registered tool. */
export interface AskAgyMetadata {
	/** Tool id registered with pi; default "AskAgy". */
	name?: string;
	/** Display label; default "Ask agy". */
	label?: string;
	/** Schema description shown to the driving model; default ASK_AGY_DESCRIPTION. */
	description?: string;
}

/**
 * v0.2 R4: effective defaults from the resolved askAgy config section.
 * Explicit caller params always win over these.
 */
export interface AskAgyDefaults {
	/** Effective default mode; consumed by the S3 mode param (task 3.4). */
	defaultMode?: "read" | "none" | "full";
	/** Effective default for params.isolated. */
	defaultIsolated?: boolean;
	/** false disables the skillsCatalog seam even when params.skills is true. */
	appendSkills?: boolean;
	/** false narrows the mode enum at the schema level (consumed in S3, task 3.4). */
	allowFullMode?: boolean;
}

export interface AskAgyDeps {
	/** agy binary (config.agyBin). */
	bin: string;
	/** Persistent session store — continuity for non-isolated calls only. */
	store: SessionStore;
	/** Registry (models.ts resolveRegistry) for model/thinking resolution. */
	models?: readonly PiAgyModel[];
	/** Validated absolute scratch root (config.scratchRoot ?? os.tmpdir()). */
	scratchRoot?: string;
	/** Per-attempt hard cap; default DEFAULT_TURN_TIMEOUT_MS (turn.ts). */
	timeoutMs?: number;
	/** Scratch root for per-run run.log dirs; default os.tmpdir(). */
	logRoot?: string;
	/** Injectable spawn for tests (fed to the stream tap). */
	spawnFn?: typeof spawn;
	/** D1 engine seam: the prompt rides stdin, never argv. Default off. */
	promptViaStdin?: boolean;
	/**
	 * Lifecycle registry (R6, additive): when present, delegations register
	 * in-flight (visible in /agy status) and keep the binding cache
	 * coherent — the same wiring the main turn path got in D3.
	 */
	state?: BridgeState;
	/** Skills catalog seam (pi exposes no skills API): rendered name/description lines. */
	skillsCatalog?: () => string | undefined;
	/** v0.2 R4: configured metadata overrides (name/label/description). */
	metadata?: AskAgyMetadata;
	/** v0.2 R4: effective defaults from the resolved askAgy config section. */
	defaults?: AskAgyDefaults;
	/** Wall-clock seam (tests). */
	now?: () => number;
}

/**
 * Resolve the --model value for a delegation: the registry entry's
 * thinkingLevelMap routes a requested thinking level to the FULL tier
 * id; otherwise the entry's modelArg (the default entry passes none);
 * unknown ids pass through untouched — agy validates ids itself.
 */
export function resolveAskModelArg(
	models: readonly PiAgyModel[] | undefined,
	model: string | undefined,
	thinking: AskAgyThinking | undefined,
): string | undefined {
	const requested = model !== undefined && model.trim() !== "" ? model : undefined;
	if (requested === undefined || requested === "default") return undefined;
	const entry = models?.find((m) => m.id === requested);
	if (entry === undefined) return requested;
	if (thinking !== undefined) {
		const mapped = entry.thinkingLevelMap?.[thinking];
		if (typeof mapped === "string") return mapped;
	}
	return entry.modelArg ?? entry.id;
}

/** Isolated calls never touch the persistent store: a throwaway in-memory store gives runTurn fresh-conversation semantics with zero disk I/O. */
function isolatedStore(): SessionStore {
	return {
		get: async () => undefined,
		getEntry: async () => undefined,
		bind: async () => undefined,
		rebind: async () => undefined,
		prune: async () => 0,
	};
}

/**
 * Build the AskAgy ToolDefinition (handed to pi.registerTool by the D4
 * factory). One execute call = one runTurn call = one engine run.
 */
export function createAskAgyTool(deps: AskAgyDeps): ToolDefinition<typeof askAgyParams, AskAgyDetails> {
	return {
		// v0.2 R4: configured metadata wins field-by-field; absent fields keep
		// the v0.1 defaults.
		name: deps.metadata?.name ?? "AskAgy",
		label: deps.metadata?.label ?? "Ask agy",
		description: deps.metadata?.description ?? ASK_AGY_DESCRIPTION,
		parameters: askAgyParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const now = deps.now ?? Date.now;
			const start = now();
			// v0.2 R4: effective defaults — the config's defaultIsolated applies
			// only when the caller did not pass isolated explicitly.
			const isolated = params.isolated ?? deps.defaults?.defaultIsolated === true;
			const scope: AskAgyScope = params.scope ?? "scratch";
			const modelArg = resolveAskModelArg(deps.models, params.model, params.thinking);
			const details: AskAgyDetails = {
				scope,
				isolated,
				skillsInjected: false,
				workdir: "",
				logPath: "",
				...(params.model !== undefined ? { model: params.model } : {}),
				...(modelArg !== undefined ? { modelArg } : {}),
				...(params.thinking !== undefined ? { thinking: params.thinking } : {}),
				durationMs: 0,
			};
			// Circular-delegation guard: delegating from an agy-driven session
			// would recurse (agy calling AskAgy calling agy).
			if (ctx.model?.provider === "agy") {
				return {
					content: [
						{ type: "text", text: "AskAgy refused: the active provider is already agy — delegation would recurse." },
					],
					details,
				};
			}
			// Containment (threat row): the workdir comes from the scope
			// decision ALONE — a fresh scratch dir or ctx.cwd. No param and
			// no prompt content is ever consulted.
			details.workdir =
				scope === "worktree" ? ctx.cwd : prepareScratchWorkdir({ root: deps.scratchRoot ?? tmpdir(), now }).path;
			// Skills catalog: opt-in only, injected through the seam. v0.2 R4:
			// appendSkills:false (config) disables the seam entirely.
			const catalog =
				params.skills === true && (deps.defaults?.appendSkills ?? true) ? (deps.skillsCatalog?.() ?? "") : "";
			details.skillsInjected = catalog.trim() !== "";
			const prompt = details.skillsInjected ? `Available skills:\n${catalog.trim()}\n\n${params.prompt}` : params.prompt;
			// Non-isolated continuity is keyed by the pi session (ctx.cwd);
			// isolated calls carry no session key at all. Boundary cast: pi
			// supplies cwd on the options bag at runtime but does not declare
			// it (same defensive read as turn.ts / the reference bridge).
			const options: SimpleStreamOptions | undefined = isolated
				? signal === undefined
					? undefined
					: { signal }
				: ({ cwd: ctx.cwd, ...(signal !== undefined ? { signal } : {}) } as SimpleStreamOptions);
			const context: Context = { messages: [{ role: "user", content: prompt, timestamp: start }] };
			try {
				const result = await runTurn(
					{
						bin: deps.bin,
						store: isolated ? isolatedStore() : deps.store,
						...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
						workdir: details.workdir,
						...(deps.logRoot !== undefined ? { logRoot: deps.logRoot } : {}),
						...(deps.spawnFn !== undefined ? { spawnFn: deps.spawnFn } : {}),
						...(deps.promptViaStdin !== undefined ? { promptViaStdin: deps.promptViaStdin } : {}),
						...(deps.state !== undefined ? { state: deps.state } : {}),
					},
					{
						context,
						...(options !== undefined ? { options } : {}),
						...(modelArg !== undefined ? { modelArg } : {}),
						onStep: (step) => onUpdate?.({ content: [{ type: "text", text: formatStepUpdate(step) }], details }),
					},
				);
				details.logPath = result.logPath;
				details.durationMs = now() - start;
				if (result.conversationId !== undefined) details.conversationId = result.conversationId;
				return {
					content: [{ type: "text", text: normalizeResponseText(result.run.envelope?.response ?? "") }],
					details,
				};
			} catch (err) {
				details.durationMs = now() - start;
				if (err instanceof TurnAborted) {
					return { content: [{ type: "text", text: "agy delegation aborted before completing." }], details };
				}
				if (err instanceof TurnError) {
					return { content: [{ type: "text", text: err.mapping.message }], details };
				}
				return {
					content: [{ type: "text", text: `agy bridge failed: ${err instanceof Error ? err.message : String(err)}` }],
					details,
				};
			}
		},
	};
}
