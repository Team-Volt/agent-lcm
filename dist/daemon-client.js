import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, pluginRoot } from "./config.js";
import { DAEMON_PROTOCOL_VERSION, daemonProtocolCompatible } from "./daemon-protocol.js";
import { ipcAddress, readToken, sendDaemonRequest } from "./ipc.js";
const starts = new Map();
const DAEMON_TIMEOUT_MS = 10_000;
export async function ensureDaemon(config = loadConfig()) {
    const current = starts.get(config.home);
    if (current)
        return current;
    const starting = ensureDaemonOnce(config).finally(() => starts.delete(config.home));
    starts.set(config.home, starting);
    return starting;
}
async function ensureDaemonOnce(config) {
    let status = await daemonStatus(config);
    if (status.running && daemonProtocolCompatible(status))
        return;
    if (status.running) {
        try {
            await daemonRequest(config, "replace", { protocol_version: DAEMON_PROTOCOL_VERSION });
        }
        catch {
            // Another starter may already be replacing it.
        }
        await waitForRelease(config, status.pid);
        status = await daemonStatus(config);
        if (status.running && daemonProtocolCompatible(status))
            return;
    }
    const env = { ...process.env, AGENT_LCM_HOME: config.home };
    delete env.AGENT_LCM_DAEMON_VERSION;
    delete env.AGENT_LCM_DAEMON_PROTOCOL_VERSION;
    const child = spawn(process.execPath, ["--no-warnings", path.join(pluginRoot(), "bin", "agent-lcm"), "daemon", "run"], {
        cwd: pluginRoot(),
        detached: true,
        env,
        stdio: "ignore",
    });
    child.unref();
    try {
        await waitFor(config, (candidate) => candidate.running && daemonProtocolCompatible(candidate));
    }
    catch (error) {
        child.kill("SIGTERM");
        throw error;
    }
}
export async function daemonRequest(config, method, params) {
    const token = readToken(config);
    if (!token)
        throw new Error("agent-lcm daemon authentication token is unavailable.");
    const response = await sendDaemonRequest(ipcAddress(config), {
        version: 1,
        token,
        id: `${process.pid}-${Date.now()}`,
        method,
        params,
    });
    if (!response.ok)
        throw new Error(response.error);
    return response.result;
}
export async function daemonStatus(config = loadConfig()) {
    try {
        return await daemonRequest(config, "health", {});
    }
    catch {
        return {
            running: false,
            queue_depth: countFiles(config.inboxDir, (name) => name.endsWith(".json")),
            quarantine_count: countFiles(config.quarantineDir),
        };
    }
}
export async function stopDaemon(config = loadConfig()) {
    const status = await daemonStatus(config);
    if (!status.running)
        return;
    try {
        await daemonRequest(config, "shutdown", {});
    }
    catch {
        // A concurrent shutdown can close the socket before this client reads its response.
    }
    await waitForRelease(config, status.pid);
}
async function waitForRelease(config, ownerPid, timeoutMs = DAEMON_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const status = await daemonStatus(config);
        if (status.running && status.pid !== ownerPid)
            return;
        if (!status.running && ownershipIsAvailable(config))
            return;
        if (Date.now() >= deadline)
            throw new Error(`Timed out waiting for the agent-lcm daemon at ${ipcAddress(config)}.`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}
function ownershipIsAvailable(config) {
    const database = new DatabaseSync(path.join(config.runtimeDir, "daemon.lock.sqlite"), { timeout: 0 });
    try {
        database.exec("BEGIN EXCLUSIVE");
        database.exec("ROLLBACK");
        return true;
    }
    catch (error) {
        if (error instanceof Error && (Reflect.get(error, "errcode") === 5 || Reflect.get(error, "errcode") === 6))
            return false;
        throw error;
    }
    finally {
        database.close();
    }
}
async function waitFor(config, predicate, timeoutMs = DAEMON_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const status = await daemonStatus(config);
        if (predicate(status))
            return;
        if (Date.now() >= deadline)
            throw new Error(`Timed out waiting for the agent-lcm daemon at ${ipcAddress(config)}.`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}
function countFiles(directory, predicate = () => true) {
    try {
        return fs.readdirSync(directory).filter(predicate).length;
    }
    catch (error) {
        if (error instanceof Error && Reflect.get(error, "code") === "ENOENT")
            return 0;
        throw error;
    }
}
