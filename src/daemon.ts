import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import type { LcmConfig } from "./config.ts";
import { drainInbox } from "./inbox.ts";
import { callTool } from "./mcp-tools.ts";
import { hasCode, ipcAddress, readOrCreateToken, sendDaemonRequest, tokenMatches, type DaemonRequest, type DaemonResponse } from "./ipc.ts";
import { createStorage, type LcmStorage } from "./storage.ts";

export const CURRENT_DAEMON_VERSION = "0.1.0";

const PID_FILE = "daemon.pid";
const VERSION_FILE = "daemon.version";
const LOCK_FILE = "daemon.lock";

export async function startDaemon(config: LcmConfig): Promise<void> {
  const token = readOrCreateToken(config);
  if (await daemonIsRunning(config, token)) return;
  const lock = acquireDaemonLock(config);
  if (lock === undefined) {
    await waitForWinner(config, token);
    return;
  }

  let storage: LcmStorage | undefined;
  let server: net.Server | undefined;
  let ownsSocket = false;
  let orderly = false;
  try {
    if (await daemonIsRunning(config, token)) return;
    if (process.platform !== "win32") unlinkIfPresent(config.socketPath);
    server = net.createServer();
    storage = createStorage({ config });
    await serve(config, server, storage, token, () => {
      ownsSocket = true;
      writePrivate(path.join(config.runtimeDir, PID_FILE), `${process.pid}\n`);
      writePrivate(path.join(config.runtimeDir, VERSION_FILE), `${daemonVersion()}\n`);
      drainStorageInbox(config, storage!);
    }, () => { orderly = true; });
  } finally {
    if (orderly && storage) drainStorageInbox(config, storage);
    storage?.close();
    if (server?.listening) await closeServer(server);
    unlinkOwnedMetadata(config);
    if (ownsSocket && process.platform !== "win32") unlinkIfPresent(config.socketPath);
    releaseDaemonLock(config, lock);
  }
}

async function serve(
  config: LcmConfig,
  server: net.Server,
  storage: LcmStorage,
  token: string,
  ready: () => void,
  markOrderly: () => void,
): Promise<void> {
  let chain = Promise.resolve();
  let shuttingDown = false;
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });

  const scheduleShutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    markOrderly();
    server.close(() => resolveStopped());
  };

  const onSignal = (): void => scheduleShutdown();
  server.on("connection", (socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > config.limits.maxInputBytes) {
        endWithResponse(socket, { version: 1, id: "", ok: false, error: "request too large" });
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let request: DaemonRequest;
        try {
          request = parseRequest(line);
          if (!tokenMatches(request.token, token)) throw new Error("authentication failed");
        } catch (error) {
          endWithResponse(socket, {
            version: 1,
            id: requestId(line),
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        chain = chain.then(async () => {
          try {
            drainStorageInbox(config, storage);
            const result = dispatchRequest(config, storage, request);
            await writeResponse(socket, { version: 1, id: request.id, ok: true, result }).catch(() => socket.destroy());
            if (request.method === "shutdown" || request.method === "replace") scheduleShutdown();
          } catch (error) {
            await writeResponse(socket, {
              version: 1,
              id: request.id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }).catch(() => socket.destroy());
          }
        });
      }
    });
  });

  try {
    await listen(server, ipcAddress(config));
    ready();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    await stopped;
    await chain;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

function dispatchRequest(config: LcmConfig, storage: LcmStorage, request: DaemonRequest): unknown {
  switch (request.method) {
    case "health":
      return {
        running: true,
        pid: process.pid,
        version: daemonVersion(),
        queue_depth: countFiles(config.inboxDir, (name) => name.endsWith(".json")),
        quarantine_count: countFiles(config.quarantineDir),
      };
    case "drain":
      return drainStorageInbox(config, storage);
    case "tool":
      return callTool(request.params);
    case "cli":
      return callCli(storage, request.params);
    case "shutdown":
      return { stopping: true };
    case "replace":
      return { replacing: true, version: request.params.version };
  }
}

function callCli(storage: LcmStorage, params: Record<string, unknown>): unknown {
  switch (params.command) {
    case "health": return storage.health();
    case "stats": return storage.stats();
    case "cleanup": return storage.cleanupIndex({ apply: params.apply === true });
    default: throw new Error("Unsupported daemon CLI command.");
  }
}

function drainStorageInbox(config: LcmConfig, storage: LcmStorage) {
  return drainInbox(config, (event) => {
    if (storage.hasEvent(event.event_id)) return "duplicate";
    storage.ingest(event);
    return "ingested";
  });
}

function parseRequest(line: string): DaemonRequest {
  const value: unknown = JSON.parse(line);
  if (!isRecord(value) || value.version !== 1 || typeof value.token !== "string" || typeof value.id !== "string"
    || !isMethod(value.method) || !isRecord(value.params)) {
    throw new Error("invalid daemon request");
  }
  return value as DaemonRequest;
}

function requestId(line: string): string {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) && typeof value.id === "string" ? value.id : "";
  } catch {
    return "";
  }
}

function isMethod(value: unknown): value is DaemonRequest["method"] {
  return value === "health" || value === "tool" || value === "cli" || value === "drain"
    || value === "shutdown" || value === "replace";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function writeResponse(socket: net.Socket, response: DaemonResponse): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(`${JSON.stringify(response)}\n`, (error) => error ? reject(error) : resolve());
  });
}

function endWithResponse(socket: net.Socket, response: DaemonResponse): void {
  writeResponse(socket, response).then(() => socket.end(), () => socket.destroy());
}

function listen(server: net.Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function acquireDaemonLock(config: LcmConfig): number | undefined {
  const lockPath = path.join(config.runtimeDir, LOCK_FILE);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n`);
      fs.fsyncSync(descriptor);
      return descriptor;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const owner = readPid(lockPath);
      if (owner !== undefined && processIsAlive(owner)) return undefined;
      unlinkIfPresent(lockPath);
    }
  }
  return undefined;
}

function releaseDaemonLock(config: LcmConfig, descriptor: number): void {
  fs.closeSync(descriptor);
  const lockPath = path.join(config.runtimeDir, LOCK_FILE);
  if (readPid(lockPath) === process.pid) unlinkIfPresent(lockPath);
}

async function daemonIsRunning(config: LcmConfig, token: string): Promise<boolean> {
  try {
    const response = await sendDaemonRequest(ipcAddress(config), {
      version: 1,
      token,
      id: "startup-probe",
      method: "health",
      params: {},
    }, 250);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForWinner(config: LcmConfig, token: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await daemonIsRunning(config, token))) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the winning agent-lcm daemon starter.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

function readPid(filePath: string): number | undefined {
  try {
    const pid = Number(fs.readFileSync(filePath, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function writePrivate(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function unlinkOwnedMetadata(config: LcmConfig): void {
  const pidPath = path.join(config.runtimeDir, PID_FILE);
  if (readPid(pidPath) !== process.pid) return;
  unlinkIfPresent(pidPath);
  unlinkIfPresent(path.join(config.runtimeDir, VERSION_FILE));
}

function unlinkIfPresent(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

function countFiles(directory: string, predicate: (name: string) => boolean = () => true): number {
  try {
    return fs.readdirSync(directory).filter(predicate).length;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return 0;
    throw error;
  }
}

function daemonVersion(): string {
  return process.env.AGENT_LCM_DAEMON_VERSION || CURRENT_DAEMON_VERSION;
}
