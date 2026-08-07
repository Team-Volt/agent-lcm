import { DEFAULT_LIMITS } from "./config.js";
import { sanitizeForStorage, sha256 } from "./redact.js";
export const HARNESS_NAMES = ["codex", "cursor", "vscode", "copilot", "kiro", "mcp", "import"];
export function harnessSessionId(harness, nativeId) {
    const id = nativeId.trim();
    if (!id)
        throw new Error("native session id must not be empty");
    if (id.startsWith(`${harness}:`))
        return id;
    return `${harness}:${id}`;
}
export function normalizeHookEvent(args) {
    const rawInput = Buffer.isBuffer(args.rawInput) ? args.rawInput.toString("utf8") : args.rawInput;
    const env = args.env ?? process.env;
    const now = args.now ?? (() => new Date());
    const limits = { ...DEFAULT_LIMITS, ...args.limits };
    const rawHash = sha256(rawInput);
    const timestamp = now().toISOString();
    const parsed = parseJson(rawInput);
    if (!parsed.ok) {
        const cwd = env.PWD || process.cwd();
        const sanitizedPreview = sanitizeForStorage(rawInput.slice(0, limits.maxParseErrorPreviewBytes), limits);
        const payload = {
            parse_error: true,
            raw_preview: sanitizedPreview.value,
        };
        const sessionId = codexSessionId(fallbackSessionId(args.hookEvent, cwd, rawHash));
        return finalizeEvent({
            hookEvent: args.hookEvent,
            timestamp,
            sessionId,
            cwd,
            payload,
            redactions: sanitizedPreview.redactions,
            truncations: sanitizedPreview.truncations,
            rawHash,
            originalBytes: Buffer.byteLength(rawInput),
            sanitizedBytes: sanitizedPreview.sanitizedBytes,
            repo: args.repo,
            limits,
        });
    }
    const payloadObject = isRecord(parsed.value) ? parsed.value : { value: parsed.value };
    const cwd = stringValue(payloadObject.cwd) || env.PWD || process.cwd();
    const sessionId = codexSessionId(stringValue(payloadObject.session_id) ||
        stringValue(payloadObject.sessionId) ||
        stringValue(payloadObject.conversation_id) ||
        stringValue(payloadObject.conversationId) ||
        env.CODEX_SESSION_ID ||
        fallbackSessionId(args.hookEvent, cwd, rawHash));
    const sanitized = sanitizeForStorage(payloadObject, limits);
    return finalizeEvent({
        hookEvent: args.hookEvent,
        timestamp,
        sessionId,
        cwd,
        project: stringValue(payloadObject.project),
        toolName: stringValue(payloadObject.tool_name) || stringValue(payloadObject.toolName),
        payload: sanitized.value,
        redactions: sanitized.redactions,
        truncations: sanitized.truncations,
        rawHash,
        originalBytes: sanitized.originalBytes,
        sanitizedBytes: sanitized.sanitizedBytes,
        repo: args.repo,
        limits,
    });
}
export function createNoteEvent(args) {
    const raw = JSON.stringify({
        session_id: args.sessionId,
        cwd: args.cwd,
        note: args.text,
    });
    return normalizeHookEvent({
        hookEvent: "Note",
        rawInput: raw,
        now: args.now,
        repo: args.repo,
    });
}
function finalizeEvent(args) {
    const payload = isRecord(args.payload) ? args.payload : { value: args.payload };
    const metadata = sanitizeEventMetadata({
        sessionId: args.sessionId,
        cwd: args.cwd,
        project: args.project,
        repo: args.repo,
        toolName: args.toolName,
        limits: args.limits,
    });
    const eventId = sha256(`${args.hookEvent}\0${args.sessionId}\0${args.timestamp}\0${args.rawHash}`);
    return {
        schema_version: 1,
        event_id: eventId,
        timestamp: args.timestamp,
        harness: "codex",
        native_event: args.hookEvent,
        hook_event: args.hookEvent,
        session_id: metadata.sessionId,
        cwd: metadata.cwd,
        ...(metadata.project ? { project: metadata.project } : {}),
        ...(metadata.repoRoot ? { repo_root: metadata.repoRoot } : {}),
        ...(metadata.gitBranch ? { git_branch: metadata.gitBranch } : {}),
        ...(metadata.toolName ? { tool_name: metadata.toolName } : {}),
        payload,
        redactions: [...args.redactions, ...metadata.redactions],
        truncations: [...args.truncations, ...metadata.truncations],
        raw_input_sha256: args.rawHash,
        original_bytes: args.originalBytes,
        sanitized_bytes: args.sanitizedBytes + metadata.sanitizedBytes,
    };
}
function sanitizeEventMetadata(args) {
    const sanitized = sanitizeForStorage({
        session_id: args.sessionId,
        cwd: args.cwd,
        ...(args.project ? { project: args.project } : {}),
        ...(args.repo?.repoRoot ? { repo_root: args.repo.repoRoot } : {}),
        ...(args.repo?.gitBranch ? { git_branch: args.repo.gitBranch } : {}),
        ...(args.toolName ? { tool_name: args.toolName } : {}),
    }, args.limits);
    const metadata = isRecord(sanitized.value) ? sanitized.value : {};
    return {
        sessionId: metadataString(metadata.session_id) ?? "[REDACTED:metadata]",
        cwd: metadataString(metadata.cwd) ?? "[REDACTED:metadata]",
        ...(metadataString(metadata.project) ? { project: metadataString(metadata.project) } : {}),
        ...(metadataString(metadata.repo_root) ? { repoRoot: metadataString(metadata.repo_root) } : {}),
        ...(metadataString(metadata.git_branch) ? { gitBranch: metadataString(metadata.git_branch) } : {}),
        ...(metadataString(metadata.tool_name) ? { toolName: metadataString(metadata.tool_name) } : {}),
        redactions: sanitized.redactions,
        truncations: sanitized.truncations,
        sanitizedBytes: sanitized.sanitizedBytes,
    };
}
function metadataString(value) {
    if (typeof value === "string")
        return stringValue(value);
    if (value === undefined || value === null)
        return undefined;
    return JSON.stringify(value);
}
function parseJson(rawInput) {
    try {
        return { ok: true, value: JSON.parse(rawInput) };
    }
    catch {
        return { ok: false };
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringValue(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
function fallbackSessionId(hookEvent, cwd, rawHash) {
    return `unknown-${sha256(`${hookEvent}\0${cwd}\0${rawHash}`).slice(0, 12)}`;
}
function codexSessionId(sessionId) {
    return HARNESS_NAMES.some((harness) => sessionId.startsWith(`${harness}:`))
        ? sessionId
        : harnessSessionId("codex", sessionId);
}
