import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
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
const START_TIMEOUT_MS = 5_000;
const LOCK_STABILITY_MS = 250;

type DaemonOwner = {
  pid: number;
  nonce: string;
  process_identity: string;
  created_at: string;
};

type DaemonLock = {
  descriptor: number;
  owner: DaemonOwner;
};

export function daemonLockPath(config: LcmConfig): string {
  return path.join(config.runtimeDir, LOCK_FILE);
}

export async function startDaemon(config: LcmConfig): Promise<void> {
  const token = readOrCreateToken(config);
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lock: DaemonLock | undefined;
  while (!lock) {
    if (await daemonIsRunning(config, token)) return;
    lock = acquireDaemonLock(config);
    if (lock) break;
    if (Date.now() >= deadline) throw new Error("Timed out waiting to own the agent-lcm daemon lock.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  let storage: LcmStorage | undefined;
  let server: net.Server | undefined;
  let ownsSocket = false;
  let orderly = false;
  try {
    if (await daemonIsRunning(config, token)) return;
    writePrivate(path.join(config.runtimeDir, PID_FILE), `${JSON.stringify(lock.owner)}\n`);
    writePrivate(path.join(config.runtimeDir, VERSION_FILE), `${daemonVersion()}\n`);
    if (process.platform !== "win32") unlinkIfPresent(config.socketPath);
    server = net.createServer();
    storage = createStorage({ config });
    await serve(config, server, storage, token, () => {
      ownsSocket = true;
      drainStorageInbox(config, storage!);
    }, () => { orderly = true; });
  } finally {
    if (orderly && storage) drainStorageInbox(config, storage);
    storage?.close();
    if (server?.listening) await closeServer(server);
    unlinkOwnedMetadata(config, lock.owner);
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
  const sockets = new Set<net.Socket>();
  const activeSockets = new Set<net.Socket>();
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });

  const scheduleShutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    markOrderly();
    server.close();
    for (const socket of sockets) {
      if (!activeSockets.has(socket)) socket.destroy();
    }
    void chain.finally(() => {
      for (const socket of sockets) socket.destroy();
      resolveStopped();
    });
  };

  const onSignal = (): void => scheduleShutdown();
  server.on("connection", (socket) => {
    if (shuttingDown) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
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
          return;
        }
        activeSockets.add(socket);
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
          } finally {
            activeSockets.delete(socket);
            socket.end();
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
      return callTool(storage, request.params);
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

function acquireDaemonLock(config: LcmConfig): DaemonLock | undefined {
  const lockPath = daemonLockPath(config);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, "wx", 0o600);
      const identity = processIdentity(process.pid);
      if (identity.length === 0) {
        fs.closeSync(descriptor);
        unlinkIfPresent(lockPath);
        throw new Error("Unable to verify the agent-lcm daemon process identity.");
      }
      const owner: DaemonOwner = {
        pid: process.pid,
        nonce: crypto.randomUUID(),
        process_identity: identity,
        created_at: new Date().toISOString(),
      };
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify(owner)}\n`);
        fs.fsyncSync(descriptor);
        return { descriptor, owner };
      } catch (error) {
        fs.closeSync(descriptor);
        unlinkIfPresent(lockPath);
        throw error;
      }
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      if (!daemonLockIsStale(config, lockPath)) return undefined;
      unlinkIfPresent(lockPath);
    }
  }
  return undefined;
}

function releaseDaemonLock(config: LcmConfig, lock: DaemonLock): void {
  fs.closeSync(lock.descriptor);
  const lockPath = daemonLockPath(config);
  if (readDaemonOwner(lockPath)?.nonce === lock.owner.nonce) unlinkIfPresent(lockPath);
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}

function daemonLockIsStale(config: LcmConfig, lockPath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(lockPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true;
    throw error;
  }
  const owner = readDaemonOwner(lockPath);
  if (!owner) return Date.now() - stat.mtimeMs >= LOCK_STABILITY_MS;
  if (!processIsAlive(owner.pid)) return true;
  if (owner.process_identity !== processIdentity(owner.pid)) return true;
  const metadata = readDaemonOwner(path.join(config.runtimeDir, PID_FILE));
  if (metadata?.nonce === owner.nonce && metadata.process_identity === owner.process_identity) return false;
  return Date.now() - stat.mtimeMs >= LOCK_STABILITY_MS;
}

function readDaemonOwner(filePath: string): DaemonOwner | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!isRecord(value) || !Number.isInteger(value.pid) || Number(value.pid) <= 0 || typeof value.nonce !== "string"
      || typeof value.process_identity !== "string" || typeof value.created_at !== "string") return undefined;
    return value as DaemonOwner;
  } catch {
    return undefined;
  }
}

function processIdentity(pid: number): string {
  try {
    if (process.platform === "win32") {
      return execFileSync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`,
      ], { encoding: "utf8", timeout: 1_000 }).trim();
    }
    return execFileSync("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 1_000 }).trim();
  } catch {
    return "";
  }
}

function writePrivate(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function unlinkOwnedMetadata(config: LcmConfig, owner: DaemonOwner): void {
  const pidPath = path.join(config.runtimeDir, PID_FILE);
  if (readDaemonOwner(pidPath)?.nonce !== owner.nonce) return;
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
