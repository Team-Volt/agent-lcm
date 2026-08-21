import { harnessSessionId, normalizeHookEvent } from "./events.js";
import { sha256 } from "./redact.js";
const EVENT_MAP = {
    codex: { SessionStart: "SessionStart", UserPromptSubmit: "UserPromptSubmit", PostToolUse: "PostToolUse", Stop: "Stop" },
    cursor: { SessionStart: "SessionStart", UserPromptSubmit: "UserPromptSubmit", PostToolUse: "PostToolUse", Stop: "Stop" },
    vscode: { SessionStart: "SessionStart", UserPromptSubmit: "UserPromptSubmit", PostToolUse: "PostToolUse", Stop: "Stop" },
    copilot: { sessionStart: "SessionStart", userPromptSubmitted: "UserPromptSubmit", postToolUse: "PostToolUse", sessionEnd: "Stop" },
    kiro: { SessionStart: "SessionStart", UserPromptSubmit: "UserPromptSubmit", PostToolUse: "PostToolUse", Stop: "Stop" },
    claude: { SessionStart: "SessionStart", UserPromptSubmit: "UserPromptSubmit", PostToolUse: "PostToolUse", Stop: "Stop" },
    opencode: { SessionStart: "SessionStart", UserPromptSubmit: "UserPromptSubmit", PostToolUse: "PostToolUse", Stop: "Stop" },
};
const KIRO_ALIASES = {
    sessionStart: "SessionStart",
    userPromptSubmitted: "UserPromptSubmit",
    postToolUse: "PostToolUse",
    sessionEnd: "Stop",
};
const VSCODE_ALIASES = {
    sessionStart: "SessionStart",
    userPromptSubmitted: "UserPromptSubmit",
    postToolUse: "PostToolUse",
    sessionEnd: "Stop",
};
export function mapHarnessEvent(requestedHarness, nativeEvent, input, options = {}) {
    const payload = recordInput(input);
    const eventName = nativeEvent?.trim() || eventNameFrom(payload);
    if (!eventName)
        throw new Error("Capture event name is required.");
    const harness = requestedHarness === "auto" ? detectHarness(payload, eventName) : requestedHarness;
    const hookEvent = mappedEvent(harness, eventName);
    const rawInput = typeof input === "string" ? input : JSON.stringify(input);
    const normalized = normalizeHookEvent({
        hookEvent,
        rawInput,
        env: options.env,
        now: options.now,
        repo: options.repo,
        limits: options.limits,
    });
    const nativeId = stripHarnessPrefix(sessionIdFrom(payload) ?? normalized.session_id);
    const sessionId = harnessSessionId(harness, nativeId);
    return {
        ...normalized,
        event_id: sha256(`${harness}\0${eventName}\0${sessionId}\0${normalized.timestamp}\0${normalized.raw_input_sha256}`),
        harness,
        native_event: eventName,
        hook_event: hookEvent,
        session_id: sessionId,
    };
}
function mappedEvent(harness, nativeEvent) {
    if (!nativeEvent)
        throw new Error("Capture event name is required.");
    const aliases = harness === "kiro" ? KIRO_ALIASES : harness === "vscode" ? VSCODE_ALIASES : undefined;
    const canonicalEvent = aliases?.[nativeEvent] ?? nativeEvent;
    const mapped = EVENT_MAP[harness][canonicalEvent];
    if (!mapped)
        throw new Error(`Unsupported ${harness} capture event: ${nativeEvent}.`);
    return mapped;
}
function detectHarness(payload, nativeEvent) {
    if (!payload)
        throw new Error("Unable to determine harness from capture input; pass --harness explicitly.");
    const hasSnakeCaseSession = typeof payload.session_id === "string" && payload.session_id.trim().length > 0;
    const hasCamelCaseSession = typeof payload.sessionId === "string" && payload.sessionId.trim().length > 0;
    const isVsCodeEvent = nativeEvent !== undefined && (EVENT_MAP.vscode[nativeEvent] !== undefined || VSCODE_ALIASES[nativeEvent] !== undefined);
    const isCopilotEvent = nativeEvent !== undefined && EVENT_MAP.copilot[nativeEvent] !== undefined;
    if (hasSnakeCaseSession && !hasCamelCaseSession && isVsCodeEvent)
        return "vscode";
    if (hasCamelCaseSession && !hasSnakeCaseSession && isCopilotEvent)
        return "copilot";
    throw new Error("Unable to determine harness from capture input; pass --harness explicitly.");
}
function recordInput(input) {
    if (isRecord(input))
        return input;
    if (typeof input !== "string")
        return undefined;
    try {
        const parsed = JSON.parse(input);
        return isRecord(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function eventNameFrom(payload) {
    if (!payload)
        return undefined;
    for (const key of ["hook_event_name", "hookEventName", "event_name", "eventName"]) {
        const value = payload[key];
        if (typeof value === "string" && value.trim().length > 0)
            return value.trim();
    }
    return undefined;
}
function sessionIdFrom(payload) {
    if (!payload)
        return undefined;
    for (const key of ["session_id", "sessionId", "sessionID", "conversation_id", "conversationId"]) {
        const value = payload[key];
        if (typeof value === "string" && value.trim().length > 0)
            return value.trim();
    }
    return undefined;
}
function stripHarnessPrefix(sessionId) {
    const prefix = /^([^:]+):(.*)$/u.exec(sessionId);
    if (!prefix)
        return sessionId;
    return isHarness(prefix[1]) ? prefix[2] : sessionId;
}
function isHarness(value) {
    return value === "codex" || value === "cursor" || value === "vscode" || value === "copilot" || value === "kiro" || value === "claude" || value === "opencode" || value === "mcp" || value === "import";
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
