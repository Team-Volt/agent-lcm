import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.ts";
import { CURRENT_DAEMON_VERSION } from "../src/daemon.ts";
import { daemonStatus, ensureDaemon, stopDaemon } from "../src/daemon-client.ts";
import { normalizeHookEvent } from "../src/events.ts";
import { publishInboxEvent } from "../src/inbox.ts";
import { rawRequest, readJsonl, tempHome } from "./helpers.ts";

function sampleEvent(prompt = "queue this") {
  return normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: "daemon-session", cwd: "/tmp/daemon", prompt }),
    now: () => new Date("2026-08-06T12:00:00.000Z"),
  });
}

test("starts one authenticated daemon and reuses it", async (t) => {
  const config = loadConfig({ home: tempHome() });
  t.after(() => stopDaemon(config));

  await Promise.all([ensureDaemon(config), ensureDaemon(config)]);
  const firstStatus = await daemonStatus(config);
  await ensureDaemon(config);
  const secondStatus = await daemonStatus(config);

  assert.equal(firstStatus.running, true);
  assert.equal(secondStatus.pid, firstStatus.pid);
  assert.equal(firstStatus.version, CURRENT_DAEMON_VERSION);
  assert.equal(config.socketPath, path.join(config.runtimeDir, "daemon.sock"));
  assert.equal(fs.statSync(config.tokenPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(config.runtimeDir, "daemon.pid")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(config.runtimeDir, "daemon.version")).mode & 0o777, 0o600);
  await assert.rejects(
    rawRequest(config.socketPath, { version: 1, token: "wrong", id: "x", method: "health", params: {} }),
    /authentication failed/u,
  );

  await stopDaemon(config);
  assert.equal((await daemonStatus(config)).running, false);
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

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for daemon state.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
