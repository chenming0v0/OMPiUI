export const nativeToolInteractionImports = String.raw`
import { randomUUID as ntiUUID, createHash as ntiCreateHash, timingSafeEqual as ntiTimingSafeEqual } from "node:crypto";
import { stat as ntiStat } from "node:fs/promises";
import { isAbsolute as ntiIsAbsolute } from "node:path";
import { PtySession as ntiPtySession, IpcServer as ntiIpcServer } from "@oh-my-pi/pi-natives";
import { applyToolProxy as ntiApplyToolProxy } from "@oh-my-pi/pi-coding-agent/extensibility/tool-proxy";
import { applyDirenvPreflight as ntiDirenvPreflight } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { cfgBashDirenv as ntiDirenv, cfgBashDirenvLoadTimeoutMs as ntiDirenvTimeout, cfgBashInterceptorEnabled as ntiInterceptorEnabled, cfgBashInterceptorPatterns as ntiInterceptorPatterns } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { checkBashInterception as ntiCheckInterception } from "@oh-my-pi/pi-coding-agent/tools/bash-interceptor";
import { extractLeadingCdTarget as ntiLeadingCd } from "@oh-my-pi/pi-coding-agent/tools/shell-tokenize";
import { resolveToCwd as ntiResolveCwd } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { rewriteGitWorktreeAdd as ntiRewriteWorktree } from "@oh-my-pi/pi-coding-agent/tools/bash-worktree-rewrite";
import { cfgWorktreeClone as ntiWorktreeClone } from "@oh-my-pi/pi-coding-agent/task/settings";
import { workerHostEntry as ntiWorkerHostEntry, isCompiledBinary as ntiIsCompiled } from "@oh-my-pi/pi-utils";
import { invalidateGithubCacheForBashCommand as ntiInvalidateGithubCache } from "@oh-my-pi/pi-coding-agent/tools/gh-cache-invalidation";
import { InternalUrlRouter as ntiUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { cfgToolsMaxTimeout as ntiMaxTimeout } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { clampTimeout as ntiClampTimeout, TOOL_TIMEOUTS as ntiTimeouts } from "@oh-my-pi/pi-coding-agent/tools/tool-timeouts";
import { resolveOutputSinkHeadBytes as ntiHeadBytes, resolveOutputSinkArtifactMaxBytes as ntiArtifactBytes, resolveOutputMaxColumns as ntiMaxColumns, resolveInlineByteCapBudget as ntiInlineBudget, resolveArtifactSpillThreshold as ntiSpillThreshold } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { TerminalGraphicsDecoder as ntiGraphicsDecoder } from "@oh-my-pi/pi-coding-agent/utils/terminal-graphics";
import { toolResult as ntiToolResult } from "@oh-my-pi/pi-coding-agent/tools/tool-result";
import { ToolAbortError as ntiToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
`;

/** Insert inside the public extension factory after ownSession is defined. */
export const nativeToolInteractionSource = String.raw`
  const { OutputSink: ntiOutputSink, enforceInlineByteCap: ntiEnforceInlineCap } = pi.pi;
  const ntiEnvKeys = ["OMPIUI_TOOL_INTERACTION_ENDPOINT", "OMPIUI_TOOL_INTERACTION_TOKEN", "OMPIUI_TOOL_INTERACTION_RUNTIME_ID"];
  const ntiStateKey = Symbol.for("ompiui.nativeToolInteraction.v1");
  const ntiToolMarker = Symbol.for("ompiui.nativeToolInteraction.tool.v1");
  const ntiLaunch = ntiEnvKeys.map(key => globalThis.process?.env?.[key] ?? globalThis.Bun?.env?.[key]);
  for (const key of ntiEnvKeys) {
    if (globalThis.process?.env) delete globalThis.process.env[key];
    if (globalThis.Bun?.env) delete globalThis.Bun.env[key];
  }
  const ntiPrevious = globalThis[ntiStateKey];
  const ntiState = ntiPrevious && !ntiPrevious.closed && (!ntiLaunch[2] || ntiLaunch[2] === ntiPrevious.runtimeId)
    ? ntiPrevious
    : { runtimeId: ntiLaunch[2] ?? "", endpoint: ntiLaunch[0], token: ntiLaunch[1], records: new Map(), sessions: new WeakMap(), connections: new Set(), currentSessionId: "", available: false, reason: "Native tool interaction is not configured", closed: false };
  if (ntiState.runtimeId) globalThis[ntiStateKey] = ntiState;
  const ntiFrameBytes = 64 * 1024;
  const ntiInputBytes = 32 * 1024;
  const ntiReplayBytes = 2 * 1024 * 1024;
  const ntiLeaseMs = 60 * 1000;
  function ntiFail(code, message) { throw Object.assign(new Error(message), { code }); }
  function ntiString(value, label, max = 256) {
    if (typeof value !== "string" || !value || value.length > max) ntiFail("INVALID_REQUEST", "Invalid " + label);
    return value;
  }
  function ntiInteger(value, min, max, label) {
    if (!Number.isSafeInteger(value) || value < min || value > max) ntiFail("INVALID_REQUEST", "Invalid " + label);
    return value;
  }
  function ntiHash(value) { return ntiCreateHash("sha256").update(value, "utf8").digest("hex"); }
  function ntiTokenMatches(value) {
    if (typeof value !== "string" || typeof ntiState.token !== "string") return false;
    const a = Buffer.from(value), b = Buffer.from(ntiState.token);
    return a.length === b.length && ntiTimingSafeEqual(a, b);
  }
  function ntiUtf8Prefix(text, maxBytes) {
    if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) lo = mid;
      else hi = mid - 1;
    }
    if (lo > 0 && /[\uD800-\uDBFF]/u.test(text[lo - 1]) && /[\uDC00-\uDFFF]/u.test(text[lo] ?? "")) lo--;
    return text.slice(0, lo);
  }
  function ntiAppend(record, chunk, final = false) {
    let text = (record.pendingSurrogate ?? "") + chunk;
    record.pendingSurrogate = "";
    if (!final && /[\uD800-\uDBFF]/u.test(text.slice(-1))) {
      record.pendingSurrogate = text.slice(-1);
      text = text.slice(0, -1);
    }
    text = text.toWellFormed();
    if (!text) return;
    record.cursor += text.length;
    const last = record.chunks.length - 1;
    if (last >= 0 && record.chunks[last].length + text.length <= 8192) record.chunks[last] += text;
    else record.chunks.push(text);
    record.outputBytes += Buffer.byteLength(text, "utf8");
    while (record.outputBytes > ntiReplayBytes) {
      const first = record.chunks[0];
      const bytes = Buffer.byteLength(first, "utf8");
      const excess = record.outputBytes - ntiReplayBytes;
      if (bytes <= excess) {
        record.chunks.shift(); record.outputBytes -= bytes; record.oldestCursor += first.length;
      } else {
        let cut = ntiUtf8Prefix(first, excess).length;
        if (Buffer.byteLength(first.slice(0, cut), "utf8") < excess) cut += first.codePointAt(cut) > 0xffff ? 2 : 1;
        record.chunks[0] = first.slice(cut);
        record.outputBytes -= Buffer.byteLength(first.slice(0, cut), "utf8"); record.oldestCursor += cut;
      }
    }
  }
  function ntiDescribe(record) {
    const { runtimeId, sessionId, toolCallId, executionId, status, command, cwd, cols, rows, cursor, oldestCursor, pid, exitCode, cancelled, timedOut, error } = record;
    return { protocolVersion: 1, runtimeId, sessionId, toolCallId, executionId, status, command, cwd, cols, rows, cursor, oldestCursor, ...(pid === undefined ? {} : { pid }), ...(exitCode === undefined ? {} : { exitCode }), ...(cancelled === undefined ? {} : { cancelled }), ...(timedOut === undefined ? {} : { timedOut }), ...(error === undefined ? {} : { error }) };
  }
  function ntiCleanup() {
    const now = Date.now();
    const exited = [...ntiState.records.values()].filter(record => record.status === "exited").sort((a, b) => b.exitedAt - a.exitedAt);
    for (let index = 0; index < exited.length; index++) {
      const record = exited[index];
      if (index >= 32 || now - record.exitedAt >= 10 * 60 * 1000) ntiState.records.delete(record.executionId);
    }
    for (const record of ntiState.records.values()) if (record.lease && record.lease.expiresAt <= now) record.lease = null;
  }
  function ntiSnapshot(sessionId = ntiState.currentSessionId) {
    ntiCleanup();
    if (sessionId !== ntiState.currentSessionId) ntiFail("SESSION_MISMATCH", "Tool interaction is scoped to the current native session");
    return { protocolVersion: 1, runtimeId: ntiState.runtimeId, available: ntiState.available, ...(ntiState.reason ? { reason: ntiState.reason } : {}), executions: [...ntiState.records.values()].filter(record => record.sessionId === sessionId).map(ntiDescribe) };
  }
  function ntiRecord(args) {
    for (const key of ["runtimeId", "sessionId", "toolCallId", "executionId"]) ntiString(args[key], key);
    if (args.runtimeId !== ntiState.runtimeId || args.sessionId !== ntiState.currentSessionId) ntiFail("IDENTITY_MISMATCH", "Tool execution identity is not current");
    const record = ntiState.records.get(args.executionId);
    if (!record || ["runtimeId", "sessionId", "toolCallId", "executionId"].some(key => record[key] !== args[key])) ntiFail("EXECUTION_NOT_FOUND", "Tool execution not found");
    return record;
  }
  function ntiLease(record, args, renew = false) {
    ntiString(args.writerId, "writerId"); ntiString(args.writerEpoch, "writerEpoch");
    const lease = record.lease;
    if (!lease || lease.expiresAt <= Date.now()) { record.lease = null; ntiFail("LEASE_EXPIRED", "Writer lease expired; claim a new epoch explicitly"); }
    if (lease.writerId !== args.writerId || lease.writerEpoch !== args.writerEpoch) ntiFail("LEASE_BUSY", "Another writer owns this execution");
    if (renew) lease.expiresAt = Date.now() + ntiLeaseMs;
    return lease;
  }
  function ntiRead(record, args) {
    const requested = args.cursor === undefined ? record.oldestCursor : ntiInteger(args.cursor, 0, record.cursor, "cursor");
    const maxBytes = args.maxBytes === undefined ? 8192 : ntiInteger(args.maxBytes, 4, ntiInputBytes, "maxBytes");
    const reset = requested < record.oldestCursor;
    const fromCursor = reset ? record.oldestCursor : requested;
    const retained = record.chunks.join("");
    const offset = fromCursor - record.oldestCursor;
    if (offset > 0 && /[\uD800-\uDBFF]/u.test(retained[offset - 1]) && /[\uDC00-\uDFFF]/u.test(retained[offset] ?? "")) ntiFail("INVALID_CURSOR", "Cursor splits a Unicode code point");
    let data = ntiUtf8Prefix(retained.slice(offset), maxBytes);
    const result = () => ({ descriptor: ntiDescribe(record), fromCursor, cursor: fromCursor + data.length, data, reset });
    while (data && Buffer.byteLength(JSON.stringify({ id: args.id, ok: true, data: result() }) + "\n", "utf8") > ntiFrameBytes) data = ntiUtf8Prefix(data, Math.floor(Buffer.byteLength(data, "utf8") / 2));
    return result();
  }
  function ntiStop(record) {
    if (record.status === "exited" || record.stopRequested) return;
    record.stopRequested = true; record.cancelled = true;
    record.controller.abort();
  }
  function ntiOperation(args) {
    ntiCleanup();
    if (args.operation === "list") return ntiSnapshot(ntiString(args.sessionId, "sessionId"));
    const record = ntiRecord(args);
    if (args.operation === "describe") return ntiDescribe(record);
    if (args.operation === "read") return ntiRead(record, args);
    if (args.operation === "claim") {
      ntiString(args.writerId, "writerId");
      if (args.writerEpoch !== undefined) ntiString(args.writerEpoch, "writerEpoch");
      if (record.lease) return { ...ntiLease(record, args, true) };
      if (args.writerEpoch !== undefined) ntiFail("LEASE_EXPIRED", "The requested writer epoch no longer exists");
      if (record.status === "exited") ntiFail("EXECUTION_EXITED", "Tool execution has exited");
      record.lease = { writerId: args.writerId, writerEpoch: ntiUUID(), lastAcceptedSequence: 0, expiresAt: Date.now() + ntiLeaseMs };
      record.lastInput = null;
      return { ...record.lease };
    }
    if (args.operation === "release") { ntiLease(record, args); record.lease = null; return { released: true }; }
    if (args.operation === "cancel") { ntiLease(record, args); ntiStop(record); return { cancelled: true }; }
    if (args.operation === "resize") {
      ntiLease(record, args);
      ntiInteger(args.cols, 2, 500, "cols"); ntiInteger(args.rows, 2, 200, "rows");
      if (record.status !== "running") ntiFail("EXECUTION_NOT_RUNNING", "Tool execution is not running");
      try { record.pty.resize(args.cols, args.rows); } catch { ntiFail("RESIZE_UNKNOWN", "PTY resize failed; resulting dimensions are unknown"); }
      record.cols = args.cols; record.rows = args.rows; ntiLease(record, args, true);
      return { cols: record.cols, rows: record.rows };
    }
    if (args.operation !== "input") ntiFail("UNSUPPORTED_OPERATION", "Unsupported tool interaction operation");
    const lease = ntiLease(record, args);
    ntiInteger(args.sequence, 1, Number.MAX_SAFE_INTEGER, "sequence");
    if (typeof args.data !== "string" || Buffer.byteLength(args.data, "utf8") > ntiInputBytes || args.data !== args.data.toWellFormed()) ntiFail("INVALID_INPUT", "Input must be valid Unicode and at most 32 KiB UTF-8");
    const hash = ntiHash(args.data);
    if (args.sequence === lease.lastAcceptedSequence) {
      if (!record.lastInput || record.lastInput.hash !== hash) ntiFail("SEQUENCE_CONFLICT", "Sequence was already accepted with different data");
      ntiLease(record, args, true);
      return { sequence: args.sequence, lastAcceptedSequence: lease.lastAcceptedSequence };
    }
    if (args.sequence !== lease.lastAcceptedSequence + 1) ntiFail("SEQUENCE_GAP", "Input sequences must be consecutive");
    if (record.uncertainInput) ntiFail("INPUT_ACK_UNKNOWN", "A previous PTY write failed; delivery is unknown, do not replay it");
    if (record.status !== "running") ntiFail("EXECUTION_NOT_RUNNING", "Tool execution is not running");
    const now = Date.now();
    record.rateBytes = Math.min(4 * 1024 * 1024, record.rateBytes + Math.max(0, now - record.rateAt) * 1024 * 1024 / 1000);
    record.rateFrames = Math.min(60, record.rateFrames + Math.max(0, now - record.rateAt) * 60 / 1000); record.rateAt = now;
    const bytes = Buffer.byteLength(args.data, "utf8");
    if (record.rateBytes < bytes || record.rateFrames < 1) ntiFail("INPUT_RATE_LIMIT", "PTY input rate limit exceeded");
    record.rateBytes -= bytes; record.rateFrames--;
    try { record.pty.write(args.data); } catch { record.uncertainInput = { sequence: args.sequence, hash }; ntiFail("INPUT_ACK_UNKNOWN", "PTY write failed; delivery is unknown, do not replay it"); }
    lease.lastAcceptedSequence = args.sequence; record.lastInput = { hash }; ntiLease(record, args, true);
    return { sequence: args.sequence, lastAcceptedSequence: lease.lastAcceptedSequence };
  }
  function ntiConnection(connection) {
    if (ntiState.connections.size >= 8 || ntiState.closed) { connection.destroy(); return; }
    ntiState.connections.add(connection);
    let authenticated = false, detached = false, pumping = false, queuedBytes = 0, closing = false;
    const queue = [];
    const detach = () => { detached = true; clearTimeout(authTimer); queue.length = 0; queuedBytes = 0; ntiState.connections.delete(connection); };
    const authTimer = setTimeout(() => { connection.destroy(); detach(); }, 5000); authTimer.unref?.();
    const pump = async () => {
      if (pumping || detached) return;
      pumping = true;
      try {
        while (queue.length && !connection.closed && !detached) {
          const text = queue.shift(); queuedBytes -= Buffer.byteLength(text, "utf8");
          if (!connection.send(text)) await connection.drained();
        }
        if (closing && !detached) { connection.end(); detach(); }
      } catch { connection.destroy(); detach(); }
      finally { pumping = false; }
    };
    const send = frame => {
      if (detached || connection.closed) return;
      let text = JSON.stringify(frame);
      if (Buffer.byteLength(text + "\n", "utf8") > ntiFrameBytes) text = JSON.stringify({ id: frame.id, ok: false, error: { code: "FRAME_TOO_LARGE", message: "Tool interaction response exceeds 64 KiB" } });
      if (queue.length >= 64 || queuedBytes + Buffer.byteLength(text, "utf8") > 512 * 1024) { connection.destroy(); detach(); return; }
      queue.push(text); queuedBytes += Buffer.byteLength(text, "utf8"); void pump();
    };
    connection.start(line => {
      if (detached || closing) return;
      let request;
      try {
        if (Buffer.byteLength(line, "utf8") > ntiFrameBytes) ntiFail("FRAME_TOO_LARGE", "Request exceeds 64 KiB");
        request = JSON.parse(line);
        if (!request || typeof request !== "object" || Array.isArray(request)) ntiFail("INVALID_REQUEST", "Expected a JSON object");
        ntiString(request.id, "request id", 128);
        if (!authenticated) {
          if (request.operation !== "hello" || !ntiTokenMatches(request.token)) ntiFail("AUTH_REQUIRED", "Authenticate this connection with hello first");
          if (request.protocolVersion !== 1) ntiFail("PROTOCOL_VERSION", "Tool interaction protocol version 1 is required");
          authenticated = true; clearTimeout(authTimer);
          send({ id: request.id, ok: true, data: ntiSnapshot() }); return;
        }
        if (request.token !== undefined || request.operation === "hello") ntiFail("INVALID_REQUEST", "Credentials are only accepted in the initial hello");
        send({ id: request.id, ok: true, data: ntiOperation(request) });
      } catch (error) {
        if (!authenticated) closing = true;
        send({ id: typeof request?.id === "string" && request.id.length <= 128 ? request.id : null, ok: false, error: { code: typeof error?.code === "string" ? error.code : "INVALID_REQUEST", message: error instanceof Error ? error.message : "Invalid request" } });
      }
    }, detach);
    connection.unref();
  }
  async function ntiListen() {
    if (ntiState.server || ntiState.listening || ntiState.closed) return ntiState.listening;
    if (!ntiState.endpoint || !ntiState.token || !ntiState.runtimeId) return;
    if (!ntiIsAbsolute(ntiState.endpoint) && !ntiState.endpoint.startsWith("\\\\.\\pipe\\")) { ntiState.reason = "Tool interaction endpoint must be absolute"; return; }
    ntiState.listening = (async () => {
      try {
        const server = await ntiIpcServer.listen(ntiState.endpoint, { framing: "lines", maxFrameBytes: ntiFrameBytes }, ntiConnection);
        if (ntiState.closed) { await server.close(); return; }
        ntiState.server = server; server.unref();
        ntiState.cleanupTimer = setInterval(ntiCleanup, 60 * 1000); ntiState.cleanupTimer.unref?.();
      } catch { ntiState.available = false; ntiState.reason = "Private native tool interaction endpoint is unavailable"; }
      finally { ntiState.listening = null; }
    })();
    return ntiState.listening;
  }
  async function ntiPreflight(session, captured, params, signal) {
    if (signal?.aborted) throw new ntiToolAbortError("Command aborted");
    if (typeof params.command !== "string") ntiFail("INVALID_REQUEST", "A bash command is required");
    let command = params.command, cwd = params.cwd;
    if (!cwd) { const cd = ntiLeadingCd(command); if (cd) { cwd = cd.path; command = cd.rest; } }
    const settings = session.settings;
    const approval = captured.approval?.({ command: params.command });
    if (approval && typeof approval === "object" && approval.policy === "deny") ntiFail("PERMISSION_DENIED", approval.reason ?? "Command denied by native bash policy");
    if (ntiInterceptorEnabled.get(settings)) {
      const rules = ntiInterceptorPatterns.get(settings);
      for (const candidate of command === params.command ? [command] : [params.command, command]) {
        const result = ntiCheckInterception(candidate, session.getEnabledToolNames(), rules, params.command);
        if (result.block) ntiFail("PERMISSION_DENIED", result.message ?? "Command blocked");
      }
    }
    if (ntiWorktreeClone.get(settings)) {
      const hostEntry = ntiWorkerHostEntry();
      if (!ntiIsCompiled() && !hostEntry) ntiFail("CAPABILITY_DISABLED", "Native worktree command host is unavailable; nothing was launched");
      command = ntiRewriteWorktree(command, ntiIsCompiled() ? [process.execPath] : [process.execPath, hostEntry]);
    }
    ntiInvalidateGithubCache(command);
    if (cwd && ntiUrlRouter.instance().canHandle(cwd)) ntiFail("INVALID_CWD", "PTY commands need a host directory, not an embedded URL directory");
    const sessionCwd = session.sessionManager.getCwd();
    const commandCwd = cwd ? ntiResolveCwd(cwd, sessionCwd) : sessionCwd;
    let cwdStat;
    try { cwdStat = await ntiStat(commandCwd); } catch (error) { if (error?.code === "ENOENT") ntiFail("INVALID_CWD", "Working directory does not exist: " + commandCwd); throw error; }
    if (!cwdStat.isDirectory()) ntiFail("INVALID_CWD", "Working directory is not a directory: " + commandCwd);
    const requestedTimeoutSec = params.timeout ?? 300;
    if (!Number.isFinite(requestedTimeoutSec)) ntiFail("INVALID_REQUEST", "Invalid timeout");
    const maximum = ntiMaxTimeout.get(settings);
    const timeoutSec = requestedTimeoutSec === 0 ? undefined : ntiClampTimeout("bash", requestedTimeoutSec, maximum);
    const timeoutMs = timeoutSec === undefined ? undefined : timeoutSec * 1000;
    const sessionEnv = { PI_SESSION_ID: session.sessionManager.getSessionId(), PI_SESSION_FILE: session.sessionManager.getSessionFile() ?? "" };
    for (const key of ntiEnvKeys) sessionEnv[key] = "";
    const preflight = await ntiDirenvPreflight(command, commandCwd, { callerEnv: sessionEnv, signal, timeoutMs: ntiDirenvTimeout.get(settings), callerTimeoutMs: timeoutMs, direnvSetting: ntiDirenv.get(settings) });
    const { shell, env: shellEnv } = settings.getShellConfig();
    const { GIT_EDITOR, GPG_TTY, CI, NO_COLOR, ...interactiveEnv } = shellEnv;
    const env = { ...interactiveEnv, TERM: "xterm-256color", ...preflight.env };
    for (const key of ntiEnvKeys) env[key] = "";
    const notices = [];
    if (timeoutSec !== undefined && timeoutSec !== requestedTimeoutSec) {
      const limit = maximum > 0 && timeoutSec === maximum && maximum < ntiTimeouts.bash.max ? "global tools.maxTimeout ceiling " + maximum + "s" : "allowed range " + ntiTimeouts.bash.min + "-" + ntiTimeouts.bash.max + "s";
      notices.push("Timeout clamped to " + timeoutSec + "s (requested " + requestedTimeoutSec + "s; " + limit + ").");
    }
    if (params.ready && ((typeof params.ready.log === "string" && params.ready.log.trim()) || (Number.isFinite(params.ready.port) && params.ready.port !== 0))) notices.push("Ignored ready: service-only, and no service name was given.");
    if (signal?.aborted) throw new ntiToolAbortError("Command aborted");
    return { command: preflight.command, cwd: commandCwd, shell, env, timeoutMs, timeoutSec, requestedTimeoutSec, notices };
  }
  async function ntiCompletedResult(session, record, run, summary, images, preflight, wallTimeMs, signal) {
    const output = summary.output || "";
    const artifactNotice = summary.artifactError ? "\n\n[Full output was not saved completely (artifact " + summary.artifactError + " failed)]" : "";
    if (run.cancelled && !run.timedOut) {
      const message = (output ? output + "\n\n[Command aborted]" : "Command aborted") + artifactNotice;
      if (signal?.aborted) throw new ntiToolAbortError(message);
      throw new Error(message);
    }
    if (run.exitCode === undefined && !run.timedOut) throw new Error((output || "(no output)") + "\n\nCommand failed: missing exit status" + artifactNotice);
    const wallTimeNoticeEmitted = wallTimeMs >= 1000;
    const details = { toolInteraction: ntiDescribe(record), wallTimeMs, wallTimeNoticeEmitted, ...(preflight.timeoutSec === undefined ? { timeoutDisabled: true } : { timeoutSeconds: preflight.timeoutSec }), ...(preflight.timeoutSec !== undefined && preflight.requestedTimeoutSec !== preflight.timeoutSec ? { requestedTimeoutSeconds: preflight.requestedTimeoutSec } : {}), ...(run.exitCode !== undefined && run.exitCode !== 0 ? { exitCode: run.exitCode } : {}), ...(run.timedOut ? { timedOut: true } : {}) };
    const lines = [output || "(no output)"];
    if (wallTimeNoticeEmitted) lines.push("", "Wall time: " + (wallTimeMs / 1000).toFixed(2) + " seconds");
    for (const notice of preflight.notices) lines.push("", notice);
    if (run.exitCode !== undefined && run.exitCode !== 0) lines.push("", "Command exited with code " + run.exitCode);
    if (run.timedOut) lines.push("", "[Command timed out" + (preflight.timeoutSec === undefined ? "" : " after " + preflight.timeoutSec + " seconds") + "]");
    const text = await ntiEnforceInlineCap(lines.join("\n"), { maxBytes: ntiInlineBudget(session.settings), saveArtifact: summary.artifactError ? undefined : async full => { try { return summary.artifactId ?? await session.sessionManager.saveArtifact(full, "bash-original"); } catch { return undefined; } } });
    const builder = ntiToolResult(details).content([{ type: "text", text }, ...images]).truncationFromSummary(summary, { direction: "tail" });
    if (run.timedOut || (run.exitCode !== undefined && run.exitCode !== 0)) builder.error();
    return builder.done();
  }
  async function ntiExecute(toolCallId, params, signal, onUpdate, ctx) {
    if (params.pty !== true || params.async === true || params.name !== undefined) {
      if (typeof ctx.invokeTool !== "function") ntiFail("CAPABILITY_DISABLED", "Native bash delegation is unavailable");
      return await ctx.invokeTool(params);
    }
    const session = ownSession(ctx), registration = ntiState.sessions.get(session);
    if (!registration || !ntiState.available || !ntiState.server || ntiState.closed) ntiFail("CAPABILITY_DISABLED", ntiState.reason || "Native PTY interaction is unavailable");
    ntiString(toolCallId, "toolCallId");
    const sessionId = session.sessionManager.getSessionId();
    const preflight = await ntiPreflight(session, registration.captured, params, signal);
    if (sessionId !== session.sessionManager.getSessionId() || sessionId !== ntiState.currentSessionId) ntiFail("SESSION_MISMATCH", "Session changed during PTY preflight; nothing was launched");
    ntiCleanup();
    if ([...ntiState.records.values()].filter(record => record.status !== "exited").length >= 16) ntiFail("EXECUTION_LIMIT", "Too many native PTY executions");
    const controller = new AbortController();
    const record = { runtimeId: ntiState.runtimeId, sessionId, toolCallId, executionId: ntiUUID(), command: params.command, cwd: preflight.cwd, cols: 80, rows: 24, status: "starting", cursor: 0, oldestCursor: 0, chunks: [], outputBytes: 0, lease: null, controller, pty: null, rateBytes: 4 * 1024 * 1024, rateFrames: 60, rateAt: Date.now() };
    ntiState.records.set(record.executionId, record);
    const abort = () => ntiStop(record);
    signal?.addEventListener("abort", abort, { once: true });
    let sink, graphics, chunkError, lastPreviewAt = -Infinity;
    const publish = force => {
      if (!onUpdate || (!force && performance.now() - lastPreviewAt < 100)) return;
      lastPreviewAt = performance.now();
      onUpdate({ content: [{ type: "text", text: sink?.preview() ?? "" }], details: { toolInteraction: ntiDescribe(record) } });
    };
    const startedAt = performance.now();
    try {
      let artifact = {};
      try { artifact = await session.sessionManager.allocateArtifactPath("bash"); } catch {}
      if (signal?.aborted || controller.signal.aborted || ntiState.closed) throw new ntiToolAbortError("Command aborted");
      if (sessionId !== session.sessionManager.getSessionId() || sessionId !== ntiState.currentSessionId) ntiFail("SESSION_MISMATCH", "Session changed before PTY launch; nothing was launched");
      graphics = new ntiGraphicsDecoder();
      sink = new ntiOutputSink({ artifactPath: artifact.path, artifactId: artifact.id, spillThreshold: ntiSpillThreshold(session.settings), headBytes: ntiHeadBytes(session.settings), artifactMaxBytes: ntiArtifactBytes(session.settings), maxColumns: ntiMaxColumns(session.settings) });
      record.pty = new ntiPtySession();
      publish(true);
      const run = await record.pty.start({ command: preflight.command, cwd: preflight.cwd, shell: preflight.shell, env: preflight.env, cols: record.cols, rows: record.rows, timeoutMs: preflight.timeoutMs, signal: controller.signal }, (error, chunk) => {
        if (error) { chunkError = error; ntiStop(record); return; }
        if (record.status === "exited" || !chunk) return;
        ntiAppend(record, chunk);
        const clean = graphics.push(chunk); if (clean) sink.push(clean.replace(/\r\n?/gu, "\n"));
        publish(false);
      }, (error, pid) => {
        if (error) { chunkError = error; return; }
        record.pid = pid; record.status = "running"; publish(true);
      });
      ntiAppend(record, "", true);
      const tail = graphics.finish(); if (tail) sink.push(tail);
      record.status = "exited"; record.exitCode = run.exitCode; record.cancelled = run.cancelled; record.timedOut = run.timedOut; record.exitedAt = Date.now();
      if (chunkError) record.error = "PTY output delivery failed";
      const [summary, images] = await Promise.all([sink.dump(), graphics.images()]);
      publish(true);
      if (chunkError) throw new Error("PTY output delivery failed; transcript may be incomplete");
      return await ntiCompletedResult(session, record, run, summary, images, preflight, performance.now() - startedAt, signal);
    } catch (error) {
      if (record.status !== "exited") { ntiStop(record); record.status = "exited"; record.exitedAt = Date.now(); record.error = error instanceof Error ? error.message : "PTY execution failed"; }
      publish(true);
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      await sink?.dispose(); record.pty = null; record.controller = null; ntiCleanup();
    }
  }
  async function ntiInstall(_event, ctx) {
    const session = ownSession(ctx);
    ntiState.currentSessionId = session.sessionManager.getSessionId();
    const info = pi.getAllTools().find(tool => tool.name === "bash");
    const previous = ntiState.sessions.get(session);
    if (info?.sourceInfo?.source === "builtin") {
      const captured = session.getToolByName("bash");
      if (!captured || typeof captured.execute !== "function") { ntiState.available = false; ntiState.reason = "Native bash tool is unavailable"; return; }
      const definition = { execute: ntiExecute, [ntiToolMarker]: ntiState };
      ntiApplyToolProxy(captured, definition);
      ntiState.sessions.set(session, { captured, definition });
      pi.registerTool(definition);
    } else if (!previous || session.getToolByName("bash")?.[ntiToolMarker] !== ntiState) {
      ntiState.available = false; ntiState.reason = "Another extension owns bash; native interaction did not override it";
      await ntiListen(); return;
    }
    await ntiListen();
    ntiState.available = !!ntiState.server;
    ntiState.reason = ntiState.available ? undefined : "Private native tool interaction endpoint is unavailable";
  }
  if (ntiState.runtimeId) pi.on("session_start", ntiInstall);
  if (ntiState.runtimeId) pi.on("session_switch", (_event, ctx) => {
    const session = ownSession(ctx);
    ntiState.currentSessionId = session.sessionManager.getSessionId();
    const registration = ntiState.sessions.get(session);
    ntiState.available = !!ntiState.server && !!registration && session.getToolByName("bash")?.[ntiToolMarker] === ntiState;
    ntiState.reason = ntiState.available ? undefined : "Native bash interaction is not installed in this session";
  });
  if (ntiState.runtimeId) pi.on("session_shutdown", async () => {
    if (ntiState.closed) return;
    ntiState.closed = true; ntiState.available = false;
    clearInterval(ntiState.cleanupTimer);
    for (const record of ntiState.records.values()) ntiStop(record);
    for (const connection of ntiState.connections) connection.destroy();
    ntiState.connections.clear();
    await ntiState.server?.close();
    ntiState.token = undefined;
  });
`;
