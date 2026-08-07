import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const DEFAULT_LIMITS = {
    maxInputBytes: 512 * 1024,
    maxOverflowInputBytes: 8 * 1024 * 1024,
    maxStringBytes: 64 * 1024,
    maxPayloadBytes: 256 * 1024,
    maxParseErrorPreviewBytes: 4 * 1024,
};
function resolveHome(env = process.env) {
    return path.resolve(env.AGENT_LCM_HOME || path.join(os.homedir(), ".agent-lcm"));
}
export function loadConfig(options = {}) {
    const home = path.resolve(options.home || resolveHome(options.env));
    const retention = retentionDays(home, options.env ?? process.env);
    const segmentsDir = path.join(home, "segments");
    return {
        home,
        rawLogPath: path.join(home, "events.jsonl"),
        segmentsDir,
        manifestPath: path.join(segmentsDir, "manifest.json"),
        maintenancePath: path.join(home, "maintenance.lock.sqlite"),
        indexPath: path.join(home, "index.sqlite"),
        overflowDir: path.join(home, "overflow"),
        inboxDir: path.join(home, "inbox"),
        quarantineDir: path.join(home, "quarantine"),
        runtimeDir: path.join(home, "runtime"),
        socketPath: path.join(home, "runtime", "daemon.sock"),
        tokenPath: path.join(home, "runtime", "agent-lcm.token"),
        retentionDays: retention.value,
        configError: retention.error,
        limits: DEFAULT_LIMITS,
    };
}
function retentionDays(home, env) {
    const raw = env.AGENT_LCM_RETENTION_DAYS ?? envFileValue(path.join(home, ".env"));
    if (raw === undefined)
        return {};
    if (!/^[1-9][0-9]*$/u.test(raw)) {
        return { error: "AGENT_LCM_RETENTION_DAYS must be a positive integer." };
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) {
        return { error: "AGENT_LCM_RETENTION_DAYS must be a positive safe integer." };
    }
    return { value };
}
function envFileValue(envPath) {
    if (!fs.existsSync(envPath))
        return undefined;
    let value;
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/u)) {
        if (line.length === 0 || line.startsWith("#"))
            continue;
        if (!line.startsWith("AGENT_LCM_RETENTION_DAYS="))
            continue;
        if (value !== undefined)
            return "";
        value = line.slice("AGENT_LCM_RETENTION_DAYS=".length);
    }
    return value;
}
export function pluginRoot() {
    return path.resolve(fileURLToPath(new URL("../", import.meta.url)));
}
export function codexHome(env = process.env) {
    return path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}
