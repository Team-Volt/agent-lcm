import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.ts";
import { CURRENT_DAEMON_VERSION } from "../src/daemon.ts";
import { daemonRequest, daemonStatus, ensureDaemon, stopDaemon } from "../src/daemon-client.ts";
import { normalizeHookEvent } from "../src/events.ts";
import { publishInboxEvent } from "../src/inbox.ts";
import { ipcAddress, readOrCreateToken } from "../src/ipc.ts";
import { createStorage } from "../src/storage.ts";
import { rawRequest, readJsonl, tempHome } from "./helpers.ts";

function sampleEvent(prompt = "queue this") {
  return normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: "daemon-session", cwd: "/tmp/daemon", prompt }),
    now: () => new Date("2026-08-06T12:00:00.000Z"),
  });
}

test("independent starters converge on one authenticated daemon", async (t) => {
  const config = loadConfig({ home: tempHome() });
  t.after(() => stopDaemon(config));
  const starters = [spawnDaemon(config), spawnDaemon(config)];

  await waitUntil(async () => (await daemonStatus(config)).running);
  const status = await daemonStatus(config);
  assert.equal(starters.some((child) => child.pid === status.pid), true);
  const loser = starters.find((child) => child.pid !== status.pid)!;
  assert.equal(await waitForExit(loser), 0);
  const lockBefore = fs.readFileSync(path.join(config.runtimeDir, "daemon.lock"), "utf8");
  await ensureDaemon(config);
  assert.equal((await daemonStatus(config)).pid, status.pid);
  assert.equal(fs.readFileSync(path.join(config.runtimeDir, "daemon.lock"), "utf8"), lockBefore);
  assert.match(fs.readFileSync(config.tokenPath, "utf8").trim(), /^[0-9a-f]{64}$/u);
});

test("reuses one daemon and rejects authentication without touching queued or stored data", async (t) => {
  const config = loadConfig({ home: tempHome() });
  t.after(() => stopDaemon(config));

  await Promise.all([ensureDaemon(config), ensureDaemon(config)]);
  const firstStatus = await daemonStatus(config);
  await ensureDaemon(config);
  const secondStatus = await daemonStatus(config);

  assert.equal(firstStatus.running, true);
  assert.equal(secondStatus.pid, firstStatus.pid);
  assert.equal(firstStatus.version, CURRENT_DAEMON_VERSION);
  if (process.platform !== "win32") {
    assert.equal(config.socketPath, path.join(config.runtimeDir, "daemon.sock"));
    assert.equal(fs.statSync(config.tokenPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(config.runtimeDir, "daemon.pid")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(config.runtimeDir, "daemon.version")).mode & 0o777, 0o600);
  }
  const queued = publishInboxEvent(config, sampleEvent("auth must not drain"));
  await assert.rejects(
    rawRequest(ipcAddress(config), { version: 1, token: "wrong", id: "x", method: "health", params: {} }),
    /authentication failed/u,
  );
  assert.equal(fs.existsSync(queued), true);
  assert.equal(fs.existsSync(config.rawLogPath), false);
  const readOnly = createStorage({ config, readOnly: true });
  try {
    assert.equal(readOnly.health().event_count, 0);
  } finally {
    readOnly.close();
  }

  await stopDaemon(config);
  assert.equal((await daemonStatus(config)).running, false);
});

test("publishes a complete token atomically", () => {
  const config = loadConfig({ home: tempHome() });
  const originalWrite = fs.writeFileSync;
  let checked = false;
  fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: unknown) => {
    if (typeof file === "number" && typeof data === "string" && /^[0-9a-f]{64}\n$/u.test(data)) {
      checked = true;
      assert.equal(fs.existsSync(config.tokenPath), false);
    }
    return Reflect.apply(originalWrite, fs, [file, data, options]);
  }) as typeof fs.writeFileSync;
  try {
    assert.match(readOrCreateToken(config), /^[0-9a-f]{64}$/u);
  } finally {
    fs.writeFileSync = originalWrite;
  }
  assert.equal(checked, true);
});

test("recovers stale pid, version, and socket metadata", async (t) => {
  const config = loadConfig({ home: tempHome() });
  t.after(() => stopDaemon(config));
  fs.mkdirSync(config.runtimeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(config.runtimeDir, "daemon.pid"), "99999999\n", { mode: 0o600 });
  fs.writeFileSync(path.join(config.runtimeDir, "daemon.version"), "0.0.0\n", { mode: 0o600 });
  if (process.platform !== "win32") fs.writeFileSync(config.socketPath, "stale", { mode: 0o600 });

  await ensureDaemon(config);

  const status = await daemonStatus(config);
  assert.equal(status.running, true);
  assert.notEqual(status.pid, 99999999);
  assert.equal(status.version, CURRENT_DAEMON_VERSION);
});

test("recovers a stale daemon lock owned by a live unrelated PID", async (t) => {
  const config = loadConfig({ home: tempHome() });
  t.after(() => stopDaemon(config));
  fs.mkdirSync(config.runtimeDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(config.runtimeDir, "daemon.lock");
  fs.writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    nonce: "stale-live-unrelated-owner",
    process_identity: testProcessIdentity(process.pid),
    created_at: "2026-08-06T00:00:00.000Z",
  })}\n`, { mode: 0o600 });
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, stale, stale);

  await ensureDaemon(config);

  const status = await daemonStatus(config);
  assert.equal(status.running, true);
  assert.notEqual(status.pid, process.pid);
});

test("concurrent subprocess starters recover one stale lock without unlinking the winner", async (t) => {
  const config = loadConfig({ home: tempHome() });
  t.after(() => stopDaemon(config));
  fs.mkdirSync(config.runtimeDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(config.runtimeDir, "daemon.lock");
  fs.writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    nonce: "stale-concurrent-owner",
    process_identity: testProcessIdentity(process.pid),
    created_at: "2026-08-06T00:00:00.000Z",
  })}\n`, { mode: 0o600 });
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, stale, stale);
  const starters = Array.from({ length: 4 }, () => spawnStaleRaceDaemon(config));

  await waitUntil(async () => (await daemonStatus(config)).running);
  await waitUntil(async () => starters.filter((child) => child.exitCode === null).length === 1);
  const status = await daemonStatus(config);
  const lockOwner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid: number; nonce: string };
  const pidOwner = JSON.parse(fs.readFileSync(path.join(config.runtimeDir, "daemon.pid"), "utf8")) as { pid: number; nonce: string };
  assert.equal(lockOwner.pid, status.pid);
  assert.equal(lockOwner.nonce, pidOwner.nonce);
  assert.equal(starters.find((child) => child.exitCode === null)?.pid, status.pid);
  await daemonRequest(config, "tool", {
    name: "lcm_record_note",
    arguments: { sessionId: "codex:stale-race", cwd: "/tmp/stale-race", text: "single writer" },
  });
  assert.equal(readJsonl(config.rawLogPath).length, 1);

  await stopDaemon(config);
  assert.deepEqual(await Promise.all(starters.map((child) => waitForExit(child))), starters.map(() => 0));
});

test("removes an abandoned recovery claim before recovering its stale lock", async (t) => {
  const config = loadConfig({ home: tempHome() });
  t.after(() => stopDaemon(config));
  fs.mkdirSync(config.runtimeDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(config.runtimeDir, "daemon.lock");
  const claimPath = path.join(config.runtimeDir, "daemon.lock.recover");
  fs.writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    nonce: "abandoned-recovery-owner",
    process_identity: testProcessIdentity(process.pid),
    created_at: "2026-08-06T00:00:00.000Z",
  })}\n`, { mode: 0o600 });
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, stale, stale);
  fs.linkSync(lockPath, claimPath);
  await new Promise((resolve) => setTimeout(resolve, 2_100));

  await ensureDaemon(config);

  const status = await daemonStatus(config);
  assert.equal(status.running, true);
  assert.equal(fs.existsSync(claimPath), false);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, status.pid);
});

test("keeps queued data through a killed daemon and drains it after restart", {
  skip: process.platform === "win32" ? "SIGKILL is not portable to Windows" : false,
}, async (t) => {
  const config = loadConfig({ home: tempHome() });
  t.after(() => stopDaemon(config));
  await ensureDaemon(config);
  const status = await daemonStatus(config);
  assert.equal(status.running, true);
  publishInboxEvent(config, sampleEvent("survive crash"));

  process.kill(status.pid!, "SIGKILL");
  await waitUntil(async () => !(await daemonStatus(config)).running);
  assert.equal(fs.readdirSync(config.inboxDir).filter((name) => name.endsWith(".json")).length, 1);

  await ensureDaemon(config);

  assert.equal(fs.readdirSync(config.inboxDir).filter((name) => name.endsWith(".json")).length, 0);
  assert.equal(readJsonl(config.rawLogPath).length, 1);
});

test("drains queued data on clean shutdown", async () => {
  const config = loadConfig({ home: tempHome() });
  await ensureDaemon(config);
  publishInboxEvent(config, sampleEvent("drain on stop"));

  await stopDaemon(config);

  assert.equal((await daemonStatus(config)).running, false);
  assert.equal(fs.readdirSync(config.inboxDir).filter((name) => name.endsWith(".json")).length, 0);
  assert.equal(readJsonl(config.rawLogPath).length, 1);
});

test("drains then replaces an older daemon version", async (t) => {
  const config = loadConfig({ home: tempHome() });
  t.after(() => stopDaemon(config));
  const child = spawn(process.execPath, ["--no-warnings", "bin/agent-lcm", "daemon", "run"], {
    cwd: path.resolve("."),
    detached: true,
    env: { ...process.env, AGENT_LCM_HOME: config.home, AGENT_LCM_DAEMON_VERSION: "0.0.0" },
    stdio: "ignore",
  });
  child.unref();
  await waitUntil(async () => (await daemonStatus(config)).version === "0.0.0");
  const oldStatus = await daemonStatus(config);
  publishInboxEvent(config, sampleEvent("drain before replace"));

  await ensureDaemon(config);

  const status = await daemonStatus(config);
  assert.equal(status.running, true);
  assert.equal(status.version, CURRENT_DAEMON_VERSION);
  assert.notEqual(status.pid, oldStatus.pid);
  assert.equal(readJsonl(config.rawLogPath).length, 1);
});

test("replacement closes an idle client and waits for the old lock owner", async (t) => {
  const config = loadConfig({ home: tempHome() });
  t.after(() => stopDaemon(config));
  const old = spawnDaemon(config, "0.0.0");
  await waitUntil(async () => (await daemonStatus(config)).version === "0.0.0");
  const oldStatus = await daemonStatus(config);
  assert.equal(oldStatus.pid, old.pid);
  const idle = net.createConnection(ipcAddress(config));
  t.after(() => idle.destroy());
  await new Promise<void>((resolve, reject) => {
    idle.once("connect", resolve);
    idle.once("error", reject);
  });

  await ensureDaemon(config);

  const status = await daemonStatus(config);
  assert.equal(status.running, true);
  assert.equal(status.version, CURRENT_DAEMON_VERSION);
  assert.notEqual(status.pid, oldStatus.pid);
  assert.equal(await waitForExit(old), 0);
});

test("daemon tool requests use the daemon storage", async (t) => {
  const config = loadConfig({ home: tempHome() });
  t.after(() => stopDaemon(config));
  await ensureDaemon(config);

  await daemonRequest(config, "tool", {
    name: "lcm_record_note",
    arguments: { sessionId: "codex:daemon-tool", cwd: "/tmp/daemon-tool", text: "one owner" },
  });
  const result = await daemonRequest<{ structuredContent: { health: { event_count: number } } }>(config, "tool", {
    name: "lcm_health",
    arguments: {},
  });

  assert.equal(result.structuredContent.health.event_count, 1);
  assert.equal(readJsonl(config.rawLogPath).length, 1);
});

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for daemon state.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function spawnDaemon(config: ReturnType<typeof loadConfig>, version?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_LCM_HOME: config.home };
  if (version) env.AGENT_LCM_DAEMON_VERSION = version;
  return spawn(process.execPath, ["--no-warnings", "bin/agent-lcm", "daemon", "run"], {
    cwd: path.resolve("."),
    env,
    stdio: "ignore",
  });
}

function spawnStaleRaceDaemon(config: ReturnType<typeof loadConfig>) {
  return spawn(process.execPath, ["--no-warnings", "tests/daemon-stale-race-starter.ts"], {
    cwd: path.resolve("."),
    env: { ...process.env, AGENT_LCM_HOME: config.home },
    stdio: "ignore",
  });
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 5_000): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for daemon starter ${child.pid} to exit.`)), timeoutMs);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

function testProcessIdentity(pid: number): string {
  if (process.platform === "win32") {
    return execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`,
    ], { encoding: "utf8" }).trim();
  }
  return execFileSync("ps", ["-o", "lstart=", "-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
}
