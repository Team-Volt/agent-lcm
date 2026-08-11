import path from "node:path";
import { runHarnessLifecycle } from "./setup-adapters.js";
import { ensureSetupDirectory, mutateSetupConfiguration, readSetupConfiguration, readSetupConfigurationSnapshot, SetupConfigurationChangedError, } from "./setup-files.js";
import { assertSafeSetupCommand, setupHooksConfigured } from "./setup-hook-status.js";
import { mergeSetupHooks, removeSetupHooks, removeSharedSetupHooks, validateSetupHooks, } from "./setup-hooks.js";
import { SETUP_HARNESSES, setupPath } from "./setup-targets.js";
export function setupHarness(harness, options) {
    const target = setupPath(harness, options.home);
    const command = options.command.trim();
    assertSafeSetupCommand(command);
    const snapshot = readSetupConfigurationSnapshot(target);
    const existing = snapshot.configuration;
    validateSetupHooks(harness, existing, target);
    ensureSetupDirectory(path.dirname(target));
    const native = runHarnessLifecycle(harness, "setup", options.env ? { env: options.env, command } : { command });
    const changed = finishHookUpdate("setup", harness, native.status, target, () => (updateHooks(harness, native.status, target, command, snapshot.hash)));
    return {
        harness,
        action: "setup",
        status: native.status === "native-complete" ? "complete" : "manual-required",
        nativeCli: native.nativeCli,
        hooks: { path: target, changed },
        guide: native.guide,
    };
}
export function removeHarness(harness, options = {}) {
    const target = setupPath(harness, options.home);
    const snapshot = readSetupConfigurationSnapshot(target);
    const existing = snapshot.configuration;
    validateSetupHooks(harness, existing, target);
    const native = runHarnessLifecycle(harness, "remove", options.env ? { env: options.env } : {});
    const changed = finishHookUpdate("remove", harness, native.status, target, () => (removeHooks(harness, target, existing !== undefined, snapshot.hash)));
    return {
        harness,
        action: "remove",
        status: native.status === "native-complete" ? "complete" : native.status,
        nativeCli: native.nativeCli,
        hooks: { path: target, changed },
        guide: native.guide,
    };
}
export function setupStatus(options = {}) {
    return Object.fromEntries(SETUP_HARNESSES.map((harness) => {
        const target = setupPath(harness, options.home);
        return [harness, { hooksConfigured: setupHooksConfigured(harness, readConfigurationForStatus(target)), path: target }];
    }));
}
function updateHooks(harness, nativeStatus, target, command, expectedHash) {
    return mutateSetupConfiguration(target, (existing) => {
        if (harness === "kiro")
            return mergeSetupHooks(existing, harness, command, target);
        if (harness === "codex" && nativeStatus === "native-complete") {
            return existing === undefined ? undefined : removeSetupHooks(existing, harness, target);
        }
        if ((harness === "copilot" || harness === "vscode") && nativeStatus === "native-complete") {
            return existing === undefined ? undefined : removeSharedSetupHooks(existing, harness, target);
        }
        return existing;
    }, expectedHash);
}
function removeHooks(harness, target, targetExists, expectedHash) {
    if (harness === "copilot" || harness === "vscode" || !targetExists)
        return false;
    return mutateSetupConfiguration(target, (existing) => existing === undefined
        ? undefined
        : removeSetupHooks(existing, harness, target), expectedHash);
}
function finishHookUpdate(action, harness, nativeStatus, target, update) {
    try {
        return update();
    }
    catch (error) {
        if (nativeStatus !== "native-complete")
            throw error;
        const detail = error instanceof SetupConfigurationChangedError
            ? "Agent LCM detected the concurrent change and did not overwrite it."
            : "Inspect the hook file because the local update may have completed.";
        throw new Error(`Native ${harness} ${action} completed, but Agent LCM could not safely update ${target}. `
            + `${detail} Repair it if needed, then rerun agent-lcm ${action} ${harness}.`, { cause: error });
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
