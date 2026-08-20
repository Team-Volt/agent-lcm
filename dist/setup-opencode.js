import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { generateOpenCodePluginSource } from "./opencode-plugin.js";
import { isOwnedOpenCodeMcp, mutateOpenCodeMcp, openCodeJsoncExists, readOpenCodeConfigurationSnapshot, validateOpenCodeConfiguration } from "./setup-opencode-config.js";
import { ensureSetupDirectory, mutateSetupFile, readSetupConfiguration, readSetupFileBytes } from "./setup-files.js";
import { assertSafeSetupCommand } from "./setup-hook-status.js";
import { openCodeConfigPath, openCodeJsoncPath, openCodeStatePath, setupPath } from "./setup-targets.js";
const OPEN_CODE_GUIDE = "https://github.com/Team-Volt/agent-lcm/blob/main/docs/install/opencode.md";
const OPEN_CODE_COMMAND_SENTINEL = "/__agent_lcm_command_sentinel__";
const OPEN_CODE_MARKER = "// agent-lcm-opencode-plugin: 1";
export function setupOpenCode(options) {
    const target = setupPath("opencode", options.home);
    const configPath = openCodeConfigPath(options.home);
    const statePath = openCodeStatePath(options.home);
    const command = options.command.trim();
    const jsoncPath = openCodeJsoncExists(options.home) ? openCodeJsoncPath(options.home) : undefined;
    const jsonSnapshot = readOpenCodeConfigurationSnapshot(configPath, "setup");
    const jsoncSnapshot = jsoncPath === undefined ? undefined : readOpenCodeConfigurationSnapshot(jsoncPath, "setup");
    const snapshot = jsoncSnapshot ?? jsonSnapshot;
    let plugin = preflightOpenCodePlugin(target, statePath, "setup");
    const priorCommand = plugin.sources.find((source) => source.path === target)?.command
        ?? plugin.stateCommand ?? plugin.sources[0]?.command;
    validateOpenCodeConfiguration(jsonSnapshot.configuration, configPath, "setup", priorCommand ?? command);
    if (jsoncPath !== undefined)
        validateOpenCodeConfiguration(jsoncSnapshot?.configuration, jsoncPath, "setup", priorCommand ?? command);
    const source = Buffer.from(withOpenCodeMarker(generateOpenCodePluginSource(command)), "utf8");
    ensureSetupDirectory(path.dirname(target));
    plugin = preflightOpenCodePlugin(target, statePath, "setup");
    const lockedPriorCommand = plugin.sources.find((candidate) => candidate.path === target)?.command
        ?? plugin.stateCommand ?? plugin.sources[0]?.command;
    validateOpenCodeConfiguration(jsonSnapshot.configuration, configPath, "setup", lockedPriorCommand ?? command);
    if (jsoncPath !== undefined)
        validateOpenCodeConfiguration(jsoncSnapshot?.configuration, jsoncPath, "setup", lockedPriorCommand ?? command);
    let mcpChanged = false;
    let captureChanged = false;
    let mcpCompleted = false;
    let captureCompleted = false;
    try {
        mcpChanged = mutateOpenCodeMcp(jsoncPath ?? configPath, "setup", command, snapshot);
        mcpCompleted = true;
        captureChanged = upgradeOpenCodeSources(plugin.sources, target, source);
        captureChanged = setOpenCodeState(statePath, "enabled", command, plugin.stateBytes) || captureChanged;
        captureCompleted = true;
    }
    catch (error) {
        throwOpenCodePartialFailure("setup", mcpCompleted, captureCompleted, error instanceof Error ? error : new Error(String(error)));
    }
    return openCodeSetupReport(target, jsoncPath ?? configPath, captureChanged, mcpChanged);
}
export function removeOpenCode(options) {
    const target = setupPath("opencode", options.home);
    const configPath = openCodeConfigPath(options.home);
    const statePath = openCodeStatePath(options.home);
    const jsoncPath = openCodeJsoncExists(options.home) ? openCodeJsoncPath(options.home) : undefined;
    const jsonSnapshot = readOpenCodeConfigurationSnapshot(configPath, "remove");
    const jsoncSnapshot = jsoncPath === undefined ? undefined : readOpenCodeConfigurationSnapshot(jsoncPath, "remove");
    const plugin = preflightOpenCodePlugin(target, statePath, "remove");
    const priorCommand = plugin.sources.find((source) => source.path === target)?.command ?? plugin.stateCommand;
    validateOpenCodeConfiguration(jsonSnapshot.configuration, configPath, "remove", priorCommand);
    if (jsoncPath !== undefined)
        validateOpenCodeConfiguration(jsoncSnapshot?.configuration, jsoncPath, "remove", priorCommand);
    let captureChanged = false;
    let mcpChanged = false;
    let captureCompleted = false;
    let mcpCompleted = false;
    try {
        if (plugin.sources.length > 0)
            captureChanged = upgradeOpenCodeSources(plugin.sources, target);
        if (plugin.stateBytes !== undefined || plugin.sources.length > 0) {
            captureChanged = setOpenCodeState(statePath, "disabled", priorCommand, plugin.stateBytes) || captureChanged;
        }
        captureCompleted = true;
        if (priorCommand !== undefined && jsoncSnapshot !== undefined) {
            mcpChanged = mutateOpenCodeMcp(jsoncPath ?? configPath, "remove", priorCommand, jsoncSnapshot);
        }
        if (priorCommand !== undefined && jsonSnapshot.configuration !== undefined) {
            mcpChanged = mutateOpenCodeMcp(configPath, "remove", priorCommand, jsonSnapshot) || mcpChanged;
        }
        mcpCompleted = true;
    }
    catch (error) {
        throwOpenCodePartialFailure("remove", mcpCompleted, captureCompleted, error instanceof Error ? error : new Error(String(error)));
    }
    return openCodeRemoveReport(target, jsoncPath ?? configPath, captureChanged, mcpChanged);
}
export function openCodeSetupStatus(options) {
    const target = setupPath("opencode", options.home);
    const pluginBytes = readRawConfigurationForStatus(target);
    const stateBytes = readRawConfigurationForStatus(openCodeStatePath(options.home));
    let pluginCommand;
    try {
        if (pluginBytes !== undefined)
            pluginCommand = managedOpenCodeCommand(pluginBytes, target, "status");
    }
    catch {
        pluginCommand = undefined;
    }
    const configuration = effectiveOpenCodeConfiguration(options.home);
    return {
        hooksConfigured: isKnownManagedOpenCodePlugin(pluginBytes)
            && stateBytes !== undefined && isOpenCodeStateEnabled(stateBytes, pluginCommand),
        mcpConfigured: isRecord(configuration?.mcp)
            && isOwnedOpenCodeMcp(configuration.mcp["agent-lcm"], pluginCommand),
        path: target,
    };
}
function openCodeSetupReport(target, mcpPath, captureChanged, mcpChanged) {
    return { harness: "opencode", action: "setup", status: "complete", nativeCli: null, hooks: { path: target, changed: captureChanged }, mcp: { path: mcpPath, changed: mcpChanged }, guide: OPEN_CODE_GUIDE };
}
function openCodeRemoveReport(target, mcpPath, captureChanged, mcpChanged) {
    return { harness: "opencode", action: "remove", status: "complete", nativeCli: null, hooks: { path: target, changed: captureChanged }, mcp: { path: mcpPath, changed: mcpChanged }, guide: OPEN_CODE_GUIDE };
}
function effectiveOpenCodeConfiguration(home) {
    const json = readConfigurationForStatus(openCodeConfigPath(home));
    if (!openCodeJsoncExists(home))
        return json;
    const jsonc = readOpenCodeConfigurationForStatus(openCodeJsoncPath(home));
    if (jsonc === undefined)
        return undefined;
    const jsonMcp = isRecord(json?.mcp) ? json.mcp : {};
    const jsoncMcp = isRecord(jsonc.mcp) ? jsonc.mcp : {};
    return { mcp: { ...jsonMcp, ...jsoncMcp } };
}
function preflightOpenCodePlugin(target, statePath, action) {
    const directory = path.dirname(target);
    if (!directoryExists(directory))
        return { sources: [], stateBytes: undefined, stateCommand: undefined };
    const sources = [];
    const existing = readSetupFileBytes(target);
    if (existing !== undefined)
        sources.push({ path: target, bytes: existing, command: managedOpenCodeCommand(existing, target, action), hash: openCodeBytesHash(existing) });
    for (const name of fs.readdirSync(directory)) {
        if (!/^agent-lcm-pre-agent-lcm-[A-Za-z0-9-]+\.ts$/u.test(name))
            continue;
        const candidate = path.join(directory, name);
        const status = fs.lstatSync(candidate);
        if (status.isSymbolicLink())
            throw new Error(`Refusing OpenCode plugin backup symlink: ${candidate}`);
        if (!status.isFile())
            continue;
        const bytes = readSetupFileBytes(candidate);
        if (bytes !== undefined && isKnownManagedOpenCodePlugin(bytes)) {
            sources.push({ path: candidate, bytes, command: managedOpenCodeCommand(bytes, candidate, action), hash: openCodeBytesHash(bytes) });
        }
    }
    const stateBytes = readSetupFileBytes(statePath);
    const stateCommand = stateBytes === undefined ? undefined : managedOpenCodeStateCommand(stateBytes, statePath);
    const targetCommand = sources.find((source) => source.path === target)?.command;
    if (action === "remove" && targetCommand !== undefined && stateCommand !== undefined && targetCommand !== stateCommand) {
        throw new Error(`Refusing mismatched OpenCode plugin state marker: ${statePath}`);
    }
    return { sources, stateBytes, stateCommand };
}
function upgradeOpenCodeSources(sources, target, desiredTarget) {
    let changed = false;
    const targetSource = sources.find((source) => source.path === target);
    if (desiredTarget !== undefined && (targetSource === undefined || !targetSource.bytes.equals(desiredTarget))) {
        changed = mutateSetupFile(target, (current) => {
            if (current !== undefined && !isKnownManagedOpenCodePlugin(current))
                throw new Error(`Refusing to overwrite unmanaged OpenCode plugin: ${target}`);
            return desiredTarget;
        }, targetSource?.hash, ".ts.bak");
    }
    for (const source of sources) {
        if (source.path === target)
            continue;
        const desired = Buffer.from(withOpenCodeMarker(generateOpenCodePluginSource(source.command)), "utf8");
        if (source.bytes.equals(desired))
            continue;
        changed = mutateSetupFile(source.path, (current) => {
            if (current !== undefined && !isKnownManagedOpenCodePlugin(current))
                throw new Error(`Refusing to overwrite unmanaged OpenCode plugin backup: ${source.path}`);
            return desired;
        }, source.hash, source.path.endsWith(".ts") ? ".ts.bak" : undefined) || changed;
    }
    return changed;
}
function setOpenCodeState(target, state, command, existing) {
    if (command === undefined)
        return false;
    const desired = Buffer.from(`${state}\n${JSON.stringify(command)}\n`, "utf8");
    return mutateSetupFile(target, (current) => {
        if (current !== undefined)
            managedOpenCodeStateCommand(current, target);
        return desired;
    }, existing === undefined ? undefined : openCodeBytesHash(existing));
}
function throwOpenCodePartialFailure(action, mcpCompleted, captureCompleted, error) {
    const completed = [...(captureCompleted ? ["capture-plugin"] : []), ...(mcpCompleted ? ["MCP configuration"] : [])];
    const state = completed.length === 0 ? "Neither component completed" : `${completed.join(" and ")} completed`;
    throw new Error(`OpenCode ${action} stopped safely: ${state}, but the other component may be incomplete. Inspect the OpenCode plugin and MCP configuration, repair them if needed, then retry agent-lcm ${action} opencode.`, { cause: error });
}
function isKnownManagedOpenCodePlugin(bytes) {
    if (bytes === undefined)
        return false;
    const source = bytes.toString("utf8");
    const command = openCodeCommandFromSource(source);
    return command !== undefined && (matchesGeneratedOpenCodePlugin(source, command) || isLegacyOpenCodePlugin(source));
}
function isLegacyOpenCodePlugin(source) {
    if (!source.startsWith("// Generated by Agent LCM. Do not edit.\n"))
        return false;
    const commandLine = /^const AGENT_LCM_COMMAND = .*;$/mu;
    if (!commandLine.test(source))
        return false;
    const normalize = (value) => value.replace(commandLine, `const AGENT_LCM_COMMAND = ${JSON.stringify(OPEN_CODE_COMMAND_SENTINEL)};`);
    const markerless = generateOpenCodePluginSource(OPEN_CODE_COMMAND_SENTINEL).replace(`${OPEN_CODE_MARKER}\n`, "");
    const previousMarkerless = previousOpenCodePluginSource(markerless);
    const preStateMarkerless = previousMarkerless.replace('import fs from "node:fs";\n', "").replace(`const AGENT_LCM_STATE = new URL("./.agent-lcm-opencode-plugin.state", import.meta.url);\n\nfunction captureEnabled() {\n  try {\n    return fs.readFileSync(AGENT_LCM_STATE, "utf8").trim() === "enabled";\n  } catch {\n    return false;\n  }\n}\n\n`, "").replace("  if (!captureEnabled()) return;\n", "");
    return [markerless, previousMarkerless, preStateMarkerless].some((known) => normalize(source) === normalize(known));
}
function managedOpenCodeCommand(bytes, target, action) {
    const command = openCodeCommandFromSource(bytes.toString("utf8"));
    if (command === undefined || !isKnownManagedOpenCodePlugin(bytes))
        throw new Error(`Refusing to ${action} unmanaged OpenCode plugin: ${target}`);
    return command;
}
function matchesGeneratedOpenCodePlugin(source, command) {
    const generated = generateOpenCodePluginSource(command);
    return source === generated || source === previousOpenCodePluginSource(generated);
}
function previousOpenCodePluginSource(source) {
    return source.replace('return fs.readFileSync(AGENT_LCM_STATE, "utf8").split("\\n", 1)[0] === "enabled";', 'return fs.readFileSync(AGENT_LCM_STATE, "utf8").trim() === "enabled";');
}
function openCodeCommandFromSource(source) {
    const match = /^const AGENT_LCM_COMMAND = (.+);$/mu.exec(source);
    if (match === null)
        return undefined;
    try {
        const command = JSON.parse(match[1] ?? "");
        if (typeof command !== "string")
            return undefined;
        assertSafeSetupCommand(command);
        return command;
    }
    catch {
        return undefined;
    }
}
function managedOpenCodeStateCommand(bytes, target) {
    try {
        const match = /^(?:enabled|disabled)\n(.+)\n$/u.exec(bytes.toString("utf8"));
        if (match === null)
            throw new Error();
        const command = JSON.parse(match[1] ?? "");
        if (typeof command !== "string")
            throw new Error();
        assertSafeSetupCommand(command);
        return command;
    }
    catch {
        throw new Error(`Refusing unmanaged OpenCode plugin state marker: ${target}`);
    }
}
function isOpenCodeStateEnabled(bytes, command) {
    if (!bytes.toString("utf8").startsWith("enabled\n") || command === undefined)
        return false;
    try {
        return managedOpenCodeStateCommand(bytes, "state marker") === command;
    }
    catch {
        return false;
    }
}
function openCodeBytesHash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function withOpenCodeMarker(source) { return source.startsWith(`${OPEN_CODE_MARKER}\n`) ? source : `${OPEN_CODE_MARKER}\n${source}`; }
function directoryExists(directory) {
    try {
        return requireDirectory(directory).isDirectory();
    }
    catch (error) {
        if (error instanceof Error && Reflect.get(error, "code") === "ENOENT")
            return false;
        throw error;
    }
}
function requireDirectory(directory) {
    const status = fs.lstatSync(directory);
    if (!status.isDirectory())
        throw new Error(`Cannot use setup path through a non-directory: ${directory}`);
    return status;
}
function readConfigurationForStatus(target) { try {
    return readSetupConfiguration(target);
}
catch {
    return undefined;
} }
function readOpenCodeConfigurationForStatus(target) { try {
    return readOpenCodeConfigurationSnapshot(target, "setup").configuration;
}
catch {
    return undefined;
} }
function readRawConfigurationForStatus(target) { try {
    return readSetupFileBytes(target);
}
catch {
    return undefined;
} }
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
