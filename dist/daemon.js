import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readCodexSessions } from "./codex-import.js";
import { DAEMON_PROTOCOL_VERSION, LEGACY_COMPATIBLE_DAEMON_VERSION } from "./daemon-protocol.js";
import { decodePersistedEvent } from "./event-codec.js";
import { drainInbox } from "./inbox.js";
import { callTool } from "./mcp-tools.js";
import { maintenanceNeeded, runMaintenanceOnce } from "./maintenance.js";
import { hasCode, ipcAddress, prepareIpcAddress, readOrCreateToken, sendDaemonRequest, tokenMatches } from "./ipc.js";
import { createStorage } from "./storage.js";
export const CURRENT_DAEMON_VERSION = LEGACY_COMPATIBLE_DAEMON_VERSION;
const PID_FILE = "daemon.pid";
const VERSION_FILE = "daemon.version";
const OWNERSHIP_FILE = "daemon.lock.sqlite";
const START_TIMEOUT_MS = 5_000;
const START_POLL_MS = 25;
const IMPORT_BATCH_SIZE = 5_000;
export async function startDaemon(config) {
    const token = readOrCreateToken(config);
    if (await daemonIsRunning(config, token))
        return;
    const ownership = await acquireOwnership(config, token);
    if (!ownership)
        return;
    const server = net.createServer();
    const storage = {};
    let ownsEndpoint = false;
    let orderly = false;
    try {
        ownsEndpoint = await bindDaemonEndpoint(config, server, token);
        if (!ownsEndpoint)
            return;
        writePrivate(path.join(config.runtimeDir, PID_FILE), `${JSON.stringify({ pid: process.pid })}\n`);
        writePrivate(path.join(config.runtimeDir, VERSION_FILE), `${daemonVersion()}\n`);
        await serve(config, server, storage, token, () => { orderly = true; });
    }
    finally {
        try {
            if (orderly)
                await drainStorageInboxFully(config, storage, async (operation) => operation());
        }
        finally {
            try {
                storage.writer?.close();
            }
            finally {
                try {
                    if (server.listening)
                        await closeServer(server);
                }
                finally {
                    try {
                        if (ownsEndpoint && process.platform !== "win32")
                            unlinkIfPresent(ipcAddress(config));
                        if (ownsEndpoint) {
                            unlinkIfPresent(path.join(config.runtimeDir, PID_FILE));
                            unlinkIfPresent(path.join(config.runtimeDir, VERSION_FILE));
                        }
                    }
                    finally {
                        releaseOwnership(ownership);
                    }
                }
            }
        }
    }
}
async function serve(config, server, storage, token, markOrderly) {
    let chain = Promise.resolve();
    let draining;
    let shuttingDown = false;
    const sockets = new Set();
    const activeSockets = new Set();
    let resolveStopped;
    const stopped = new Promise((resolve) => { resolveStopped = resolve; });
    const enqueue = (operation) => {
        const result = chain.then(operation);
        chain = result.then(() => undefined, () => undefined);
        return result;
    };
    const requestDrain = () => {
        if (draining)
            return draining;
        draining = (async () => {
            const report = { ingested: 0, duplicates: 0, quarantined: 0 };
            do {
                mergeDrainReports(report, await drainStorageInbox(config, storage, enqueue));
                if (shuttingDown || !hasInboxItems(config))
                    break;
                await new Promise((resolve) => setImmediate(resolve));
            } while (hasInboxItems(config));
            storage.drainError = undefined;
            return report;
        })().finally(() => { draining = undefined; });
        return draining;
    };
    const scheduleDrain = () => {
        void requestDrain().catch((error) => {
            storage.drainError = error instanceof Error ? error.message : String(error);
        });
    };
    const scheduleShutdown = () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        markOrderly();
        const closing = closeServer(server);
        for (const socket of sockets) {
            if (!activeSockets.has(socket))
                socket.destroy();
        }
        void Promise.all([chain, closing]).finally(() => {
            for (const socket of sockets)
                socket.destroy();
            resolveStopped();
        });
    };
    const onSignal = () => scheduleShutdown();
    server.on("connection", (socket) => {
        if (shuttingDown) {
            socket.destroy();
            return;
        }
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => socket.destroy());
        let buffer = "";
        let handled = false;
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => {
            if (handled || shuttingDown) {
                socket.destroy();
                return;
            }
            buffer += chunk;
            if (Buffer.byteLength(buffer, "utf8") > config.limits.maxInputBytes) {
                handled = true;
                endWithResponse(socket, { version: 1, id: "", ok: false, error: "request too large" });
                return;
            }
            const newline = buffer.indexOf("\n");
            if (newline !== -1) {
                handled = true;
                socket.pause();
                const line = buffer.slice(0, newline);
                let request;
                try {
                    request = parseRequest(line);
                    if (!tokenMatches(request.token, token))
                        throw new Error("authentication failed");
                }
                catch (error) {
                    endWithResponse(socket, {
                        version: 1,
                        id: requestId(line),
                        ok: false,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    return;
                }
                activeSockets.add(socket);
                const respond = async (operation) => {
                    try {
                        const result = await operation;
                        await writeResponse(socket, { version: 1, id: request.id, ok: true, result }).catch(() => socket.destroy());
                        if (request.method === "shutdown" || request.method === "replace")
                            scheduleShutdown();
                    }
                    catch (error) {
                        await writeResponse(socket, {
                            version: 1,
                            id: request.id,
                            ok: false,
                            error: error instanceof Error ? error.message : String(error),
                        }).catch(() => socket.destroy());
                    }
                    finally {
                        activeSockets.delete(socket);
                        socket.end();
                    }
                };
                if (request.method === "health") {
                    void respond(Promise.resolve(dispatchRequest(config, storage, request)));
                    scheduleDrain();
                }
                else if (request.method === "drain") {
                    void respond(requestDrain());
                }
                else {
                    if (request.method === "tool" || request.method === "cli" || request.method === "ingest")
                        scheduleDrain();
                    void respond(enqueue(() => dispatchRequest(config, storage, request)));
                }
            }
        });
    });
    try {
        process.once("SIGINT", onSignal);
        process.once("SIGTERM", onSignal);
        scheduleDrain();
        await stopped;
        await draining?.catch(() => undefined);
        await chain;
    }
    finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
    }
}
async function dispatchRequest(config, storage, request) {
    switch (request.method) {
        case "health":
            return {
                running: true,
                pid: process.pid,
                version: daemonVersion(),
                protocol_version: daemonProtocolVersion(),
                queue_depth: countFiles(config.inboxDir, (name) => name.endsWith(".json")),
                quarantine_count: countFiles(config.quarantineDir),
                ...(storage.maintenanceError ? { maintenance_error: storage.maintenanceError } : {}),
                ...(storage.drainError ? { drain_error: storage.drainError } : {}),
            };
        case "drain":
            return drainStorageInbox(config, storage, async (operation) => operation());
        case "ingest":
            return ingestImportedEvents(config, storage, request.params);
        case "tool":
            return withReadableStorage(config, storage, (reader) => callTool(reader, request.params));
        case "cli":
            return callCli(config, storage, request.params);
        case "shutdown":
            return { stopping: true };
        case "replace":
            return { replacing: true, version: request.params.version };
    }
}
function ingestImportedEvents(config, storage, params) {
    const events = normalizedEvents(params.events);
    const rebuildSessions = params.rebuildSessions === undefined ? undefined : stringSet(params.rebuildSessions);
    if (!rebuildSessions && params.rebuildSessions !== undefined)
        throw new Error("invalid daemon ingest sessions");
    const writer = writableStorage(config, storage);
    const result = writer.ingestMany(events, { rebuildSummaries: false });
    return {
        ...result,
        rebuiltSessions: rebuildSessions ? writer.rebuildSessionMemorySummaries(rebuildSessions) : [],
    };
}
function normalizedEvents(value) {
    if (!Array.isArray(value))
        throw new Error("invalid daemon ingest events");
    return value.map((event) => decodePersistedEvent(JSON.stringify(event)));
}
async function callCli(config, daemonStorage, params) {
    if (params.command === "maintain")
        return maintainStorage(config, daemonStorage, true);
    const write = params.command === "cleanup" && params.apply === true;
    return withStorage(config, daemonStorage, write, (storage) => callCliWithStorage(storage, params));
}
function callCliWithStorage(storage, params) {
    switch (params.command) {
        case "health": return storage.health();
        case "stats": return storage.stats();
        case "cleanup": return storage.cleanupIndex({ apply: params.apply === true });
        case "sessions": return storage.listSessions({
            since: stringParam(params.since),
            until: stringParam(params.until),
            cwd: stringParam(params.cwd),
            repoRoot: stringParam(params.repoRoot),
            parentSessionId: stringParam(params.parentSessionId),
            rootsOnly: booleanParam(params.rootsOnly),
            includeSummaries: booleanParam(params.includeSummaries),
            limit: numberParam(params.limit),
            cursor: stringParam(params.cursor),
        });
        case "usage": return storage.usage({
            since: stringParam(params.since),
            until: stringParam(params.until),
            cwd: stringParam(params.cwd),
            repoRoot: stringParam(params.repoRoot),
            parentSessionId: stringParam(params.parentSessionId),
            rootsOnly: booleanParam(params.rootsOnly),
        });
        case "context-plan": return storage.getContextPlan({
            sessionId: stringParam(params.sessionId),
            cwd: stringParam(params.cwd),
            repoRoot: stringParam(params.repoRoot),
            modelContextWindow: numberParam(params.modelContextWindow),
            autoCompactTokenLimit: numberParam(params.autoCompactTokenLimit),
            recentEventLimit: numberParam(params.recentEventLimit),
        });
        default: throw new Error("Unsupported daemon CLI command.");
    }
}
function stringParam(value) {
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
function numberParam(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function booleanParam(value) {
    return typeof value === "boolean" ? value : undefined;
}
async function drainStorageInbox(config, storage, enqueue) {
    const report = hasInboxItems(config)
        ? await drainInbox(config, (events) => ingestInboxEvents(config, storage, events, enqueue))
        : { ingested: 0, duplicates: 0, quarantined: 0 };
    if (!hasInboxItems(config))
        maintainStorage(config, storage);
    return report;
}
async function ingestInboxEvents(config, storage, events, enqueue) {
    const result = await enqueue(() => writableStorage(config, storage).ingestMany(events));
    const transcriptPaths = new Set(events.flatMap((event) => {
        const value = event.hook_event === "SubagentStop" ? event.payload.agent_transcript_path : undefined;
        return typeof value === "string" && value.trim().length > 0 ? [value.trim()] : [];
    }));
    const imported = [];
    for (const transcriptPath of transcriptPaths) {
        const parsed = await readCodexSessions(transcriptPath, ({ event }) => imported.push(event));
        for (const error of parsed.errors) {
            process.stderr.write(`agent-lcm: failed to import subagent transcript: ${error.message}\n`);
        }
        const readError = parsed.errors.find((error) => error.line === undefined);
        if (readError)
            throw new Error(`failed to import subagent transcript: ${readError.message}`);
    }
    const touchedSessions = new Set(imported.map((event) => event.session_id));
    for (let index = 0; index < imported.length; index += IMPORT_BATCH_SIZE) {
        await new Promise((resolve) => setImmediate(resolve));
        const batch = imported.slice(index, index + IMPORT_BATCH_SIZE);
        await enqueue(() => writableStorage(config, storage).ingestMany(batch, { rebuildSummaries: false }));
    }
    if (touchedSessions.size > 0) {
        await enqueue(() => writableStorage(config, storage).rebuildSessionMemorySummaries(touchedSessions));
    }
    return result;
}
async function drainStorageInboxFully(config, storage, enqueue) {
    const report = { ingested: 0, duplicates: 0, quarantined: 0 };
    do {
        mergeDrainReports(report, await drainStorageInbox(config, storage, enqueue));
    } while (hasInboxItems(config));
    return report;
}
function mergeDrainReports(target, source) {
    target.ingested += source.ingested;
    target.duplicates += source.duplicates;
    target.quarantined += source.quarantined;
}
function maintainStorage(config, storage, force = false) {
    if (!fs.existsSync(config.manifestPath) && fs.existsSync(config.rawLogPath)) {
        writableStorage(config, storage);
    }
    if (!force && !maintenanceNeeded(config))
        return undefined;
    storage.writer?.close();
    storage.writer = undefined;
    try {
        const report = runMaintenanceOnce(config);
        storage.maintenanceError = report.errors.length > 0 ? report.errors.join("; ") : undefined;
        return report;
    }
    catch (error) {
        storage.maintenanceError = error instanceof Error ? error.message : String(error);
        if (force)
            throw error;
        return undefined;
    }
}
function stringSet(value) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
        return undefined;
    return new Set(value);
}
function withReadableStorage(config, storage, operation) {
    return withStorage(config, storage, false, operation);
}
function withStorage(config, storage, write, operation) {
    if (write)
        return operation(writableStorage(config, storage));
    if (storage.writer)
        return operation(storage.writer);
    const reader = createStorage({ config, readOnly: true });
    try {
        return operation(reader);
    }
    finally {
        reader.close();
    }
}
function writableStorage(config, storage) {
    return storage.writer ??= createStorage({ config });
}
function hasInboxItems(config) {
    return countFiles(config.inboxDir, (name) => name.endsWith(".json")) > 0;
}
function parseRequest(line) {
    const value = JSON.parse(line);
    if (!isRecord(value) || value.version !== 1 || typeof value.token !== "string" || typeof value.id !== "string"
        || !isMethod(value.method) || !isRecord(value.params)) {
        throw new Error("invalid daemon request");
    }
    return value;
}
function requestId(line) {
    try {
        const value = JSON.parse(line);
        return isRecord(value) && typeof value.id === "string" ? value.id : "";
    }
    catch {
        return "";
    }
}
function isMethod(value) {
    return value === "health" || value === "tool" || value === "cli" || value === "drain" || value === "ingest"
        || value === "shutdown" || value === "replace";
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function writeResponse(socket, response) {
    return new Promise((resolve, reject) => {
        socket.write(`${JSON.stringify(response)}\n`, (error) => error ? reject(error) : resolve());
    });
}
function endWithResponse(socket, response) {
    writeResponse(socket, response).then(() => socket.end(), () => socket.destroy());
}
function listen(server, address) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(address, () => {
            server.off("error", reject);
            resolve();
        });
    });
}
function closeServer(server) {
    return new Promise((resolve) => server.close(() => resolve()));
}
async function bindDaemonEndpoint(config, server, token) {
    const address = ipcAddress(config);
    prepareIpcAddress(address);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (true) {
        try {
            await listen(server, address);
            return true;
        }
        catch (error) {
            if (!hasCode(error, "EADDRINUSE"))
                throw error;
        }
        const probe = await probeEndpoint(address);
        if (probe.reachable) {
            if (await waitForBoundDaemon(config, token, deadline))
                return false;
        }
        else if (process.platform !== "win32" && (probe.code === "ENOENT" || probe.code === "ECONNREFUSED")) {
            unlinkIfPresent(address);
        }
        if (Date.now() >= deadline)
            throw new Error(`Timed out waiting to own the agent-lcm endpoint at ${address}.`);
        await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
    }
}
async function acquireOwnership(config, token) {
    fs.mkdirSync(config.runtimeDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(config.runtimeDir, 0o700);
    const lockPath = path.join(config.runtimeDir, OWNERSHIP_FILE);
    fs.closeSync(fs.openSync(lockPath, "a", 0o600));
    fs.chmodSync(lockPath, 0o600);
    const database = new DatabaseSync(lockPath, { timeout: START_POLL_MS });
    const deadline = Date.now() + START_TIMEOUT_MS;
    try {
        while (true) {
            try {
                database.exec("BEGIN EXCLUSIVE");
                hardenOwnershipFiles(lockPath);
                return database;
            }
            catch (error) {
                if (!isSqliteBusy(error))
                    throw error;
            }
            if (await daemonIsRunning(config, token)) {
                database.close();
                return undefined;
            }
            if (Date.now() >= deadline) {
                throw new Error(`Timed out waiting to own the agent-lcm daemon at ${ipcAddress(config)}.`);
            }
            await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
        }
    }
    catch (error) {
        database.close();
        throw error;
    }
}
function releaseOwnership(database) {
    try {
        database.exec("ROLLBACK");
    }
    finally {
        database.close();
    }
}
function hardenOwnershipFiles(lockPath) {
    for (const candidate of [lockPath, `${lockPath}-journal`, `${lockPath}-wal`, `${lockPath}-shm`]) {
        try {
            fs.chmodSync(candidate, 0o600);
        }
        catch (error) {
            if (!hasCode(error, "ENOENT"))
                throw error;
        }
    }
}
function isSqliteBusy(error) {
    return error instanceof Error && (Reflect.get(error, "errcode") === 5 || Reflect.get(error, "errcode") === 6);
}
async function daemonIsRunning(config, token) {
    try {
        const response = await sendDaemonRequest(ipcAddress(config), {
            version: 1,
            token,
            id: "startup-probe",
            method: "health",
            params: {},
        }, 250);
        return response.ok;
    }
    catch {
        return false;
    }
}
async function waitForBoundDaemon(config, token, deadline) {
    while (Date.now() < deadline) {
        if (await daemonIsRunning(config, token))
            return true;
        if (!(await probeEndpoint(ipcAddress(config))).reachable)
            return false;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for the agent-lcm daemon at ${ipcAddress(config)}.`);
}
function probeEndpoint(address, timeoutMs = 250) {
    return new Promise((resolve) => {
        const socket = net.createConnection(address);
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            socket.destroy();
            resolve(result);
        };
        const timeout = setTimeout(() => finish({ reachable: false }), timeoutMs);
        socket.once("connect", () => finish({ reachable: true }));
        socket.once("error", (error) => finish({ reachable: false, code: String(Reflect.get(error, "code") ?? "") }));
    });
}
function writePrivate(filePath, contents) {
    fs.writeFileSync(filePath, contents, { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
}
function unlinkIfPresent(filePath) {
    try {
        fs.unlinkSync(filePath);
    }
    catch (error) {
        if (!hasCode(error, "ENOENT"))
            throw error;
    }
}
function countFiles(directory, predicate = () => true) {
    try {
        return fs.readdirSync(directory).filter(predicate).length;
    }
    catch (error) {
        if (hasCode(error, "ENOENT"))
            return 0;
        throw error;
    }
}
function daemonVersion() {
    return process.env.AGENT_LCM_DAEMON_VERSION || CURRENT_DAEMON_VERSION;
}
function daemonProtocolVersion() {
    const override = process.env.AGENT_LCM_DAEMON_PROTOCOL_VERSION;
    return override === undefined ? DAEMON_PROTOCOL_VERSION : Number(override);
}
