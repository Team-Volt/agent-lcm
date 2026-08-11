import { spawnSync } from "node:child_process";
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
const MAX_STDERR_CHARS = 4_096;
export const HARNESS_LIFECYCLE_ADAPTERS = {
    codex: {
        kind: "codex",
        executable: "codex",
        guide: `${GUIDE_ROOT}/codex.md`,
        probeArgv: ["plugin", "list"],
        setupArgv: [
            ["plugin", "marketplace", "add", "Team-Volt/agent-lcm"],
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
        setupArgv: [["plugin", "install", "Team-Volt/agent-lcm"]],
    },
    copilot: {
        kind: "copilot",
        executable: "copilot",
        guide: `${GUIDE_ROOT}/copilot.md`,
        probeArgv: ["plugin", "list"],
        setupArgv: [["plugin", "install", "Team-Volt/agent-lcm"]],
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
            return runNative(harness, action, adapter, options.env);
        case "codex":
            return runNative(harness, action, adapter, options.env);
        default:
            return assertNever(adapter);
    }
}
function runNative(harness, action, adapter, env) {
    const probe = spawnSync(adapter.executable, adapter.probeArgv, { encoding: "utf8", env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    if (isEnoent(probe.error) || probe.status !== 0) {
        return outcome(harness, action, "manual-required", null, adapter.guide);
    }
    const commands = action === "setup"
        ? adapter.setupArgv
        : adapter.kind === "codex" ? [adapter.removeArgv] : [];
    for (const argv of commands)
        runNativeCommand(adapter.executable, argv, env);
    return outcome(harness, action, "native-complete", adapter.executable, adapter.guide);
}
function manualOutcome(harness, action, adapter, env) {
    const probe = spawnSync(adapter.executable, adapter.probeArgv, { encoding: "utf8", env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const nativeCli = isEnoent(probe.error) || probe.status !== 0 ? null : adapter.executable;
    return outcome(harness, action, "manual-required", nativeCli, adapter.guide);
}
function runNativeCommand(executable, argv, env) {
    const result = spawnSync(executable, argv, { encoding: "utf8", env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    if (result.status === 0)
        return;
    throw new NativeLifecycleCommandError(executable, argv, result.status, boundedStderr(result.stderr));
}
function outcome(harness, action, status, nativeCli, guide) {
    return { harness, action, status, nativeCli, guide };
}
function boundedStderr(stderr) {
    const value = typeof stderr === "string" ? stderr : stderr?.toString("utf8") ?? "";
    return value.slice(0, MAX_STDERR_CHARS).trimEnd();
}
function isEnoent(error) {
    return error !== undefined && "code" in error && error.code === "ENOENT";
}
function assertNever(value) {
    throw new Error(`Unexpected lifecycle adapter: ${JSON.stringify(value)}`);
}
