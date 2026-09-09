// @bun
// ../../node_modules/.bun/@ai-sdk+provider@3.0.8/node_modules/@ai-sdk/provider/dist/index.mjs
var marker = "vercel.ai.error";
var symbol = Symbol.for(marker);
var _a;
var _b;
var AISDKError = class _AISDKError extends (_b = Error, _a = symbol, _b) {
  constructor({
    name: name14,
    message,
    cause
  }) {
    super(message);
    this[_a] = true;
    this.name = name14;
    this.cause = cause;
  }
  static isInstance(error) {
    return _AISDKError.hasMarker(error, marker);
  }
  static hasMarker(error, marker15) {
    const markerSymbol = Symbol.for(marker15);
    return error != null && typeof error === "object" && markerSymbol in error && typeof error[markerSymbol] === "boolean" && error[markerSymbol] === true;
  }
};
var name = "AI_APICallError";
var marker2 = `vercel.ai.error.${name}`;
var symbol2 = Symbol.for(marker2);
var _a2;
var _b2;
var APICallError = class extends (_b2 = AISDKError, _a2 = symbol2, _b2) {
  constructor({
    message,
    url,
    requestBodyValues,
    statusCode,
    responseHeaders,
    responseBody,
    cause,
    isRetryable = statusCode != null && (statusCode === 408 || statusCode === 409 || statusCode === 429 || statusCode >= 500),
    data
  }) {
    super({ name, message, cause });
    this[_a2] = true;
    this.url = url;
    this.requestBodyValues = requestBodyValues;
    this.statusCode = statusCode;
    this.responseHeaders = responseHeaders;
    this.responseBody = responseBody;
    this.isRetryable = isRetryable;
    this.data = data;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker2);
  }
};
var name2 = "AI_EmptyResponseBodyError";
var marker3 = `vercel.ai.error.${name2}`;
var symbol3 = Symbol.for(marker3);
var _a3;
var _b3;
var EmptyResponseBodyError = class extends (_b3 = AISDKError, _a3 = symbol3, _b3) {
  constructor({ message = "Empty response body" } = {}) {
    super({ name: name2, message });
    this[_a3] = true;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker3);
  }
};
function getErrorMessage(error) {
  if (error == null) {
    return "unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return JSON.stringify(error);
}
var name3 = "AI_InvalidArgumentError";
var marker4 = `vercel.ai.error.${name3}`;
var symbol4 = Symbol.for(marker4);
var _a4;
var _b4;
var InvalidArgumentError = class extends (_b4 = AISDKError, _a4 = symbol4, _b4) {
  constructor({
    message,
    cause,
    argument
  }) {
    super({ name: name3, message, cause });
    this[_a4] = true;
    this.argument = argument;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker4);
  }
};
var name4 = "AI_InvalidPromptError";
var marker5 = `vercel.ai.error.${name4}`;
var symbol5 = Symbol.for(marker5);
var _a5;
var _b5;
var InvalidPromptError = class extends (_b5 = AISDKError, _a5 = symbol5, _b5) {
  constructor({
    prompt,
    message,
    cause
  }) {
    super({ name: name4, message: `Invalid prompt: ${message}`, cause });
    this[_a5] = true;
    this.prompt = prompt;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker5);
  }
};
var name5 = "AI_InvalidResponseDataError";
var marker6 = `vercel.ai.error.${name5}`;
var symbol6 = Symbol.for(marker6);
var _a6;
var _b6;
var InvalidResponseDataError = class extends (_b6 = AISDKError, _a6 = symbol6, _b6) {
  constructor({
    data,
    message = `Invalid response data: ${JSON.stringify(data)}.`
  }) {
    super({ name: name5, message });
    this[_a6] = true;
    this.data = data;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker6);
  }
};
var name6 = "AI_JSONParseError";
var marker7 = `vercel.ai.error.${name6}`;
var symbol7 = Symbol.for(marker7);
var _a7;
var _b7;
var JSONParseError = class extends (_b7 = AISDKError, _a7 = symbol7, _b7) {
  constructor({ text, cause }) {
    super({
      name: name6,
      message: `JSON parsing failed: Text: ${text}.
Error message: ${getErrorMessage(cause)}`,
      cause
    });
    this[_a7] = true;
    this.text = text;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker7);
  }
};
var name7 = "AI_LoadAPIKeyError";
var marker8 = `vercel.ai.error.${name7}`;
var symbol8 = Symbol.for(marker8);
var _a8;
var _b8;
var LoadAPIKeyError = class extends (_b8 = AISDKError, _a8 = symbol8, _b8) {
  constructor({ message }) {
    super({ name: name7, message });
    this[_a8] = true;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker8);
  }
};
var name8 = "AI_LoadSettingError";
var marker9 = `vercel.ai.error.${name8}`;
var symbol9 = Symbol.for(marker9);
var _a9;
var _b9;
var LoadSettingError = class extends (_b9 = AISDKError, _a9 = symbol9, _b9) {
  constructor({ message }) {
    super({ name: name8, message });
    this[_a9] = true;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker9);
  }
};
var name9 = "AI_NoContentGeneratedError";
var marker10 = `vercel.ai.error.${name9}`;
var symbol10 = Symbol.for(marker10);
var _a10;
var _b10;
var NoContentGeneratedError = class extends (_b10 = AISDKError, _a10 = symbol10, _b10) {
  constructor({
    message = "No content generated."
  } = {}) {
    super({ name: name9, message });
    this[_a10] = true;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker10);
  }
};
var name10 = "AI_NoSuchModelError";
var marker11 = `vercel.ai.error.${name10}`;
var symbol11 = Symbol.for(marker11);
var _a11;
var _b11;
var NoSuchModelError = class extends (_b11 = AISDKError, _a11 = symbol11, _b11) {
  constructor({
    errorName = name10,
    modelId,
    modelType,
    message = `No such ${modelType}: ${modelId}`
  }) {
    super({ name: errorName, message });
    this[_a11] = true;
    this.modelId = modelId;
    this.modelType = modelType;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker11);
  }
};
var name11 = "AI_TooManyEmbeddingValuesForCallError";
var marker12 = `vercel.ai.error.${name11}`;
var symbol12 = Symbol.for(marker12);
var _a12;
var _b12;
var TooManyEmbeddingValuesForCallError = class extends (_b12 = AISDKError, _a12 = symbol12, _b12) {
  constructor(options) {
    super({
      name: name11,
      message: `Too many values for a single embedding call. The ${options.provider} model "${options.modelId}" can only embed up to ${options.maxEmbeddingsPerCall} values per call, but ${options.values.length} values were provided.`
    });
    this[_a12] = true;
    this.provider = options.provider;
    this.modelId = options.modelId;
    this.maxEmbeddingsPerCall = options.maxEmbeddingsPerCall;
    this.values = options.values;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker12);
  }
};
var name12 = "AI_TypeValidationError";
var marker13 = `vercel.ai.error.${name12}`;
var symbol13 = Symbol.for(marker13);
var _a13;
var _b13;
var TypeValidationError = class _TypeValidationError extends (_b13 = AISDKError, _a13 = symbol13, _b13) {
  constructor({
    value,
    cause,
    context
  }) {
    let contextPrefix = "Type validation failed";
    if (context == null ? undefined : context.field) {
      contextPrefix += ` for ${context.field}`;
    }
    if ((context == null ? undefined : context.entityName) || (context == null ? undefined : context.entityId)) {
      contextPrefix += " (";
      const parts = [];
      if (context.entityName) {
        parts.push(context.entityName);
      }
      if (context.entityId) {
        parts.push(`id: "${context.entityId}"`);
      }
      contextPrefix += parts.join(", ");
      contextPrefix += ")";
    }
    super({
      name: name12,
      message: `${contextPrefix}: Value: ${JSON.stringify(value)}.
Error message: ${getErrorMessage(cause)}`,
      cause
    });
    this[_a13] = true;
    this.value = value;
    this.context = context;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker13);
  }
  static wrap({
    value,
    cause,
    context
  }) {
    var _a15, _b15, _c;
    if (_TypeValidationError.isInstance(cause) && cause.value === value && ((_a15 = cause.context) == null ? undefined : _a15.field) === (context == null ? undefined : context.field) && ((_b15 = cause.context) == null ? undefined : _b15.entityName) === (context == null ? undefined : context.entityName) && ((_c = cause.context) == null ? undefined : _c.entityId) === (context == null ? undefined : context.entityId)) {
      return cause;
    }
    return new _TypeValidationError({ value, cause, context });
  }
};
var name13 = "AI_UnsupportedFunctionalityError";
var marker14 = `vercel.ai.error.${name13}`;
var symbol14 = Symbol.for(marker14);
var _a14;
var _b14;
var UnsupportedFunctionalityError = class extends (_b14 = AISDKError, _a14 = symbol14, _b14) {
  constructor({
    functionality,
    message = `'${functionality}' functionality not supported.`
  }) {
    super({ name: name13, message });
    this[_a14] = true;
    this.functionality = functionality;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker14);
  }
};

// src/config.ts
class AgyConfigError extends Error {
  field;
  code = "AGY_CONFIG_INVALID";
  constructor(field, message) {
    super(message);
    this.field = field;
    this.name = "AgyConfigError";
  }
}
function isPositiveInt(n) {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}
function requireAbsolute(field, value) {
  if (!value.startsWith("/")) {
    throw new AgyConfigError(field, `${field} must be an absolute path, got "${value}"`);
  }
  return value;
}
function validateModelLimits(id, limit) {
  const field = `models.${id}.limit`;
  for (const key of ["context", "output"]) {
    if (!isPositiveInt(limit?.[key])) {
      throw new AgyConfigError(field, `${field}.${key} must be a positive integer`);
    }
  }
  if (limit.output > limit.context) {
    throw new AgyConfigError(field, `${field}.output (${limit.output}) must not exceed context (${limit.context})`);
  }
}
function resolveConfig(options = {}) {
  const workdirMode = options.workdirMode ?? "scratch";
  if (workdirMode !== "scratch" && workdirMode !== "session") {
    throw new AgyConfigError("workdirMode", `workdirMode must be "scratch" or "session", got "${String(workdirMode)}"`);
  }
  if (options.scratchRoot !== undefined)
    requireAbsolute("scratchRoot", options.scratchRoot);
  if (options.stateDir !== undefined)
    requireAbsolute("stateDir", options.stateDir);
  if (options.quotaSnapshotDir !== undefined) {
    requireAbsolute("quotaSnapshotDir", options.quotaSnapshotDir);
  }
  const models = {};
  for (const [id, entry] of Object.entries(options.models ?? {})) {
    if (entry?.limit !== undefined)
      validateModelLimits(id, entry.limit);
    models[id] = entry;
  }
  if (options.timeoutMs !== undefined && !isPositiveInt(options.timeoutMs)) {
    throw new AgyConfigError("timeoutMs", `timeoutMs must be a positive integer, got ${String(options.timeoutMs)}`);
  }
  return {
    workdirMode,
    scratchRoot: options.scratchRoot,
    stateDir: options.stateDir,
    quotaSnapshotDir: options.quotaSnapshotDir,
    models,
    timeoutMs: options.timeoutMs
  };
}

// src/session-store.ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
var SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
function parseStore(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version === 1 && typeof parsed.sessions === "object" && parsed.sessions !== null) {
      return { version: 1, sessions: parsed.sessions };
    }
  } catch {}
  return { version: 1, sessions: {} };
}
function openSessionStore(path) {
  const globalSlot = { current: Promise.resolve() };
  const keyed = new Map;
  const chain = (slot, fn) => {
    const run = slot.current.then(fn, fn);
    slot.current = run.then(() => {
      return;
    }, () => {
      return;
    });
    return run;
  };
  const load = () => {
    let file;
    try {
      file = parseStore(readFileSync(path, "utf8"));
    } catch {
      return { version: 1, sessions: {} };
    }
    pruneInPlace(file, Date.now());
    return file;
  };
  const persist = (file) => {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.${Math.random().toString(36).slice(2)}-${process.pid}-${randomUUID()}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(file, null, "\t")}
`);
    renameSync(tmp, path);
  };
  const pruneInPlace = (file, now) => {
    let pruned = 0;
    for (const [id, entry] of Object.entries(file.sessions)) {
      if (!entry?.updatedAt || new Date(entry.updatedAt).getTime() <= now - SESSION_MAX_AGE_MS) {
        delete file.sessions[id];
        pruned++;
      }
    }
    return pruned;
  };
  return {
    get: (sessionId) => chain(globalSlot, () => load().sessions[sessionId]?.conversationId),
    bind: (sessionId, conversationId) => chain(keyedSlot(sessionId), () => chain(globalSlot, () => {
      const file = load();
      file.sessions[sessionId] = { conversationId, updatedAt: new Date().toISOString() };
      persist(file);
    })),
    rebind: (sessionId) => chain(keyedSlot(sessionId), () => chain(globalSlot, () => {
      const file = load();
      delete file.sessions[sessionId];
      persist(file);
    })),
    prune: (now = new Date) => chain(globalSlot, () => {
      const file = load();
      const pruned = pruneInPlace(file, now.getTime());
      if (pruned > 0)
        persist(file);
      return pruned;
    })
  };
  function keyedSlot(sessionId) {
    let slot = keyed.get(sessionId);
    if (!slot)
      keyed.set(sessionId, slot = { current: Promise.resolve() });
    return slot;
  }
}

// src/paths.ts
import { homedir, tmpdir } from "os";
import { isAbsolute, join as join2 } from "path";
function resolveStateDir(opts = {}) {
  const root = opts.override ?? xdgStateRoot(opts.env ?? process.env);
  return join2(root, "agy-bridge");
}
function xdgStateRoot(env) {
  const xdg = env["XDG_STATE_HOME"];
  if (xdg && isAbsolute(xdg))
    return xdg;
  const home = env["HOME"] || homedir();
  return join2(home, ".local", "state");
}
function sessionMapPath(opts = {}) {
  return join2(resolveStateDir(opts), "opencode-sessions.json");
}

// src/language-model.ts
import { randomUUID as randomUUID2 } from "crypto";

// ../engine/src/spawn.ts
import { mkdirSync as mkdirSync2, readdirSync, statSync, openSync, closeSync, appendFileSync } from "fs";
import { spawn } from "child_process";
import { createInterface } from "readline";
function asAgyEnvelope(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return null;
  const rec = raw;
  if (typeof rec.status !== "string")
    return null;
  return raw;
}
function parseStreamLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null)
    return {};
  const rec = parsed;
  const out = {};
  if (typeof rec.event === "string")
    out.event = rec.event;
  if (rec.event === "init" && typeof rec.conversation_id === "string")
    out.conversationId = rec.conversation_id;
  if (rec.event === "result")
    out.envelope = asAgyEnvelope(rec.result) ?? undefined;
  if (rec.event === undefined)
    out.envelope = asAgyEnvelope(parsed) ?? undefined;
  return out;
}
function buildAgyArgs(opts, outputFormat = "json") {
  const args = ["--print", opts.prompt, "--add-dir", opts.workdir, "--dangerously-skip-permissions"];
  const secs = Math.max(1, Math.floor((opts.timeoutMs - 1e4) / 1000));
  args.push("--print-timeout", `${secs}s`);
  args.push("--output-format", outputFormat);
  if (opts.resumeConversationId)
    args.push("--conversation", opts.resumeConversationId);
  if (opts.model)
    args.push("--model", opts.model);
  return args;
}
var DEFAULT_STALL_MS = 600000;
async function runAgyStream(opts) {
  mkdirSync2(opts.workdir, { recursive: true });
  const start = Date.now();
  const stallMs = opts.stallMs ?? DEFAULT_STALL_MS;
  return new Promise((resolve) => {
    const spawnFn = opts.spawnImpl ?? spawn;
    const child = spawnFn(opts.bin, buildAgyArgs(opts, "stream-json"), {
      cwd: opts.workdir,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const logFd = openSync(opts.logPath ?? `${opts.workdir}/run.log`, "w");
    let log = "";
    let envelope;
    let conversationId;
    let eventCount = 0;
    let lastEvent;
    let exitCode = null;
    let timedOut = false;
    let stalled = false;
    let spawnError;
    let settled = false;
    let stallTimer = null;
    const append = (chunk) => {
      log += chunk;
      try {
        appendFileSync(logFd, chunk);
      } catch {}
    };
    const armStall = () => {
      if (stallTimer)
        clearTimeout(stallTimer);
      if (stallMs <= 0 || settled)
        return;
      stallTimer = setTimeout(() => {
        stalled = true;
        child.kill("SIGTERM");
      }, stallMs);
    };
    const capTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);
    const finish = () => {
      if (settled)
        return;
      settled = true;
      if (stallTimer)
        clearTimeout(stallTimer);
      clearTimeout(capTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      try {
        closeSync(logFd);
      } catch {}
      resolve({
        exitCode,
        timedOut,
        log,
        elapsedMs: Date.now() - start,
        envelope,
        conversationId,
        progress: eventCount > 0 ? { events: eventCount, lastEvent } : undefined,
        stalled: stalled || undefined,
        spawnError
      });
    };
    child.on("error", (err) => {
      spawnError = err.code === "ENOENT" ? "ENOENT" : err.message;
    });
    armStall();
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      armStall();
      append(`${line}
`);
      const got = parseStreamLine(line);
      if (got.event !== undefined) {
        eventCount++;
        lastEvent = got.event;
      }
      if (got.conversationId !== undefined)
        conversationId = got.conversationId;
      if (got.envelope !== undefined)
        envelope = got.envelope;
    });
    child.stderr?.on("data", (chunk) => {
      armStall();
      append(chunk.toString("utf8"));
    });
    child.on("exit", (code) => {
      exitCode = code;
      finish();
    });
    child.on("close", (code) => {
      if (!settled)
        exitCode = code;
      finish();
    });
  });
}
// ../engine/src/outcomes.ts
var AUTH_RE = /captcha|sign.?in|log.?in required|unauthenticated|forbidden|\b401\b|invalid credentials|authentication/i;
var QUOTA_RE = /quota|rate.?limit|\b429\b|resource.?exhausted|too many requests/i;
var TRANSIENT_RE = /unavailable|outage|overloaded|connection\s+(?:refused|reset|failed)|network\s+error|\b5\d\d\b|internal error|server error/i;
var PRINT_WAIT_TIMEOUT_RE = /timeout waiting for response/i;
function classifyRun(signal) {
  const log = signal.log ?? "";
  if (signal.spawnError === "ENOENT")
    return { outcome: "transient_unavailable", reason: "agy_absent" };
  if (signal.stalled)
    return { outcome: "timeout", reason: "stall_detected" };
  if (signal.timedOut || signal.exitCode === 124)
    return { outcome: "timeout", reason: "timeout" };
  const artifactLessSuccess = signal.expectArtifact === false && signal.envelope?.status === "SUCCESS" && (signal.envelope.response ?? "").trim() !== "";
  if (signal.exitCode === 0 && (signal.artifactBytes || artifactLessSuccess)) {
    return { outcome: "success", reason: "ok" };
  }
  if (/\[agy\] print timeout after \S+ with turn in progress/i.test(log)) {
    return { outcome: "timeout", reason: "agy_print_wait_timeout" };
  }
  if (AUTH_RE.test(log))
    return { outcome: "auth_captcha", reason: "auth_or_captcha" };
  if (signal.exitCode !== 0) {
    if (signal.envelope?.status === "ERROR" && /timeout waiting for response/i.test(signal.envelope.error ?? "")) {
      return { outcome: "timeout", reason: "agy_print_wait_timeout" };
    }
    if (PRINT_WAIT_TIMEOUT_RE.test(log))
      return { outcome: "timeout", reason: "agy_print_wait_timeout" };
    if (QUOTA_RE.test(log))
      return { outcome: "quota_unavailable", reason: "quota_exhausted" };
    if (TRANSIENT_RE.test(log))
      return { outcome: "transient_unavailable", reason: "provider_outage" };
    return { outcome: "task_failure", reason: "nonzero_exit" };
  }
  if (signal.envelope?.status === "ERROR" && PRINT_WAIT_TIMEOUT_RE.test(signal.envelope.error ?? "")) {
    return { outcome: "timeout", reason: "agy_print_wait_timeout" };
  }
  if (!signal.artifactBytes)
    return { outcome: "artifact_validation_failure", reason: "artifact_missing_or_empty" };
  return { outcome: "success", reason: "ok" };
}
// ../engine/src/quota.ts
import { mkdirSync as mkdirSync3, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "fs";
var DEFAULT_THRESHOLD = 0.05;
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
var SNAPSHOT_V2_FILES = [
  { file: "gemini-5h.json", pool: "gemini", window: "fiveHour" },
  { file: "gemini-weekly.json", pool: "gemini", window: "weekly" },
  { file: "gemini-3p-5h.json", pool: "3p", window: "fiveHour" },
  { file: "gemini-3p-weekly.json", pool: "3p", window: "weekly" }
];
function remainingFraction(w) {
  if (!w)
    return null;
  const used = num(w.used), limit = num(w.limit);
  if (used === null || limit === null || limit <= 0)
    return null;
  return Math.min(1, Math.max(0, (limit - used) / limit));
}
function parseSnapshotDir(dir) {
  const found = { gemini: {}, "3p": {} };
  let any = false;
  let fetchedAt = "";
  for (const { file, pool, window: win } of SNAPSHOT_V2_FILES) {
    let w = null;
    try {
      const o = safeJson(readFileSync2(`${dir}/${file}`, "utf8"));
      w = typeof o === "object" && o !== null ? o : null;
    } catch {
      w = null;
    }
    const frac = remainingFraction(w);
    if (frac === null)
      continue;
    any = true;
    const p = found[pool];
    p[win] = frac;
    if (win === "fiveHour" && typeof w?.resets_at === "string")
      p.resetTime = w.resets_at;
    if (typeof w?.fetched_at === "string" && w.fetched_at > fetchedAt)
      fetchedAt = w.fetched_at;
  }
  if (!any)
    return null;
  const pools = {};
  for (const pool of Object.keys(found)) {
    const p = found[pool];
    pools[pool] = p.fiveHour !== undefined && p.weekly !== undefined ? { fiveHour: p.fiveHour, weekly: p.weekly, resetTime: p.resetTime } : { fiveHour: -1, weekly: -1 };
  }
  return { updatedAt: fetchedAt || undefined, pools };
}
function poolForModel(model) {
  return /^gemini/i.test(model.trim()) ? "gemini" : "3p";
}
function isStale(snap, pool, now) {
  const reset = snap.pools[pool]?.resetTime;
  return reset ? new Date(reset).getTime() <= now.getTime() : false;
}
function decidePool(snap, model, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const now = opts.now ?? new Date;
  const pool = poolForModel(model);
  const q = snap.pools[pool];
  if (!q || !q.resetTime || isStale(snap, pool, now)) {
    return { pool, allowed: true, reason: "stale_snapshot", resetTime: q?.resetTime };
  }
  if (q.fiveHour < threshold || q.weekly < threshold) {
    return { pool, allowed: false, reason: "threshold_exhausted", resetTime: q.resetTime };
  }
  return { pool, allowed: true, reason: "within_threshold", resetTime: q.resetTime };
}
// ../engine/src/models-list.ts
import { spawnSync } from "child_process";
var DEFAULT_MODELS_TIMEOUT_MS = 15000;
function parseAgyModelsOutput(stdout) {
  const models = [];
  for (const rawLine of stdout.split(`
`)) {
    const line = rawLine.trim();
    if (!line.includes("\t"))
      continue;
    const tabIndex = line.indexOf("\t");
    const id = line.slice(0, tabIndex).trim();
    const name14 = line.slice(tabIndex + 1).trim();
    if (id === "" || name14 === "")
      continue;
    models.push({ id, name: name14 });
  }
  return models;
}
async function listAgyModels(opts) {
  let run;
  try {
    run = opts.runner ? opts.runner(opts.bin) : defaultRunner(opts.bin, opts.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS);
  } catch {
    return [];
  }
  if (run.spawnError !== undefined || run.exitCode !== 0)
    return [];
  return parseAgyModelsOutput(run.stdout);
}
function defaultRunner(bin, timeoutMs) {
  try {
    const res = spawnSync(bin, ["models"], {
      encoding: "utf8",
      timeout: timeoutMs,
      env: process.env
    });
    return {
      stdout: typeof res.stdout === "string" ? res.stdout : "",
      exitCode: res.status,
      spawnError: res.error ? res.error.code ?? "spawn" : undefined
    };
  } catch {
    return { stdout: "", exitCode: null, spawnError: "spawn" };
  }
}
// src/turn.ts
import { dirname as dirname2 } from "path";

// src/stream-tap.ts
import { spawn as spawn3 } from "child_process";
function createTap(onLine, opts = {}) {
  const spawnFn = opts.spawnFn ?? spawn3;
  let child;
  let buffer = "";
  let conversationId;
  const lines = [];
  const consume = (line) => {
    if (line === "")
      return;
    lines.push(line);
    const got = parseStreamLine(line);
    if (got.conversationId !== undefined)
      conversationId = got.conversationId;
    onLine?.(line);
  };
  const tap = {
    spawnImpl: (...args) => {
      child = spawnFn(...args);
      child.stdout?.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let nl;
        while ((nl = buffer.indexOf(`
`)) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          consume(line);
        }
      });
      child.on("exit", () => {
        if (buffer !== "") {
          const rest = buffer;
          buffer = "";
          consume(rest);
        }
      });
      return child;
    },
    abort: () => {
      if (child && !child.killed)
        child.kill("SIGTERM");
    },
    get conversationId() {
      return conversationId;
    },
    get lines() {
      return lines;
    }
  };
  opts.signal?.addEventListener("abort", () => tap.abort(), { once: true });
  return tap;
}

// src/workdir.ts
import { mkdtempSync, readdirSync as readdirSync2, rmSync, statSync as statSync2 } from "fs";
import { isAbsolute as isAbsolute2, join as join3 } from "path";
import { tmpdir as tmpdir2 } from "os";
var SCRATCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
function prepareWorkdir(mode, opts) {
  if (mode === "session") {
    const worktree = opts.worktree;
    if (worktree === undefined || !isAbsolute2(worktree)) {
      throw new AgyConfigError("worktree", `session workdirMode requires an absolute worktree, got "${String(worktree)}"`);
    }
    let stat;
    try {
      stat = statSync2(worktree);
    } catch {
      stat = undefined;
    }
    if (!stat?.isDirectory()) {
      throw new AgyConfigError("worktree", `session worktree does not exist: "${worktree}"`);
    }
    return { dir: worktree, scratch: false };
  }
  const root = opts.scratchRoot ?? opts.tmpdir ?? tmpdir2();
  return { dir: mkdtempSync(join3(root, "agy-run-")), scratch: true };
}
function pruneScratch(root, now = new Date) {
  let entries;
  try {
    entries = readdirSync2(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let pruned = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("agy-run-"))
      continue;
    const dir = join3(root, entry.name);
    let mtime;
    try {
      mtime = statSync2(dir).mtime;
    } catch {
      continue;
    }
    if (mtime.getTime() > now.getTime() - SCRATCH_MAX_AGE_MS)
      continue;
    for (const inner of readdirSync2(dir)) {
      if (inner === "run.log")
        continue;
      rmSync(join3(dir, inner), { recursive: true, force: true });
    }
    pruned++;
  }
  return pruned;
}

// src/errors.ts
var withLog = (ctx, text) => `${text} Full log: ${ctx.logPath}`;
function mapClassification(c, ctx) {
  if (c.reason === "agy_absent") {
    return {
      retryable: false,
      resume: false,
      message: "agy is not installed or not on PATH \u2014 install agy to use this provider."
    };
  }
  if (c.outcome === "transient_unavailable") {
    return { retryable: true, resume: false, message: "agy provider is temporarily unavailable" };
  }
  if (c.outcome === "timeout") {
    const canResume = !ctx.resumed && ctx.conversationId !== undefined;
    if (canResume) {
      return {
        retryable: false,
        resume: true,
        message: `agy timed out mid-turn; resuming conversation ${ctx.conversationId}`
      };
    }
    return {
      retryable: false,
      resume: false,
      message: withLog(ctx, "agy timed out and could not be resumed")
    };
  }
  if (c.outcome === "auth_captcha") {
    return {
      retryable: false,
      resume: false,
      message: withLog(ctx, "agy needs re-authentication \u2014 sign in again (run agy interactively)")
    };
  }
  if (c.outcome === "quota_unavailable") {
    const reset = ctx.resetTime ? ` until ${ctx.resetTime}` : "";
    return {
      retryable: false,
      resume: false,
      message: withLog(ctx, `agy quota exhausted${reset}`)
    };
  }
  if (c.outcome === "task_failure") {
    return {
      retryable: false,
      resume: false,
      message: withLog(ctx, `agy task failed: ${ctx.detail ?? c.reason}`)
    };
  }
  return {
    retryable: false,
    resume: false,
    message: withLog(ctx, `agy returned an empty or invalid response (${c.reason})`)
  };
}

// src/turn.ts
var DEFAULT_TURN_TIMEOUT_MS = 1230000;

class TurnError extends Error {
  mapping;
  constructor(mapping) {
    super(mapping.message);
    this.mapping = mapping;
    this.name = "TurnError";
  }
}
var NO_LOG = "(no run log; the run was rejected before spawn)";
function abortError() {
  const err = new Error("agy turn aborted by the caller");
  err.name = "AbortError";
  return err;
}
async function runTurn(deps, req) {
  if (req.signal?.aborted)
    throw abortError();
  if (deps.config.quotaSnapshotDir) {
    const snapshot = parseSnapshotDir(deps.config.quotaSnapshotDir);
    if (snapshot) {
      const decision = decidePool(snapshot, req.modelArg ?? "");
      if (!decision.allowed) {
        throw new TurnError(mapClassification({ outcome: "quota_unavailable", reason: "quota_exhausted" }, {
          logPath: NO_LOG,
          resetTime: decision.resetTime
        }));
      }
    }
  }
  const workdir = prepareWorkdir(deps.config.workdirMode, {
    scratchRoot: deps.config.scratchRoot,
    worktree: deps.worktree
  });
  if (workdir.scratch)
    pruneScratch(dirname2(workdir.dir));
  const logPath = `${workdir.dir}/run.log`;
  const resumeId = await deps.store.get(req.sessionId);
  const attempt = async (resumeConversationId, resumed) => {
    const tap = createTap(req.onLine, { signal: req.signal, spawnFn: deps.spawnFn });
    const run = await runAgyStream({
      bin: deps.bin,
      prompt: req.prompt,
      workdir: workdir.dir,
      timeoutMs: deps.config.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
      model: req.modelArg,
      resumeConversationId,
      logPath,
      spawnImpl: tap.spawnImpl
    });
    const classification = classifyRun({
      exitCode: run.exitCode,
      log: run.log,
      spawnError: run.spawnError,
      timedOut: run.timedOut,
      stalled: run.stalled,
      envelope: run.envelope,
      expectArtifact: false
    });
    return {
      classification,
      run,
      resumed,
      logPath,
      conversationId: run.conversationId ?? tap.conversationId
    };
  };
  let result = await attempt(resumeId, resumeId !== undefined);
  const persistAndThrowAbort = async () => {
    if (result.conversationId)
      await deps.store.bind(req.sessionId, result.conversationId);
    throw abortError();
  };
  if (req.signal?.aborted)
    await persistAndThrowAbort();
  const canResume = result.classification.outcome === "timeout" && !result.resumed && result.conversationId !== undefined;
  if (canResume) {
    req.onResume?.();
    result = await attempt(result.conversationId, true);
    if (req.signal?.aborted)
      await persistAndThrowAbort();
  }
  if (result.classification.outcome === "success") {
    if (result.conversationId)
      await deps.store.bind(req.sessionId, result.conversationId);
    return result;
  }
  if (result.resumed)
    await deps.store.rebind(req.sessionId);
  throw new TurnError(mapClassification(result.classification, {
    logPath,
    conversationId: result.conversationId,
    resumed: result.resumed,
    detail: result.run.envelope?.error
  }));
}

// src/messages.ts
function isTextPart(p) {
  return p.type === "text" && typeof p["text"] === "string";
}
function mapMessages(messages, opts) {
  const warnings = [];
  const systemText = messages.filter((m) => m.role === "system").map((m) => typeof m.content === "string" ? m.content.trim() : "").filter((s) => s !== "").join(`

`);
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  let userText = "";
  if (typeof lastUser?.content === "string") {
    userText = lastUser.content;
  } else if (Array.isArray(lastUser?.content)) {
    const texts = [];
    for (const part of lastUser.content) {
      if (isTextPart(part)) {
        texts.push(part.text);
      } else {
        warnings.push(`dropped non-text part (type: ${String(part?.type)}) from the last user turn`);
      }
    }
    if (texts.length === 0)
      warnings.push("last user turn has no text parts");
    userText = texts.join(`
`);
  }
  const prompt = opts.isNewConversation && systemText !== "" ? `${systemText}

${userText}` : userText;
  return { prompt, warnings };
}

// src/models.ts
var DEFAULT_LIMITS = { context: 128000, output: 8192 };
function model(id, name14, modelArg) {
  return { id, name: name14, modelArg, limit: { ...DEFAULT_LIMITS }, pool: poolForModel(modelArg ?? "") };
}
var BUILTIN_MODELS = [
  model("agy/default", "default"),
  model("agy/gemini-3.8-flash-high", "gemini-3.8-flash-high", "gemini-3.8-flash-high"),
  model("agy/gemini-3.8-flash-medium", "gemini-3.8-flash-medium", "gemini-3.8-flash-medium"),
  model("agy/gemini-3.8-flash-low", "gemini-3.8-flash-low", "gemini-3.8-flash-low")
];
function normalize(id) {
  return id.startsWith("agy/") ? id.slice("agy/".length) : id;
}
function baseRegistry(discovered) {
  const base = discovered && discovered.length > 0 ? [
    model("agy/default", "default"),
    ...discovered.map((d) => model(`agy/${normalize(d.id)}`, d.name, normalize(d.id)))
  ] : [...BUILTIN_MODELS];
  const seen = new Set;
  return base.filter((m) => seen.has(m.id) ? false : seen.add(m.id));
}
function resolveRegistry(user = {}, discovered) {
  return applyConfig(baseRegistry(discovered), user);
}
function listModels(user = {}) {
  return applyConfig([...BUILTIN_MODELS], user);
}
function applyConfig(base, user) {
  const merged = base.map((m) => ({ ...m, limit: { ...m.limit } }));
  for (const [id, cfg] of Object.entries(user)) {
    const existing = merged.find((m) => m.id === id);
    if (existing) {
      if (cfg?.name !== undefined)
        existing.name = cfg.name;
      if (cfg?.limit !== undefined)
        existing.limit = { ...cfg.limit };
    } else {
      merged.push(model(id, normalize(id), normalize(id)));
    }
  }
  const seen = new Set;
  return merged.filter((m) => seen.has(m.id) ? false : seen.add(m.id));
}
function resolveModel(id, user = {}) {
  const found = listModels(user).find((m) => m.id === id || m.id === `agy/${normalize(id)}`);
  if (found)
    return found;
  const suffix = normalize(id);
  return model(`agy/${suffix}`, suffix, suffix);
}
var TRANSPORT_NPM = new URL("provider.js", import.meta.url).href;
function buildModelRecord(registry, providerId) {
  const record = {};
  for (const entry of registry) {
    const suffix = normalize(entry.id);
    record[suffix] = {
      id: suffix,
      providerID: providerId,
      api: { id: entry.modelArg ?? suffix, url: "", npm: TRANSPORT_NPM },
      name: entry.name,
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false
      },
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      limit: { context: entry.limit.context, output: entry.limit.output },
      status: "active",
      options: {},
      headers: {},
      release_date: ""
    };
  }
  return record;
}

// src/language-model.ts
function readSessionContext(providerOptions) {
  const agy = providerOptions?.["agy"];
  if (typeof agy !== "object" || agy === null)
    return {};
  const sessionId = agy["sessionId"];
  const worktree = agy["worktree"];
  return {
    sessionId: typeof sessionId === "string" && sessionId !== "" ? sessionId : undefined,
    worktree: typeof worktree === "string" && worktree !== "" ? worktree : undefined
  };
}
var EMPTY_USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined }
};
function toV3Usage(usage) {
  if (!usage)
    return EMPTY_USAGE;
  return {
    inputTokens: {
      total: usage.input_tokens,
      noCache: undefined,
      cacheRead: usage.cache_read_tokens || undefined,
      cacheWrite: undefined
    },
    outputTokens: {
      total: usage.output_tokens,
      text: undefined,
      reasoning: usage.thinking_tokens || undefined
    },
    raw: { total_tokens: usage.total_tokens }
  };
}
var STOP = { unified: "stop", raw: undefined };
function stepSummary(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return `${line}
`;
  }
  if (typeof parsed !== "object" || parsed === null)
    return `${line}
`;
  const rec = parsed;
  for (const key of ["step", "message", "description", "title", "status", "detail"]) {
    const v = rec[key];
    if (typeof v === "string" && v !== "")
      return `${v}
`;
  }
  const rest = { ...rec };
  delete rest.event;
  const compact = JSON.stringify(rest);
  return `${compact === "{}" ? "(step update)" : compact}
`;
}
function fallbackSummary(step) {
  try {
    const compact = JSON.stringify(step);
    return `${compact === "{}" ? "(step update)" : compact}
`;
  } catch {
    return `(step update)
`;
  }
}
function duration1s(durationSeconds) {
  return `${durationSeconds.toFixed(1)}s`;
}
function formatStepUpdate(step) {
  try {
    const stepType = step["step_type"];
    const state = step["state"];
    const toolName = step["tool_name"];
    const rawDuration = step["duration_seconds"];
    const duration = typeof rawDuration === "number" && Number.isFinite(rawDuration) ? rawDuration : undefined;
    if (stepType === "tool") {
      if (typeof toolName !== "string" || toolName === "")
        return fallbackSummary(step);
      if (state === "ACTIVE")
        return `\u25B8 tool ${toolName}\u2026
`;
      if (state === "DONE")
        return duration !== undefined ? `\u2713 ${toolName} (${duration1s(duration)})
` : `\u2713 ${toolName}
`;
      if (state === "ERROR")
        return `\u2717 ${toolName} failed
`;
      return fallbackSummary(step);
    }
    if (stepType === "agent_response") {
      if (state === "DONE")
        return duration !== undefined ? `\u25CF response (${duration1s(duration)})
` : `\u25CF response
`;
      return `\u25B8 response\u2026
`;
    }
    if (stepType === "user_input") {
      return `\u25B8 prompt
`;
    }
    return fallbackSummary(step);
  } catch {
    return fallbackSummary(step);
  }
}
function lineDelta(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return stepSummary(line);
  }
  if (typeof parsed === "object" && parsed !== null) {
    const inner = parsed["step_update"];
    if (typeof inner === "object" && inner !== null) {
      return formatStepUpdate(inner);
    }
  }
  return stepSummary(line);
}
var REASONING_ID = "agy-progress";
var TEXT_ID = "agy-response";

class AgyLanguageModel {
  specificationVersion = "v3";
  provider;
  modelId;
  supportedUrls = {};
  modelArg;
  deps;
  constructor(deps) {
    this.deps = deps;
    this.provider = deps.provider;
    const resolved = resolveModel(deps.modelId, deps.config.models);
    this.modelId = resolved.id;
    this.modelArg = resolved.modelArg;
  }
  async doStream(options) {
    const { deps, modelArg } = this;
    const ctx = readSessionContext(options.providerOptions);
    const sessionId = ctx.sessionId ?? randomUUID2();
    const isNewConversation = await deps.store.get(sessionId) === undefined;
    const mapping = mapMessages(options.prompt, { isNewConversation });
    const warnings = mapping.warnings.map((w) => ({ type: "other", message: w }));
    const run = deps.run ?? runTurn;
    const stream = new ReadableStream({
      async start(controller) {
        let reasoningOpen = false;
        const openReasoning = () => {
          if (!reasoningOpen) {
            controller.enqueue({ type: "reasoning-start", id: REASONING_ID });
            reasoningOpen = true;
          }
        };
        try {
          controller.enqueue({ type: "stream-start", warnings });
          const result = await run({
            bin: deps.bin ?? "agy",
            config: deps.config,
            store: deps.store,
            worktree: ctx.worktree,
            spawnFn: deps.spawnFn
          }, {
            prompt: mapping.prompt,
            modelArg,
            sessionId,
            signal: options.abortSignal,
            onLine: (line) => {
              if (!line.includes('"step_update"'))
                return;
              openReasoning();
              controller.enqueue({ type: "reasoning-delta", id: REASONING_ID, delta: lineDelta(line) });
            },
            onResume: () => {
              openReasoning();
              controller.enqueue({
                type: "reasoning-delta",
                id: REASONING_ID,
                delta: `(agy timed out mid-turn; resuming the captured conversation once)
`
              });
            }
          });
          if (reasoningOpen)
            controller.enqueue({ type: "reasoning-end", id: REASONING_ID });
          const text = result.run.envelope?.response ?? "";
          if (text !== "") {
            controller.enqueue({ type: "text-start", id: TEXT_ID });
            controller.enqueue({ type: "text-delta", id: TEXT_ID, delta: text });
            controller.enqueue({ type: "text-end", id: TEXT_ID });
          }
          controller.enqueue({
            type: "finish",
            usage: toV3Usage(result.run.envelope?.usage),
            finishReason: STOP
          });
          controller.close();
        } catch (err) {
          if (err instanceof TurnError) {
            if (reasoningOpen)
              controller.enqueue({ type: "reasoning-end", id: REASONING_ID });
            controller.enqueue({
              type: "error",
              error: new APICallError({
                message: err.mapping.message,
                url: "agy://turn",
                requestBodyValues: {},
                isRetryable: err.mapping.retryable
              })
            });
            controller.close();
            return;
          }
          controller.error(err);
        }
      }
    });
    return { stream };
  }
  async doGenerate(options) {
    const { stream } = await this.doStream(options);
    const reader = stream.getReader();
    let text = "";
    let usage = EMPTY_USAGE;
    let finishReason = STOP;
    const warnings = [];
    const content = [];
    for (;; ) {
      const { done, value } = await reader.read();
      if (done)
        break;
      switch (value.type) {
        case "stream-start":
          warnings.push(...value.warnings);
          break;
        case "text-delta":
          text += value.delta;
          break;
        case "finish":
          usage = value.usage;
          finishReason = value.finishReason;
          break;
        case "error":
          throw value.error;
        default:
          break;
      }
    }
    if (text !== "")
      content.push({ type: "text", text });
    return { content, finishReason, usage, warnings };
  }
}

// src/provider.ts
var AGY_PROVIDER_ID = "agy";
function createAgyProvider(options = {}, testDeps = {}) {
  const provider = options.name ?? AGY_PROVIDER_ID;
  const config = resolveConfig(options);
  const store = openSessionStore(sessionMapPath({ override: config.stateDir }));
  return {
    specificationVersion: "v3",
    languageModel: (modelId) => new AgyLanguageModel({
      provider,
      modelId,
      config,
      store,
      bin: testDeps.bin,
      run: testDeps.run,
      spawnFn: testDeps.spawnFn
    }),
    embeddingModel: (modelId) => {
      throw new NoSuchModelError({ modelId, modelType: "embeddingModel" });
    },
    imageModel: (modelId) => {
      throw new NoSuchModelError({ modelId, modelType: "imageModel" });
    }
  };
}
export {
  createAgyProvider,
  AGY_PROVIDER_ID
};
