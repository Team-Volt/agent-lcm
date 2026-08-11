import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withCopilotPluginSource } from "./copilot-plugin.js";
export class NativeLifecycleCommandError extends Error {
    name = "NativeLifecycleCommandError";
    executable;
    argv;
    status;
    stderr;
    constructor(executable, argv, status, stderr) {
        super(`Native lifecycle command failed: executable=${executable} argv=${argv.join(" ")} status=${String(status)} stderr=${stderr}`);
        this.executable = executable;
        this.argv = argv;
        this.status = status;
        this.stderr = stderr;
    }
}
const GUIDE_ROOT = "https://github.com/Team-Volt/agent-lcm/blob/main/docs/install";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUPPRESSED_STDERR = "suppressed";
export const HARNESS_LIFECYCLE_ADAPTERS = {
    codex: {
        kind: "codex",
        executable: "codex",
        guide: `${GUIDE_ROOT}/codex.md`,
        probeArgv: ["plugin", "list"],
        setupArgv: [
            ["plugin", "marketplace", "add", PACKAGE_ROOT],
            ["plugin", "add", "agent-lcm@agent-lcm"],
        ],
        removeArgv: ["plugin", "remove", "agent-lcm@agent-lcm"],
    },
    cursor: { kind: "manual", executable: "cursor-agent", probeArgv: ["--version"], guide: `${GUIDE_ROOT}/cursor.md` },
    vscode: {
        kind: "copilot",
        executable: "copilot",
        guide: `${GUIDE_ROOT}/vscode.md`,
        probeArgv: ["plugin", "list"],
    },
    copilot: {
        kind: "copilot",
        executable: "copilot",
        guide: `${GUIDE_ROOT}/copilot.md`,
        probeArgv: ["plugin", "list"],
    },
    kiro: { kind: "manual", executable: "kiro-cli", probeArgv: ["--version"], guide: `${GUIDE_ROOT}/kiro.md` },
};
export function runHarnessLifecycle(harness, action, options = {}) {
    const adapter = HARNESS_LIFECYCLE_ADAPTERS[harness];
    switch (adapter.kind) {
        case "manual":
            return manualOutcome(harness, action, adapter, options.env);
        case "copilot":
            if (action === "remove")
                return outcome(harness, action, "shared-retained", null, adapter.guide);
            return runNative(harness, action, adapter, options.env, options.command);
        case "codex":
            return runNative(harness, action, adapter, options.env);
        default:
            return assertNever(adapter);
    }
}
function runNative(harness, action, adapter, env, command) {
    const probe = spawnSync(adapter.executable, adapter.probeArgv, { encoding: "utf8", env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    if (isEnoent(probe.error)) {
        return outcome(harness, action, "manual-required", null, adapter.guide);
    }
    if (probe.error !== undefined || probe.status !== 0) {
        throw new NativeLifecycleCommandError(adapter.executable, adapter.probeArgv, probe.status, SUPPRESSED_STDERR);
    }
    if (action === "setup" && adapter.kind === "copilot") {
        withCopilotPluginSource(command ?? path.join(PACKAGE_ROOT, "bin", "agent-lcm"), (source) => {
            runNativeCommand(adapter.executable, ["plugin", "install", source], env);
        });
    }
    else if (adapter.kind === "codex") {
        const commands = action === "setup" ? adapter.setupArgv : [adapter.removeArgv];
        for (const argv of commands)
            runNativeCommand(adapter.executable, argv, env);
    }
    else {
        throw new Error("Copilot removal must retain the shared plugin.");
    }
    return outcome(harness, action, "native-complete", adapter.executable, adapter.guide);
}
function manualOutcome(harness, action, adapter, env) {
    const probe = spawnSync(adapter.executable, adapter.probeArgv, { encoding: "utf8", env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    if (isEnoent(probe.error))
        return outcome(harness, action, "manual-required", null, adapter.guide);
    if (probe.error !== undefined || probe.status !== 0) {
        throw new NativeLifecycleCommandError(adapter.executable, adapter.probeArgv, probe.status, SUPPRESSED_STDERR);
    }
    return outcome(harness, action, "manual-required", adapter.executable, adapter.guide);
}
function runNativeCommand(executable, argv, env) {
    const result = spawnSync(executable, argv, { encoding: "utf8", env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    if (result.status === 0)
        return;
    throw new NativeLifecycleCommandError(executable, argv, result.status, SUPPRESSED_STDERR);
}
function outcome(harness, action, status, nativeCli, guide) {
    return { harness, action, status, nativeCli, guide };
}
function isEnoent(error) {
    return error !== undefined && "code" in error && error.code === "ENOENT";
}
function assertNever(value) {
    throw new Error(`Unexpected lifecycle adapter: ${JSON.stringify(value)}`);
}
