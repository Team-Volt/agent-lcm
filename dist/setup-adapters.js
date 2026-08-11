import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
    const probe = spawnLifecycleCommand(adapter.executable, adapter.probeArgv, env);
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
    const probe = spawnLifecycleCommand(adapter.executable, adapter.probeArgv, env);
    if (isEnoent(probe.error))
        return outcome(harness, action, "manual-required", null, adapter.guide);
    if (probe.error !== undefined || probe.status !== 0) {
        throw new NativeLifecycleCommandError(adapter.executable, adapter.probeArgv, probe.status, SUPPRESSED_STDERR);
    }
    return outcome(harness, action, "manual-required", adapter.executable, adapter.guide);
}
function runNativeCommand(executable, argv, env) {
    const result = spawnLifecycleCommand(executable, argv, env);
    if (result.status === 0)
        return;
    throw new NativeLifecycleCommandError(executable, argv, result.status, SUPPRESSED_STDERR);
}
function spawnLifecycleCommand(executable, argv, env) {
    const options = { encoding: "utf8", env, shell: false, stdio: ["ignore", "pipe", "pipe"] };
    const direct = spawnSync(executable, argv, options);
    if (process.platform !== "win32" || !needsWindowsShim(direct.error))
        return direct;
    const shim = resolveWindowsShim(executable, argv, env);
    if (shim === null)
        return direct;
    assertSafeWindowsCommand([shim, ...argv], executable, argv);
    const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", shim, ...argv], options);
    if (isEnoent(result.error)) {
        throw new NativeLifecycleCommandError(executable, argv, result.status, SUPPRESSED_STDERR);
    }
    return result;
}
function resolveWindowsShim(executable, argv, env) {
    const commandEnv = env ?? process.env;
    const searchPath = Object.entries(commandEnv).find(([key]) => key.toUpperCase() === "PATH")?.[1];
    if (searchPath === undefined)
        return null;
    for (const entry of searchPath.split(path.delimiter)) {
        const directory = entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
        if (directory.length === 0)
            continue;
        for (const extension of [".cmd", ".bat"]) {
            const candidate = path.join(directory, `${executable}${extension}`);
            try {
                if (fs.statSync(candidate).isFile())
                    return candidate;
            }
            catch (error) {
                if (isMissingPathError(error))
                    continue;
                throw new NativeLifecycleCommandError(executable, argv, null, SUPPRESSED_STDERR);
            }
        }
    }
    return null;
}
function assertSafeWindowsCommand(values, executable, argv) {
    if (values.some((value) => /["&|<>^%!\r\n]/u.test(value))) {
        throw new NativeLifecycleCommandError(executable, argv, null, SUPPRESSED_STDERR);
    }
}
function outcome(harness, action, status, nativeCli, guide) {
    return { harness, action, status, nativeCli, guide };
}
function isEnoent(error) {
    return error !== undefined && "code" in error && error.code === "ENOENT";
}
function needsWindowsShim(error) {
    return error !== undefined && "code" in error && (error.code === "ENOENT" || error.code === "EINVAL");
}
function isMissingPathError(error) {
    return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
function assertNever(value) {
    throw new Error(`Unexpected lifecycle adapter: ${JSON.stringify(value)}`);
}
