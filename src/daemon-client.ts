import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { loadConfig, pluginRoot, type LcmConfig } from "./config.ts";
import { CURRENT_DAEMON_VERSION, daemonLockPath } from "./daemon.ts";
import { ipcAddress, readToken, sendDaemonRequest, type DaemonRequest } from "./ipc.ts";

export type DaemonStatus = {
  running: boolean;
  pid?: number;
  version?: string;
  queue_depth: number;
  quarantine_count: number;
};

const starts = new Map<string, Promise<void>>();

export async function ensureDaemon(config: LcmConfig = loadConfig()): Promise<void> {
  const current = starts.get(config.home);
  if (current) return current;
  const starting = ensureDaemonOnce(config).finally(() => starts.delete(config.home));
  starts.set(config.home, starting);
  return starting;
}

async function ensureDaemonOnce(config: LcmConfig): Promise<void> {
  let status = await daemonStatus(config);
  if (status.running && status.version === CURRENT_DAEMON_VERSION) return;
  if (status.running) {
    try {
      await daemonRequest(config, "replace", { version: CURRENT_DAEMON_VERSION });
    } catch {
      // Another starter may already be replacing it.
    }
    await waitForRelease(config, status.pid);
    status = await daemonStatus(config);
    if (status.running && status.version === CURRENT_DAEMON_VERSION) return;
  }

  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_LCM_HOME: config.home };
  delete env.AGENT_LCM_DAEMON_VERSION;
  const child = spawn(process.execPath, ["--no-warnings", path.join(pluginRoot(), "bin", "agent-lcm"), "daemon", "run"], {
    cwd: pluginRoot(),
    detached: true,
    env,
    stdio: "ignore",
  });
  child.unref();
  await waitFor(config, (candidate) => candidate.running && candidate.version === CURRENT_DAEMON_VERSION);
}

export async function daemonRequest<T>(
  config: LcmConfig,
  method: DaemonRequest["method"],
  params: Record<string, unknown>,
): Promise<T> {
  const token = readToken(config);
  if (!token) throw new Error("agent-lcm daemon authentication token is unavailable.");
  const response = await sendDaemonRequest(ipcAddress(config), {
    version: 1,
    token,
    id: `${process.pid}-${Date.now()}`,
    method,
    params,
  });
  if (!response.ok) throw new Error(response.error);
  return response.result as T;
}

export async function daemonStatus(config: LcmConfig = loadConfig()): Promise<DaemonStatus> {
  try {
    return await daemonRequest<DaemonStatus>(config, "health", {});
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

async function waitForRelease(config: LcmConfig, ownerPid: number | undefined, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = await daemonStatus(config);
    if (status.running && status.pid !== ownerPid) return;
    if (!status.running && !fs.existsSync(daemonLockPath(config))) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for the agent-lcm daemon lock at ${daemonLockPath(config)}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitFor(
  config: LcmConfig,
  predicate: (status: DaemonStatus) => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const status = await daemonStatus(config);
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
