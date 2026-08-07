import { setupStatus } from "./setup.js";
export function buildDoctorReport(args) {
    const checks = [
        check("plugin-wiring", "Plugin wiring", booleanValue(args.status.plugin_configured) && booleanValue(args.status.mcp_configured) && booleanValue(args.status.hooks_configured), "agent-lcm is configured with MCP and capture hooks.", "agent-lcm is not fully wired into this adapter.", "Install the Agent LCM plugin for this adapter, then restart the harness so MCP and hooks load."),
        check("recall-skill", "LCM recall skill", booleanValue(args.status.recall_skill_available), "The lcm-recall skill is available.", "The lcm-recall skill is missing from the plugin root.", "Reinstall the Agent LCM plugin through this harness, then restart it."),
        check("storage-index", "Storage index", args.health.index_available, `SQLite index is available at ${args.health.index_path}.`, args.health.index_error ? `SQLite index is unavailable: ${args.health.index_error}` : `SQLite index is unavailable at ${args.health.index_path}.`, "Run `agent-lcm health --json`; if the index is corrupt, move it aside and re-import or let hooks rebuild it.", args.health.index_error ? "fail" : "warn"),
        check("event-capture", "Event capture", args.health.event_count > 0, `${args.health.event_count} events are indexed.`, "No LCM events are indexed yet.", "Start a new harness session after installing hooks, or run `agent-lcm import --all` to backfill existing sessions."),
        check("daemon", "Shared daemon", args.daemon.running, `The shared daemon is running (PID ${args.daemon.pid ?? "unknown"}).`, "The shared daemon is not running.", "Run `agent-lcm daemon start`."),
        check("capture-queue", "Capture queue", args.daemon.queue_depth === 0, "The capture queue is empty.", `${args.daemon.queue_depth} captured event${args.daemon.queue_depth === 1 ? " is" : "s are"} waiting for the daemon.`, "Run `agent-lcm daemon start`; if the count remains nonzero, run `agent-lcm doctor --json` again after checking the daemon."),
        check("capture-quarantine", "Capture quarantine", args.daemon.quarantine_count === 0, "No malformed capture files are quarantined.", `${args.daemon.quarantine_count} malformed capture file${args.daemon.quarantine_count === 1 ? " is" : "s are"} quarantined.`, "Inspect the local Agent LCM quarantine directory before removing malformed capture files."),
        summaryIndexCheck(args.health),
    ];
    const recommendations = checks
        .filter((item) => item.status !== "ok" && item.recommendation)
        .map((item) => item.recommendation);
    const adapter_status = adapterStatus(args.status);
    return {
        status: checks.some((item) => item.status === "fail") ? "fail" : checks.some((item) => item.status === "warn") ? "warn" : "ok",
        checks,
        recommendations,
        status_report: args.status,
        adapter_status,
        health: args.health,
    };
}
function adapterStatus(status) {
    const codexConfigured = booleanValue(status.plugin_configured)
        && booleanValue(status.mcp_configured)
        && booleanValue(status.hooks_configured);
    const setups = setupStatus();
    return {
        codex: {
            configured: codexConfigured,
            state: codexConfigured ? "configured" : "not_configured",
            detail: codexConfigured ? "Codex MCP and hooks are configured." : "Codex MCP or hooks are not configured.",
            ...(codexConfigured ? {} : { setup_gap: "Install the Agent LCM plugin and restart Codex." }),
        },
        cursor: setupAdapter("cursor", setups.cursor.configured),
        vscode: setupAdapter("vscode", setups.vscode.configured),
        copilot: setupAdapter("copilot", setups.copilot.configured),
        kiro: setupAdapter("kiro", setups.kiro.configured),
    };
}
function setupAdapter(harness, configured) {
    return configured
        ? { configured: true, state: "configured", detail: `${harness} capture hooks are configured.` }
        : {
            configured: false,
            state: "not_configured",
            detail: "Not configured.",
            setup_gap: `Run \`agent-lcm setup ${harness}\`, then restart ${harness === "vscode" ? "VS Code" : harness === "copilot" ? "Copilot" : harness[0].toUpperCase() + harness.slice(1)}.`,
        };
}
function summaryIndexCheck(health) {
    if (!health.index_available) {
        return {
            id: "summary-index",
            label: "Summary index",
            status: "warn",
            detail: "Summary-node counts could not be checked because the SQLite index is unavailable.",
            recommendation: "Fix the storage-index check first; summaries are stored in the SQLite index.",
        };
    }
    return check("summary-index", "Summary index", (health.summary_node_count ?? 0) > 0 || health.event_count === 0, `${health.summary_node_count ?? 0} summary nodes are indexed.`, "Events exist but no summary nodes are indexed.", "Run `agent-lcm stats --json`; new high-signal events should rebuild summaries automatically.");
}
function check(id, label, passed, okDetail, problemDetail, recommendation, problemStatus = "warn") {
    return passed
        ? { id, label, status: "ok", detail: okDetail }
        : { id, label, status: problemStatus, detail: problemDetail, recommendation };
}
function booleanValue(value) {
    return value === true;
}
