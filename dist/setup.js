import path from "node:path";
import { openCodeSetupStatus, removeOpenCode, setupOpenCode } from "./setup-opencode.js";
import { runHarnessLifecycle } from "./setup-adapters.js";
import { ensureSetupDirectory, mutateSetupConfiguration, readSetupConfiguration, readSetupConfigurationSnapshot, SetupConfigurationChangedError } from "./setup-files.js";
import { assertSafeSetupCommand, setupHooksConfigured } from "./setup-hook-status.js";
import { mergeSetupHooks, removeSetupHooks, removeSharedSetupHooks, validateSetupHooks } from "./setup-hooks.js";
import { claudeConfigPath, SETUP_HARNESSES, setupPath } from "./setup-targets.js";
export function setupHarness(harness, options) {
    if (harness === "opencode")
        return setupOpenCode(options);
    if (harness === "claude")
        return claudeReport("setup", options.home, options.env);
    const target = setupPath(harness, options.home);
    const command = options.command.trim();
    assertSafeSetupCommand(command);
    const snapshot = readSetupConfigurationSnapshot(target);
    validateSetupHooks(harness, snapshot.configuration, target);
    ensureSetupDirectory(path.dirname(target));
    const native = runHarnessLifecycle(harness, "setup", options.env ? { env: options.env, command } : { command });
    const changed = finishHookUpdate("setup", harness, native.status, target, () => updateHooks(harness, native.status, target, command, snapshot.hash));
    return { harness, action: "setup", status: native.status === "native-complete" ? "complete" : "manual-required", nativeCli: native.nativeCli, hooks: { path: target, changed }, guide: native.guide };
}
export function removeHarness(harness, options = {}) {
    if (harness === "opencode")
        return removeOpenCode(options);
    if (harness === "claude")
        return claudeReport("remove", options.home, options.env);
    const target = setupPath(harness, options.home);
    const snapshot = readSetupConfigurationSnapshot(target);
    validateSetupHooks(harness, snapshot.configuration, target);
    const native = runHarnessLifecycle(harness, "remove", options.env ? { env: options.env } : {});
    const changed = finishHookUpdate("remove", harness, native.status, target, () => removeHooks(harness, target, snapshot.configuration !== undefined, snapshot.hash));
    return { harness, action: "remove", status: native.status === "native-complete" ? "complete" : native.status, nativeCli: native.nativeCli, hooks: { path: target, changed }, guide: native.guide };
}
export function setupStatus(options = {}) {
    const statuses = {
        codex: { hooksConfigured: false, path: "" },
        cursor: { hooksConfigured: false, path: "" },
        vscode: { hooksConfigured: false, path: "" },
        copilot: { hooksConfigured: false, path: "" },
        kiro: { hooksConfigured: false, path: "" },
        claude: { hooksConfigured: false, path: "" },
        opencode: { hooksConfigured: false, path: "" },
    };
    for (const harness of SETUP_HARNESSES) {
        if (harness === "claude")
            statuses[harness] = { hooksConfigured: false, path: claudeConfigPath(options.home) };
        else if (harness === "opencode")
            statuses[harness] = openCodeSetupStatus(options);
        else {
            const target = setupPath(harness, options.home);
            statuses[harness] = { hooksConfigured: setupHooksConfigured(harness, readConfigurationForStatus(target)), path: target };
        }
    }
    return statuses;
}
function claudeReport(action, home, env) {
    const native = runHarnessLifecycle("claude", action, env ? { env } : {});
    return { harness: "claude", action, status: native.status === "native-complete" ? "complete" : "manual-required", nativeCli: native.nativeCli, hooks: { path: claudeConfigPath(home), changed: false }, guide: native.guide };
}
function updateHooks(harness, nativeStatus, target, command, expectedHash) {
    if (harness !== "kiro" && nativeStatus !== "native-complete")
        return false;
    return mutateSetupConfiguration(target, (existing) => {
        if (harness === "kiro")
            return mergeSetupHooks(existing, harness, command, target);
        if (harness === "codex" && nativeStatus === "native-complete")
            return existing === undefined ? undefined : removeSetupHooks(existing, harness, target);
        if ((harness === "copilot" || harness === "vscode") && nativeStatus === "native-complete")
            return existing === undefined ? undefined : removeSharedSetupHooks(existing, harness, target);
        return existing;
    }, expectedHash);
}
function removeHooks(harness, target, targetExists, expectedHash) {
    if (harness === "copilot" || harness === "vscode" || (!targetExists && harness !== "codex"))
        return false;
    return mutateSetupConfiguration(target, (existing) => existing === undefined ? undefined : removeSetupHooks(existing, harness, target), expectedHash);
}
function finishHookUpdate(action, harness, nativeStatus, target, update) {
    try {
        return update();
    }
    catch (error) {
        if (error instanceof SetupConfigurationChangedError) {
            const result = nativeStatus === "native-complete" ? `Native ${harness} ${action} completed` : `${harness} ${action} stopped`;
            throw new Error(`${result}, but Agent LCM detected a concurrent change to ${target} and did not overwrite it. Repair it if needed, then rerun agent-lcm ${action} ${harness}.`, { cause: error });
        }
        if (nativeStatus !== "native-complete")
            throw error;
        throw new Error(`Native ${harness} ${action} completed, but Agent LCM could not safely update ${target}. Inspect the hook file because the local update may have completed. Repair it if needed, then rerun agent-lcm ${action} ${harness}.`, { cause: error });
    }
}
function readConfigurationForStatus(target) {
    try {
        return readSetupConfiguration(target);
    }
    catch {
        return undefined;
    }
}
