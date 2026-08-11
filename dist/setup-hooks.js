import { CODEX_EVENTS, eventsFor, isAgentLcmCodexHook, isAgentLcmHook, isCodexNativeHook, isKiroHook, isSharedHookHarness, setupCaptureHarness, setupEvents, } from "./setup-hook-status.js";
export function mergeSetupHooks(existing, harness, command, target) {
    if (harness === "kiro")
        return mergeKiroConfiguration(existing, command, target);
    if (harness === "codex")
        return mergeCodexConfiguration(existing, command, target);
    return mergeFlatConfiguration(existing, harness, command, target);
}
function mergeCodexConfiguration(existing, command, target) {
    const configuration = existing ? structuredClone(existing) : { hooks: {} };
    if (!isRecord(configuration.hooks))
        throw invalidConfiguration(target);
    if (!Object.values(configuration.hooks).every(isCodexSelectors))
        throw invalidConfiguration(target);
    for (const event of CODEX_EVENTS) {
        const expectedCommand = isCodexNativeHook(event)
            ? `node "${command}" hook ${event}`
            : captureCommand(command, "codex", event);
        const selectors = configuration.hooks[event];
        if (selectors === undefined) {
            configuration.hooks[event] = [{
                    ...(event === "PreToolUse" ? { matcher: ".*" } : {}),
                    hooks: [{ type: "command", command: expectedCommand }],
                }];
            continue;
        }
        if (!isCodexSelectors(selectors))
            throw invalidConfiguration(target);
        let found = false;
        for (const selector of selectors) {
            if (!Array.isArray(selector.hooks) || !selector.hooks.every(isRecord))
                throw invalidConfiguration(target);
            for (const hook of selector.hooks) {
                if (!(isCodexNativeHook(event) ? isAgentLcmCodexHook(hook, event) : isAgentLcmHook(hook, event, "codex")))
                    continue;
                hook.type = "command";
                hook.command = expectedCommand;
                found = true;
            }
        }
        if (!found)
            selectors.push({
                ...(event === "PreToolUse" ? { matcher: ".*" } : {}),
                hooks: [{ type: "command", command: expectedCommand }],
            });
    }
    return configuration;
}
function mergeFlatConfiguration(existing, harness, command, target) {
    const configuration = existing ? structuredClone(existing) : { version: 1, hooks: {} };
    if (configuration.version !== 1 || !isRecord(configuration.hooks))
        throw invalidConfiguration(target);
    if (!Object.values(configuration.hooks).every((hooks) => Array.isArray(hooks) && hooks.every(isRecord))) {
        throw invalidConfiguration(target);
    }
    for (const [event, captureEvent] of setupEvents(harness)) {
        const expectedHooks = takeAgentLcmHooks(configuration.hooks, harness, event);
        if (expectedHooks.length === 0)
            expectedHooks.push({});
        for (const expected of expectedHooks) {
            if (harness !== "cursor")
                expected.type = "command";
            expected.command = captureCommand(command, setupCaptureHarness(harness), captureEvent);
        }
        const hooks = configuration.hooks[event];
        if (hooks === undefined)
            configuration.hooks[event] = expectedHooks;
        else
            hooks.push(...expectedHooks);
    }
    return configuration;
}
function mergeKiroConfiguration(existing, command, target) {
    const configuration = existing ? structuredClone(existing) : { version: "v1", hooks: [] };
    const hooks = configuration.hooks;
    if (configuration.version !== "v1" || !Array.isArray(hooks) || !hooks.every(isKiroHook)) {
        throw invalidConfiguration(target);
    }
    const kiroHooks = hooks;
    for (const event of eventsFor("kiro")) {
        const expected = kiroHook(command, event);
        const owned = kiroHooks.filter((hook) => hook.name === expected.name
            && hook.trigger === event
            && isAgentLcmHook(hook.action, event, "kiro"));
        if (owned.length === 0)
            kiroHooks.push(expected);
        for (const hook of owned) {
            hook.action.type = "command";
            hook.action.command = expected.action.command;
        }
    }
    return configuration;
}
function takeAgentLcmHooks(hooksByEvent, harness, event) {
    const found = [];
    const candidates = isSharedHookHarness(harness) ? [event, sharedLegacyEvent(event)] : [event];
    for (const candidate of candidates) {
        const hooks = hooksByEvent[candidate];
        if (!Array.isArray(hooks))
            continue;
        const kept = hooks.filter((hook) => {
            if (!isRecord(hook) || !isAgentLcmHook(hook, candidate, harness))
                return true;
            found.push(hook);
            return false;
        });
        if (kept.length === 0)
            delete hooksByEvent[candidate];
        else
            hooksByEvent[candidate] = kept;
    }
    return found;
}
function sharedLegacyEvent(event) {
    return {
        sessionStart: "SessionStart",
        userPromptSubmitted: "UserPromptSubmit",
        postToolUse: "PostToolUse",
        sessionEnd: "Stop",
    }[event] ?? event;
}
function kiroHook(command, event) {
    return {
        name: `agent-lcm-kiro-${event}`,
        trigger: event,
        action: { type: "command", command: captureCommand(command, "kiro", event) },
    };
}
function captureCommand(command, harness, event) {
    return `node "${command}" capture --harness ${harness} ${event}`;
}
function isCodexSelectors(value) {
    return Array.isArray(value) && value.every((selector) => isRecord(selector)
        && Array.isArray(selector.hooks)
        && selector.hooks.every(isRecord));
}
function invalidConfiguration(target) {
    return new Error(`Cannot update invalid setup configuration: ${target}`);
}
export function validateSetupHooks(harness, configuration, target) {
    if (configuration !== undefined)
        mergeSetupHooks(configuration, harness, "/agent-lcm", target);
}
export function removeSharedSetupHooks(configuration, harness, target) {
    const next = structuredClone(configuration);
    if (next.version !== 1 || !isRecord(next.hooks)
        || !Object.values(next.hooks).every((hooks) => Array.isArray(hooks) && hooks.every(isRecord))) {
        throw invalidConfiguration(target);
    }
    for (const [event] of setupEvents(harness))
        removeSharedHooks(next.hooks, harness, event);
    return next;
}
export function removeSetupHooks(configuration, harness, target) {
    validateSetupHooks(harness, configuration, target);
    if (harness === "codex")
        return removeCodexHooks(configuration);
    if (harness === "cursor")
        return removeCursorHooks(configuration);
    return removeKiroHooks(configuration);
}
function removeCodexHooks(configuration) {
    const next = structuredClone(configuration);
    if (!isRecord(next.hooks))
        return next;
    for (const event of CODEX_EVENTS) {
        const selectors = next.hooks[event];
        if (!Array.isArray(selectors))
            continue;
        for (const selector of selectors) {
            if (!isRecord(selector) || !Array.isArray(selector.hooks))
                continue;
            selector.hooks = selector.hooks.filter((hook) => isCodexNativeHook(event)
                ? !isAgentLcmCodexHook(hook, event)
                : !isRecord(hook) || !isAgentLcmHook(hook, event, "codex"));
        }
    }
    return next;
}
function removeCursorHooks(configuration) {
    const next = structuredClone(configuration);
    if (!isRecord(next.hooks))
        return next;
    for (const [event] of setupEvents("cursor")) {
        const hooks = next.hooks[event];
        if (Array.isArray(hooks)) {
            next.hooks[event] = hooks.filter((hook) => !isRecord(hook) || !isAgentLcmHook(hook, event, "cursor"));
        }
    }
    return next;
}
function removeKiroHooks(configuration) {
    const next = structuredClone(configuration);
    if (!Array.isArray(next.hooks))
        return next;
    next.hooks = next.hooks.filter((hook) => !isKiroHook(hook)
        || !eventsFor("kiro").some((event) => hook.name === `agent-lcm-kiro-${event}`
            && hook.trigger === event
            && isAgentLcmHook(hook.action, event, "kiro")));
    return next;
}
function removeSharedHooks(hooksByEvent, harness, event) {
    for (const candidate of [event, sharedLegacyEvent(event)]) {
        const hooks = hooksByEvent[candidate];
        if (Array.isArray(hooks))
            hooksByEvent[candidate] = hooks.filter((hook) => !isRecord(hook) || !isAgentLcmHook(hook, candidate, harness));
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
