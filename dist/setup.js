import path from "node:path";
import { runHarnessLifecycle } from "./setup-adapters.js";
import { ensureSetupDirectory, mutateSetupConfiguration, readSetupConfiguration } from "./setup-files.js";
import { assertSafeSetupCommand, setupHooksConfigured } from "./setup-hook-status.js";
import { mergeSetupHooks, removeSetupHooks, removeSharedSetupHooks, validateSetupHooks, } from "./setup-hooks.js";
import { SETUP_HARNESSES, setupPath } from "./setup-targets.js";
export function setupHarness(harness, options) {
    const target = setupPath(harness, options.home);
    const command = options.command.trim();
    assertSafeSetupCommand(command);
    const existing = readSetupConfiguration(target);
    validateSetupHooks(harness, existing, target);
    ensureSetupDirectory(path.dirname(target));
    const native = runHarnessLifecycle(harness, "setup", options.env ? { env: options.env, command } : { command });
    const changed = finishHookUpdate("setup", harness, native.status, target, () => (updateHooks(harness, native.status, target, command, existing !== undefined)));
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
    const existing = readSetupConfiguration(target);
    validateSetupHooks(harness, existing, target);
    const native = runHarnessLifecycle(harness, "remove", options.env ? { env: options.env } : {});
    const changed = finishHookUpdate("remove", harness, native.status, target, () => (removeHooks(harness, target, existing !== undefined)));
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
function updateHooks(harness, nativeStatus, target, command, targetExists) {
    if (harness === "kiro") {
        return mutateSetupConfiguration(target, (existing) => mergeSetupHooks(existing, harness, command, target));
    }
    if (harness === "codex" && nativeStatus === "native-complete" && targetExists) {
        return mutateSetupConfiguration(target, (existing) => existing === undefined
            ? undefined
            : removeSetupHooks(existing, harness, target));
    }
    if ((harness === "copilot" || harness === "vscode") && nativeStatus === "native-complete" && targetExists) {
        return mutateSetupConfiguration(target, (existing) => removeSharedSetupHooks(existing ?? {}, harness, target));
    }
    return false;
}
function removeHooks(harness, target, targetExists) {
    if (harness === "copilot" || harness === "vscode" || !targetExists)
        return false;
    return mutateSetupConfiguration(target, (existing) => existing === undefined
        ? undefined
        : removeSetupHooks(existing, harness, target));
}
function finishHookUpdate(action, harness, nativeStatus, target, update) {
    try {
        return update();
    }
    catch (error) {
        if (nativeStatus !== "native-complete")
            throw error;
        throw new Error(`Native ${harness} ${action} completed, but Agent LCM could not safely update ${target}. `
            + `The file was not overwritten. Repair it, then rerun agent-lcm ${action} ${harness}.`, { cause: error });
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
