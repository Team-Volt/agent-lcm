import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadConfig, pluginRoot, type LcmConfig } from "./config.ts";
import { DAEMON_PROTOCOL_VERSION, daemonProtocolCompatible } from "./daemon-protocol.ts";
import { ipcAddress, readToken, sendDaemonRequest, type DaemonRequest } from "./ipc.ts";

export type DaemonStatus = {
  running: boolean;
  pid?: number;
  version?: string;
  protocol_version?: number;
  queue_depth: number;
  quarantine_count: number;
};

const starts = new Map<string, Promise<void>>();
const DAEMON_START_TIMEOUT_MS = 5 * 60_000;
const DAEMON_RELEASE_TIMEOUT_MS = 10_000;
const DAEMON_REQUEST_TIMEOUT_MS = 5 * 60_000;
const DAEMON_HEALTH_TIMEOUT_MS = 5_000;

export async function ensureDaemon(config: LcmConfig = loadConfig()): Promise<void> {
  const current = starts.get(config.home);
  if (current) return current;
  const starting = ensureDaemonOnce(config).finally(() => starts.delete(config.home));
  starts.set(config.home, starting);
  return starting;
}

async function ensureDaemonOnce(config: LcmConfig): Promise<void> {
  let status = await daemonStatus(config);
  if (status.running && daemonProtocolCompatible(status)) return;
  if (status.running) {
    try {
      await daemonRequest(config, "replace", { protocol_version: DAEMON_PROTOCOL_VERSION });
    } catch {
      // Another starter may already be replacing it.
    }
    await waitForRelease(config, status.pid);
    status = await daemonStatus(config);
    if (status.running && daemonProtocolCompatible(status)) return;
  }

  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_LCM_HOME: config.home };
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
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

export async function daemonRequest<T>(
  config: LcmConfig,
  method: DaemonRequest["method"],
  params: Record<string, unknown>,
  responseTimeoutMs = method === "health" ? DAEMON_HEALTH_TIMEOUT_MS : DAEMON_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const token = readToken(config);
  if (!token) throw new Error("agent-lcm daemon authentication token is unavailable.");
  const response = await sendDaemonRequest(ipcAddress(config), {
    version: 1,
    token,
    id: `${process.pid}-${Date.now()}`,
    method,
    params,
  }, method === "health" ? undefined : DAEMON_REQUEST_TIMEOUT_MS, responseTimeoutMs);
  if (!response.ok) throw new Error(response.error);
  return response.result as T;
}

export async function daemonStatus(config: LcmConfig = loadConfig(), responseTimeoutMs = DAEMON_HEALTH_TIMEOUT_MS): Promise<DaemonStatus> {
  try {
    return await daemonRequest<DaemonStatus>(config, "health", {}, responseTimeoutMs);
  } catch {
    return {
      running: false,
      queue_depth: countFiles(config.inboxDir, (name) => name.endsWith(".json")),
      quarantine_count: countFiles(config.quarantineDir),
    };
  }
}

export async function stopDaemon(config: LcmConfig = loadConfig()): Promise<void> {
  const status = await daemonStatus(config);
  if (!status.running) return;
  try {
    await daemonRequest(config, "shutdown", {});
  } catch {
    // A concurrent shutdown can close the socket before this client reads its response.
  }
  await waitForRelease(config, status.pid);
}

async function waitForRelease(config: LcmConfig, ownerPid: number | undefined, timeoutMs = DAEMON_RELEASE_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = await daemonStatus(config, 1_000);
    if (status.running && status.pid !== ownerPid) return;
    if (!status.running && ownershipIsAvailable(config)) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for the agent-lcm daemon at ${ipcAddress(config)}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function ownershipIsAvailable(config: LcmConfig): boolean {
  const database = new DatabaseSync(path.join(config.runtimeDir, "daemon.lock.sqlite"), { timeout: 0 });
  try {
    database.exec("BEGIN EXCLUSIVE");
    database.exec("ROLLBACK");
    return true;
  } catch (error) {
    if (error instanceof Error && (Reflect.get(error, "errcode") === 5 || Reflect.get(error, "errcode") === 6)) return false;
    throw error;
  } finally {
    database.close();
  }
}

async function waitFor(
  config: LcmConfig,
  predicate: (status: DaemonStatus) => boolean,
  timeoutMs = DAEMON_START_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = await daemonStatus(config, 1_000);
    if (predicate(status)) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for the agent-lcm daemon at ${ipcAddress(config)}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function countFiles(directory: string, predicate: (name: string) => boolean = () => true): number {
  try {
    return fs.readdirSync(directory).filter(predicate).length;
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return 0;
    throw error;
  }
}
