import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
  const socketBefore = process.platform === "win32" ? undefined : fs.statSync(config.socketPath).ino;
  await ensureDaemon(config);
  assert.equal((await daemonStatus(config)).pid, status.pid);
  if (socketBefore !== undefined) assert.equal(fs.statSync(config.socketPath).ino, socketBefore);
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

test("uses a stable private short socket for long Agent LCM homes", async (t) => {
  if (process.platform === "win32") return;
  const longHome = path.join(tempHome("agent-lcm-very-long-home-"), "x".repeat(160));
  const config = loadConfig({ home: longHome });
  const alternate = loadConfig({ home: `${longHome}-other` });
  const address = ipcAddress(config);

  assert.notEqual(address, config.socketPath);
  assert.notEqual(address, ipcAddress(alternate));
  assert.equal(Buffer.byteLength(address, "utf8") <= 100, true);
  assert.match(address, /agent-lcm-\d+\/[0-9a-f]{16}\.sock$/u);

  t.after(() => stopDaemon(config));
  await ensureDaemon(config);
  assert.equal(fs.existsSync(address), true);
  assert.equal(fs.statSync(path.dirname(address)).mode & 0o777, 0o700);
  await stopDaemon(config);
  assert.equal(fs.existsSync(address), false);
  assert.equal(fs.existsSync(path.dirname(address)), true);
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

test("replaces stale pid and version diagnostics after binding", async (t) => {
  const config = loadConfig({ home: tempHome() });
  t.after(() => stopDaemon(config));
  fs.mkdirSync(config.runtimeDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(config.runtimeDir, "daemon.pid"), "99999999\n", { mode: 0o600 });
  fs.writeFileSync(path.join(config.runtimeDir, "daemon.version"), "0.0.0\n", { mode: 0o600 });
  await ensureDaemon(config);

  const status = await daemonStatus(config);
  assert.equal(status.running, true);
  assert.notEqual(status.pid, 99999999);
  assert.equal(status.version, CURRENT_DAEMON_VERSION);
});

test("concurrent subprocess starters recover one stale POSIX socket", {
  skip: process.platform === "win32" ? "Windows named pipes do not leave filesystem socket entries" : false,
}, async (t) => {
  const config = loadConfig({ home: tempHome() });
  t.after(() => stopDaemon(config));
  await seedStaleSocket(config);
  const starters = Array.from({ length: 4 }, () => spawnDaemon(config));

  await waitUntil(async () => (await daemonStatus(config)).running);
  await waitUntil(async () => starters.filter((child) => child.exitCode === null).length === 1);
  const status = await daemonStatus(config);
  const pidOwner = JSON.parse(fs.readFileSync(path.join(config.runtimeDir, "daemon.pid"), "utf8")) as { pid: number };
  assert.equal(pidOwner.pid, status.pid);
  assert.equal(starters.find((child) => child.exitCode === null)?.pid, status.pid);
  assert.equal(fs.existsSync(path.join(config.runtimeDir, "daemon.lock")), false);
  assert.equal(fs.existsSync(path.join(config.runtimeDir, "daemon.lock.recover")), false);
  assertOwnershipBusy(config);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(config.runtimeDir).mode & 0o777, 0o700);
    for (const name of fs.readdirSync(config.runtimeDir).filter((entry) => entry.startsWith("daemon.lock.sqlite"))) {
      assert.equal(fs.statSync(path.join(config.runtimeDir, name)).mode & 0o777, 0o600);
    }
  }
  publishInboxEvent(config, sampleEvent("single writer"));
  await daemonRequest(config, "tool", { name: "lcm_health", arguments: {} });
  assert.equal(readJsonl(config.rawLogPath).length, 1);

  await stopDaemon(config);
  assert.deepEqual(await Promise.all(starters.map((child) => waitForExit(child))), starters.map(() => 0));
});

test("a responsive endpoint is never unlinked and its loser never opens storage", async (t) => {
  const config = loadConfig({ home: tempHome() });
  fs.mkdirSync(config.runtimeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(config.indexPath);
  const token = readOrCreateToken(config);
  const owner = responsiveEndpoint(config, token);
  await listenTestServer(owner, ipcAddress(config));
  t.after(() => closeTestServer(owner));
  const endpointBefore = process.platform === "win32" ? undefined : fs.statSync(config.socketPath).ino;

  const loser = spawnDaemon(config);
  assert.equal(await waitForExit(loser), 0);

  assert.equal(owner.listening, true);
  if (endpointBefore !== undefined) assert.equal(fs.statSync(config.socketPath).ino, endpointBefore);
  assert.equal(fs.statSync(config.indexPath).isDirectory(), true);
  assert.equal(fs.existsSync(config.rawLogPath), false);
  assert.equal(fs.existsSync(path.join(config.runtimeDir, "daemon.pid")), false);
});

test("an ownership loser cannot clean a stale socket or open the main index", {
  skip: process.platform === "win32" ? "Windows named pipes do not leave filesystem socket entries" : false,
}, async (t) => {
  const config = loadConfig({ home: tempHome() });
  const ready = path.join(config.home, "lock-holder.ready");
  const release = path.join(config.home, "lock-holder.release");
  const waitReady = path.join(config.home, "ownership-wait.ready");
  await seedStaleSocket(config);
  fs.mkdirSync(config.indexPath);
  const holder = spawnLockHolder(config, ready, release);
  await waitUntil(async () => fs.existsSync(ready));
  const starter = spawnFinalizeDaemon(config, { lockWaitReady: waitReady });
  t.after(async () => {
    touch(release);
    if (holder.exitCode === null) holder.kill("SIGKILL");
    if (starter.exitCode === null) starter.kill("SIGKILL");
    await stopDaemon(config);
  });

  await waitUntil(async () => fs.existsSync(waitReady));
  assert.equal(starter.exitCode, null);
  assert.equal(fs.statSync(config.indexPath).isDirectory(), true);
  assert.equal(fs.existsSync(config.socketPath), true);
  assert.equal(fs.existsSync(path.join(config.runtimeDir, "daemon.pid")), false);

  fs.rmdirSync(config.indexPath);
  touch(release);
  assert.equal(await waitForExit(holder), 0);
  await waitUntil(async () => (await daemonStatus(config)).running);
  assert.equal((await daemonStatus(config)).pid, starter.pid);
});

test("replacement waits through final drain and storage close", {
  skip: process.platform === "win32" ? "POSIX signals provide the deterministic shutdown boundary" : false,
}, async (t) => {
  const config = loadConfig({ home: tempHome() });
  const closeReady = path.join(config.home, "storage-close.ready");
  const closeRelease = path.join(config.home, "storage-close.release");
  const replacementWait = path.join(config.home, "replacement-wait.ready");
  const old = spawnFinalizeDaemon(config, { closeReady, closeRelease });
  let replacement: ReturnType<typeof spawnDaemon> | undefined;
  let rawLock: DatabaseSync | undefined;
  t.after(async () => {
    touch(closeRelease);
    releaseSqliteLock(rawLock);
    if (old.exitCode === null) old.kill("SIGKILL");
    if (replacement?.exitCode === null) replacement.kill("SIGKILL");
    await stopDaemon(config);
  });
  await waitUntil(async () => (await daemonStatus(config)).running);
  const oldStatus = await daemonStatus(config);
  rawLock = acquireSqliteLock(`${config.rawLogPath}.lock.sqlite`);
  publishInboxEvent(config, sampleEvent("final drain owns the database"));
  process.kill(oldStatus.pid!, "SIGTERM");
  await waitUntil(async () => !(await daemonStatus(config)).running);

  replacement = spawnFinalizeDaemon(config, { lockWaitReady: replacementWait });
  await waitUntil(async () => fs.existsSync(replacementWait));
  assert.equal(replacement.exitCode, null);
  assertOwnershipBusy(config);
  assert.equal(readPid(config), oldStatus.pid);

  releaseSqliteLock(rawLock);
  rawLock = undefined;
  await waitUntil(async () => fs.existsSync(closeReady));
  assert.equal(fs.readdirSync(config.inboxDir).filter((name) => name.endsWith(".json")).length, 0);
  assert.equal(readJsonl(config.rawLogPath).length, 1);
  assert.equal(replacement.exitCode, null);
  assertOwnershipBusy(config);
  assert.equal(readPid(config), oldStatus.pid);

  touch(closeRelease);
  assert.equal(await waitForExit(old), 0);
  await waitUntil(async () => (await daemonStatus(config)).pid === replacement?.pid);
});

test("old owner removes metadata before a replacement can publish its own", {
  skip: process.platform === "win32" ? "POSIX signals provide the deterministic shutdown boundary" : false,
}, async (t) => {
  const config = loadConfig({ home: tempHome() });
  const metadataReady = path.join(config.home, "metadata-unlink.ready");
  const metadataRelease = path.join(config.home, "metadata-unlink.release");
  const replacementWait = path.join(config.home, "replacement-wait.ready");
  const old = spawnFinalizeDaemon(config, { metadataReady, metadataRelease });
  let replacement: ReturnType<typeof spawnDaemon> | undefined;
  t.after(async () => {
    touch(metadataRelease);
    if (old.exitCode === null) old.kill("SIGKILL");
    if (replacement?.exitCode === null) replacement.kill("SIGKILL");
    await stopDaemon(config);
  });
  await waitUntil(async () => (await daemonStatus(config)).running);
  const oldStatus = await daemonStatus(config);
  process.kill(oldStatus.pid!, "SIGTERM");
  await waitUntil(async () => fs.existsSync(metadataReady));

  replacement = spawnFinalizeDaemon(config, { lockWaitReady: replacementWait });
  await waitUntil(async () => fs.existsSync(replacementWait));
  assert.equal(replacement.exitCode, null);
  assertOwnershipBusy(config);
  assert.equal((await daemonStatus(config)).running, false);
  assert.equal(readPid(config), oldStatus.pid);

  touch(metadataRelease);
  assert.equal(await waitForExit(old), 0);
  await waitUntil(async () => (await daemonStatus(config)).pid === replacement?.pid);
  assert.equal(readPid(config), replacement.pid);
});

test("keeps queued data through a killed daemon and drains it after restart", {
  skip: process.platform === "win32" ? "SIGKILL is not portable to Windows" : false,
}, async (t) => {
  const config = loadConfig({ home: tempHome() });
  t.after(() => stopDaemon(config));
  await ensureDaemon(config);
  const status = await daemonStatus(config);
  assert.equal(status.running, true);
  assertOwnershipBusy(config);
  publishInboxEvent(config, sampleEvent("survive crash"));

  process.kill(status.pid!, "SIGKILL");
  await waitUntil(async () => !(await daemonStatus(config)).running);
  await waitUntil(async () => ownershipIsAvailable(config));
  assert.equal(fs.readdirSync(config.inboxDir).filter((name) => name.endsWith(".json")).length, 1);

  await ensureDaemon(config);

  assert.equal(fs.readdirSync(config.inboxDir).filter((name) => name.endsWith(".json")).length, 0);
  assert.equal(readJsonl(config.rawLogPath).length, 1);
  assertOwnershipBusy(config);
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

test("replacement closes an idle client and waits for the old endpoint owner", async (t) => {
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

  publishInboxEvent(config, sampleEvent("one owner"));
  const result = await daemonRequest<{ structuredContent: { health: { event_count: number } } }>(config, "tool", {
    name: "lcm_health",
    arguments: {},
  });

  assert.equal(result.structuredContent.health.event_count, 1);
  assert.equal(readJsonl(config.rawLogPath).length, 1);
});

test("read requests do not create or rebuild the derived store before capture", async (t) => {
  const config = loadConfig({ home: tempHome() });
  t.after(() => stopDaemon(config));
  await ensureDaemon(config);

  await daemonRequest(config, "cli", { command: "stats" });

  assert.equal(fs.existsSync(config.indexPath), false);
  assert.equal(fs.existsSync(config.rawLogPath), false);
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

function spawnLockHolder(config: ReturnType<typeof loadConfig>, ready: string, release: string) {
  return spawn(process.execPath, ["--no-warnings", "tests/daemon-lock-holder.ts"], {
    cwd: path.resolve("."),
    env: { ...process.env, AGENT_LCM_HOME: config.home, AGENT_LCM_TEST_READY: ready, AGENT_LCM_TEST_RELEASE: release },
    stdio: "ignore",
  });
}

function spawnFinalizeDaemon(config: ReturnType<typeof loadConfig>, barriers: {
  closeReady?: string;
  closeRelease?: string;
  metadataReady?: string;
  metadataRelease?: string;
  lockWaitReady?: string;
}) {
  return spawn(process.execPath, ["--no-warnings", "tests/daemon-finalize-starter.ts"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      AGENT_LCM_HOME: config.home,
      AGENT_LCM_TEST_CLOSE_READY: barriers.closeReady,
      AGENT_LCM_TEST_CLOSE_RELEASE: barriers.closeRelease,
      AGENT_LCM_TEST_METADATA_READY: barriers.metadataReady,
      AGENT_LCM_TEST_METADATA_RELEASE: barriers.metadataRelease,
      AGENT_LCM_TEST_LOCK_WAIT_READY: barriers.lockWaitReady,
    },
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

function ownershipPath(config: ReturnType<typeof loadConfig>): string {
  return path.join(config.runtimeDir, "daemon.lock.sqlite");
}

function tryAcquireOwnership(config: ReturnType<typeof loadConfig>): DatabaseSync | undefined {
  const database = new DatabaseSync(ownershipPath(config), { timeout: 0 });
  try {
    database.exec("BEGIN EXCLUSIVE");
    return database;
  } catch (error) {
    database.close();
    if (error instanceof Error && Reflect.get(error, "errcode") === 5) return undefined;
    throw error;
  }
}

function ownershipIsAvailable(config: ReturnType<typeof loadConfig>): boolean {
  const database = tryAcquireOwnership(config);
  if (!database) return false;
  releaseSqliteLock(database);
  return true;
}

function assertOwnershipBusy(config: ReturnType<typeof loadConfig>): void {
  const database = tryAcquireOwnership(config);
  if (!database) return;
  releaseSqliteLock(database);
  assert.fail("daemon ownership database was not locked");
}

function acquireSqliteLock(filePath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(filePath, { timeout: 0 });
  database.exec("BEGIN IMMEDIATE");
  return database;
}

function releaseSqliteLock(database: DatabaseSync | undefined): void {
  if (!database) return;
  database.exec("ROLLBACK");
  database.close();
}

function readPid(config: ReturnType<typeof loadConfig>): number {
  return (JSON.parse(fs.readFileSync(path.join(config.runtimeDir, "daemon.pid"), "utf8")) as { pid: number }).pid;
}

function touch(filePath: string): void {
  fs.writeFileSync(filePath, "ready\n", { mode: 0o600 });
}

async function seedStaleSocket(config: ReturnType<typeof loadConfig>): Promise<void> {
  fs.mkdirSync(config.runtimeDir, { recursive: true, mode: 0o700 });
  const server = net.createServer();
  await listenTestServer(server, config.socketPath);
  const parkedPath = `${config.socketPath}.parked`;
  fs.renameSync(config.socketPath, parkedPath);
  await closeTestServer(server);
  fs.renameSync(parkedPath, config.socketPath);
}

function responsiveEndpoint(config: ReturnType<typeof loadConfig>, token: string): net.Server {
  return net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline)) as { id: string; token: string };
      socket.end(`${JSON.stringify(request.token === token ? {
        version: 1,
        id: request.id,
        ok: true,
        result: { running: true, pid: process.pid, version: CURRENT_DAEMON_VERSION, queue_depth: 0, quarantine_count: 0 },
      } : { version: 1, id: request.id, ok: false, error: "authentication failed" })}\n`);
    });
  });
}

function listenTestServer(server: net.Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, resolve);
  });
}

function closeTestServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
