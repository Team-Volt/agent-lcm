import path from "node:path";
export const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact", "SubagentStop", "Stop"];
export function setupHooksConfigured(harness, configuration) {
    if (!configuration)
        return false;
    if (harness === "kiro") {
        const hooks = configuration.hooks;
        if (configuration.version !== "v1" || !Array.isArray(hooks) || !hooks.every(isKiroHook))
            return false;
        return eventsFor(harness).every((event) => hooks.some((hook) => isExpectedKiroHook(hook, event)));
    }
    if (harness !== "codex" && configuration.version !== 1)
        return false;
    const hooksByEvent = configuration.hooks;
    if (!isRecord(hooksByEvent))
        return false;
    if (harness === "codex")
        return CODEX_EVENTS.every((event) => {
            const selectors = hooksByEvent[event];
            return Array.isArray(selectors) && selectors.some((selector) => isRecord(selector)
                && Array.isArray(selector.hooks)
                && selector.hooks.some((hook) => isCodexNativeHook(event)
                    ? isAgentLcmCodexHook(hook, event)
                    : isExpectedCommandHook(hook, harness, event)));
        });
    if (isSharedHookHarness(harness) && hasSharedPascalRegistration(hooksByEvent))
        return false;
    return setupEvents(harness).every(([event, captureEvent]) => {
        const hooks = hooksByEvent[event];
        return Array.isArray(hooks) && hooks.some((entry) => isExpectedCommandHook(entry, setupCaptureHarness(harness), captureEvent));
    });
}
export function eventsFor(harness) {
    return isSharedHookHarness(harness)
        ? ["sessionStart", "userPromptSubmitted", "postToolUse", "sessionEnd"]
        : ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];
}
export function setupEvents(harness) {
    return harness === "cursor"
        ? [["sessionStart", "SessionStart"], ["beforeSubmitPrompt", "UserPromptSubmit"], ["postToolUse", "PostToolUse"], ["stop", "Stop"]]
        : [["sessionStart", "sessionStart"], ["userPromptSubmitted", "userPromptSubmitted"], ["postToolUse", "postToolUse"], ["sessionEnd", "sessionEnd"]];
}
export function isSharedHookHarness(harness) {
    return harness === "copilot" || harness === "vscode";
}
export function setupCaptureHarness(harness) {
    return isSharedHookHarness(harness) ? "auto" : harness;
}
export function isAgentLcmHook(value, event, harness) {
    if ((value.type !== undefined && value.type !== "command") || typeof value.command !== "string")
        return false;
    const match = /^(?:node )?"(?:[^"\\/]*[\\/])*agent-lcm(?:\.(?:cmd|exe))?" capture --harness (auto|codex|cursor|copilot|vscode|kiro) (sessionStart|userPromptSubmitted|postToolUse|sessionEnd|SessionStart|UserPromptSubmit|PostToolUse|Stop)$/u
        .exec(value.command);
    const captureEvent = harness === "cursor"
        ? setupEvents("cursor").find(([hookEvent]) => hookEvent === event)?.[1]
        : event;
    if (!match || match[2] !== captureEvent)
        return false;
    return isSharedHookHarness(harness)
        ? match[1] === "auto" || match[1] === "copilot" || match[1] === "vscode"
        : match[1] === harness;
}
export function isAgentLcmCodexHook(value, event) {
    if (!isRecord(value) || (value.type !== undefined && value.type !== "command") || typeof value.command !== "string")
        return false;
    const match = /^(?:node )?"(?:[^"\\/]*[\\/])*agent-lcm(?:\.(?:cmd|exe))?" hook (PreToolUse|PreCompact|PostCompact|SubagentStop)$/u.exec(value.command);
    return match?.[1] === event;
}
export function isCodexNativeHook(event) {
    return event === "PreToolUse" || event === "PreCompact" || event === "PostCompact" || event === "SubagentStop";
}
export function isKiroHook(value) {
    return isRecord(value)
        && typeof value.name === "string"
        && typeof value.trigger === "string"
        && isRecord(value.action)
        && value.action.type === "command"
        && typeof value.action.command === "string";
}
export function assertSafeSetupCommand(command) {
    if (!command)
        throw new Error("setup command must not be empty");
    if (!path.isAbsolute(command) && !/^[A-Za-z]:[\\/]/u.test(command))
        throw new Error("setup command must be an absolute binary path");
    if (/["'`$;&|<>\n\r%^]/u.test(command) || command.endsWith("\\"))
        throw new Error("setup command contains unsafe shell characters");
}
function isExpectedCommandHook(value, harness, event) {
    return isRecord(value) && (value.type === undefined || value.type === "command") && isCaptureCommand(value.command, harness, event);
}
function hasSharedPascalRegistration(hooksByEvent) {
    return ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"].some((event) => {
        const hooks = hooksByEvent[event];
        return Array.isArray(hooks) && hooks.some((hook) => isRecord(hook) && hook.type === "command" && isAgentLcmHook(hook, event, "vscode"));
    });
}
function isExpectedKiroHook(value, event) {
    return isKiroHook(value)
        && value.name === `agent-lcm-kiro-${event}`
        && value.trigger === event
        && isCaptureCommand(value.action.command, "kiro", event);
}
function isCaptureCommand(value, harness, event) {
    if (typeof value !== "string")
        return false;
    const prefix = 'node "';
    const suffix = ` capture --harness ${harness} ${event}`;
    if (!value.startsWith(prefix) || !value.endsWith(suffix))
        return false;
    const quoteEnd = value.length - suffix.length - 1;
    if (value[quoteEnd] !== "\"")
        return false;
    try {
        assertSafeSetupCommand(value.slice(prefix.length, quoteEnd));
        return true;
    }
    catch {
        return false;
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
