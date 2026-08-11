import fs from "node:fs";
import path from "node:path";
import { backupSetupConfiguration, readSetupConfiguration, writeSetupConfiguration } from "./setup-files.js";
import { SETUP_HARNESSES, setupPath } from "./setup-targets.js";
const CODEX_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "PostCompact", "SubagentStop", "Stop"];
export function setupHarness(harness, options) {
    const target = setupPath(harness, options.home);
    const command = options.command.trim();
    assertSafeCommand(command);
    const existing = readSetupConfiguration(target);
    const next = mergeConfiguration(existing, harness, command, target);
    if (existing && JSON.stringify(existing) === JSON.stringify(next)) {
        const legacyChanged = harness === "vscode" || harness === "copilot"
            ? cleanupLegacySharedConfiguration(target)
            : false;
        return { harness, path: target, changed: legacyChanged };
    }
    if (existing)
        backupSetupConfiguration(target);
    writeSetupConfiguration(target, next);
    if (harness === "vscode" || harness === "copilot")
        cleanupLegacySharedConfiguration(target);
    return { harness, path: target, changed: true };
}
export function setupStatus(options = {}) {
    return Object.fromEntries(SETUP_HARNESSES.map((harness) => {
        const target = setupPath(harness, options.home);
        return [harness, { configured: configured(harness, target), path: target }];
    }));
}
function mergeConfiguration(existing, harness, command, target) {
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
function eventsFor(harness) {
    return isSharedHookHarness(harness)
        ? ["sessionStart", "userPromptSubmitted", "postToolUse", "agentStop"]
        : ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];
}
function setupEvents(harness) {
    if (harness === "cursor")
        return [["sessionStart", "sessionStart"], ["beforeSubmitPrompt", "beforeSubmitPrompt"], ["postToolUse", "postToolUse"], ["stop", "stop"]];
    if (harness === "vscode")
        return [["SessionStart", "SessionStart"], ["UserPromptSubmit", "UserPromptSubmit"], ["PostToolUse", "PostToolUse"], ["Stop", "Stop"]];
    return [["sessionStart", "sessionStart"], ["userPromptSubmitted", "userPromptSubmitted"], ["postToolUse", "postToolUse"], ["agentStop", "agentStop"]];
}
function isSharedHookHarness(harness) {
    return harness === "copilot" || harness === "vscode";
}
function setupCaptureHarness(harness) {
    return harness;
}
function takeAgentLcmHooks(hooksByEvent, harness, event) {
    const found = [];
    const candidates = isSharedHookHarness(harness)
        ? [event, sharedLegacyEvent(event), ...(event === "agentStop" ? ["sessionEnd"] : [])]
        : [event];
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
        agentStop: "Stop",
        sessionEnd: "Stop",
    }[event] ?? event;
}
function cursorLegacyCaptureEvent(event) {
    return {
        sessionStart: "SessionStart",
        beforeSubmitPrompt: "UserPromptSubmit",
        postToolUse: "PostToolUse",
        stop: "Stop",
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
function assertSafeCommand(command) {
    if (!command)
        throw new Error("setup command must not be empty");
    if (!path.isAbsolute(command) && !/^[A-Za-z]:[\\/]/u.test(command)) {
        throw new Error("setup command must be an absolute binary path");
    }
    if (/["'`$;&|<>\n\r%^]/u.test(command) || command.endsWith("\\")) {
        throw new Error("setup command contains unsafe shell characters");
    }
}
function configured(harness, target) {
    const configuration = readConfigurationForStatus(target);
    if (!configuration)
        return false;
    if (harness === "kiro") {
        const hooks = configuration.hooks;
        if (configuration.version !== "v1" || !Array.isArray(hooks) || !hooks.every(isKiroHook))
            return false;
        const kiroHooks = hooks;
        return eventsFor(harness).every((event) => kiroHooks.some((hook) => isExpectedKiroHook(hook, event)));
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
    return setupEvents(harness).every(([event, captureEvent]) => {
        const hooks = hooksByEvent[event];
        return Array.isArray(hooks) && hooks.some((entry) => isExpectedCommandHook(entry, setupCaptureHarness(harness), captureEvent));
    });
}
function readConfigurationForStatus(target) {
    try {
        return readSetupConfiguration(target);
    }
    catch {
        return undefined;
    }
}
function isExpectedCommandHook(value, harness, event) {
    return isRecord(value) && (value.type === undefined || value.type === "command") && isCaptureCommand(value.command, harness, event);
}
function isCodexSelectors(value) {
    return Array.isArray(value) && value.every((selector) => isRecord(selector)
        && Array.isArray(selector.hooks)
        && selector.hooks.every(isRecord));
}
function isAgentLcmHook(value, event, harness) {
    if ((value.type !== undefined && value.type !== "command") || typeof value.command !== "string")
        return false;
    const match = /^(?:node )?"(?:[^"\\/]*[\\/])*agent-lcm(?:\.(?:cmd|exe))?" capture --harness (auto|codex|cursor|copilot|vscode|kiro) (sessionStart|beforeSubmitPrompt|userPromptSubmitted|postToolUse|agentStop|sessionEnd|stop|SessionStart|UserPromptSubmit|PostToolUse|Stop)$/u
        .exec(value.command);
    const captureEvents = harness === "cursor"
        ? [event, cursorLegacyCaptureEvent(event)]
        : [event];
    if (!match || !captureEvents.includes(match[2]))
        return false;
    return isSharedHookHarness(harness)
        ? match[1] === "auto" || match[1] === "copilot" || match[1] === "vscode"
        : match[1] === harness;
}
function isAgentLcmCodexHook(value, event) {
    if (!isRecord(value) || (value.type !== undefined && value.type !== "command") || typeof value.command !== "string") {
        return false;
    }
    const match = /^(?:node )?"(?:[^"\\/]*[\\/])*agent-lcm(?:\.(?:cmd|exe))?" hook (PreToolUse|PreCompact|PostCompact|SubagentStop)$/u.exec(value.command);
    return match?.[1] === event;
}
function isCodexNativeHook(event) {
    return event === "PreToolUse" || event === "PreCompact" || event === "PostCompact" || event === "SubagentStop";
}
function hasSharedPascalRegistration(hooksByEvent) {
    return ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"].some((event) => {
        const hooks = hooksByEvent[event];
        return Array.isArray(hooks) && hooks.some((hook) => {
            if (!isRecord(hook) || hook.type !== "command" || typeof hook.command !== "string")
                return false;
            return isAgentLcmHook(hook, event, "vscode");
        });
    });
}
function isExpectedKiroHook(value, event) {
    return isKiroHook(value)
        && value.name === `agent-lcm-kiro-${event}`
        && value.trigger === event
        && isCaptureCommand(value.action.command, "kiro", event);
}
function isKiroHook(value) {
    return isRecord(value)
        && typeof value.name === "string"
        && typeof value.trigger === "string"
        && isRecord(value.action)
        && value.action.type === "command"
        && typeof value.action.command === "string";
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
    const command = value.slice(prefix.length, quoteEnd);
    try {
        assertSafeCommand(command);
        return true;
    }
    catch {
        return false;
    }
}
function cleanupLegacySharedConfiguration(target) {
    const legacy = path.join(path.dirname(target), "agent-lcm.json");
    if (legacy === target || !fs.existsSync(legacy))
        return false;
    let configuration;
    try {
        configuration = readSetupConfiguration(legacy);
    }
    catch {
        return false;
    }
    if (!configuration || configuration.version !== 1 || !isRecord(configuration.hooks))
        return false;
    const hooks = configuration.hooks;
    let changed = false;
    for (const [event, entries] of Object.entries(hooks)) {
        if (!Array.isArray(entries) || !entries.every(isRecord))
            continue;
        const kept = entries.filter((entry) => {
            const owned = isAgentLcmHook(entry, event, "vscode") || isAgentLcmHook(entry, event, "copilot");
            if (owned)
                changed = true;
            return !owned;
        });
        if (kept.length === 0)
            delete hooks[event];
        else
            hooks[event] = kept;
    }
    if (!changed)
        return false;
    backupSetupConfiguration(legacy);
    if (Object.keys(hooks).length === 0 && Object.keys(configuration).every((key) => key === "version" || key === "hooks")) {
        fs.unlinkSync(legacy);
    }
    else {
        writeSetupConfiguration(legacy, configuration);
    }
    return true;
}
function invalidConfiguration(target) {
    return new Error(`Cannot update invalid setup configuration: ${target}`);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
