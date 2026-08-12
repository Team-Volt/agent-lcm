import path from "node:path";
export class ClaudeLifecycleOutputError extends Error {
    name = "ClaudeLifecycleOutputError";
    argv;
    constructor(argv) {
        super("Claude CLI returned malformed lifecycle JSON.");
        this.argv = argv;
    }
}
export function runClaudeLifecycle(action, packageRoot, run) {
    if (action === "remove") {
        const argv = ["plugin", "list", "--json"];
        const plugins = parseRecords(run(argv), argv, isClaudePlugin);
        if (hasUserPlugin(plugins))
            run(["plugin", "uninstall", "agent-lcm@agent-lcm", "--scope", "user"]);
        return;
    }
    const marketplaceArgv = ["plugin", "marketplace", "list", "--json"];
    const marketplaces = parseRecords(run(marketplaceArgv), marketplaceArgv, isClaudeMarketplace);
    const marketplace = marketplaces.find((entry) => entry.name === "agent-lcm");
    if (marketplace !== undefined && path.resolve(marketplace.path) !== packageRoot) {
        throw new ClaudeLifecycleOutputError(marketplaceArgv);
    }
    if (marketplace === undefined)
        run(["plugin", "marketplace", "add", packageRoot, "--scope", "user"]);
    const pluginArgv = ["plugin", "list", "--json"];
    const plugins = parseRecords(run(pluginArgv), pluginArgv, isClaudePlugin);
    run(["plugin", hasUserPlugin(plugins) ? "update" : "install", "agent-lcm@agent-lcm", "--scope", "user"]);
}
function parseRecords(stdout, argv, isRecordType) {
    let value;
    try {
        value = JSON.parse(stdout);
    }
    catch {
        throw new ClaudeLifecycleOutputError(argv);
    }
    if (!Array.isArray(value) || !value.every(isRecordType))
        throw new ClaudeLifecycleOutputError(argv);
    return value;
}
function hasUserPlugin(plugins) {
    return plugins.some((plugin) => plugin.id === "agent-lcm@agent-lcm" && plugin.scope === "user");
}
function isClaudeMarketplace(value) {
    return isRecord(value)
        && typeof value.name === "string"
        && typeof value.source === "string"
        && typeof value.path === "string"
        && typeof value.installLocation === "string";
}
function isClaudePlugin(value) {
    return isRecord(value)
        && typeof value.id === "string"
        && typeof value.version === "string"
        && typeof value.scope === "string"
        && typeof value.enabled === "boolean"
        && typeof value.installPath === "string"
        && typeof value.installedAt === "string"
        && typeof value.lastUpdated === "string";
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
