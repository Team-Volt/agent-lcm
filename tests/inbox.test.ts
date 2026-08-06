import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { loadConfig } from "../src/config.ts";
import { normalizeHookEvent } from "../src/events.ts";
import { drainInbox, publishInboxEvent } from "../src/inbox.ts";
import { tempHome } from "./helpers.ts";

function sampleEvent() {
  return normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: "inbox-session", cwd: "/tmp/inbox", prompt: "queue this" }),
    now: () => new Date("2026-08-06T12:00:00.000Z"),
  });
}

test("publishes a private durable event and drains it in order", () => {
  const config = loadConfig({ home: tempHome() });
  const event = sampleEvent();

  const queued = publishInboxEvent(config, event);

  assert.equal(fs.statSync(queued).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(config.inboxDir).some((name) => name.endsWith(".tmp")), false);
  const seen: string[] = [];
  const report = drainInbox(config, (drained) => {
    seen.push(drained.event_id);
    return "ingested";
  });
  assert.deepEqual(seen, [event.event_id]);
  assert.deepEqual(report, { ingested: 1, duplicates: 0, quarantined: 0 });
  assert.equal(fs.existsSync(queued), false);
});

test("concurrent conflicting publishers quarantine both events without clobbering either", async () => {
  const config = loadConfig({ home: tempHome() });
  const event = sampleEvent();
  await publishConcurrently(config.home, [event, { ...event, raw_input_sha256: "f".repeat(64) }]);

  assert.equal(fs.readdirSync(config.inboxDir).filter((name) => name.endsWith(".json")).length, 0);
  assert.equal(fs.readdirSync(config.quarantineDir).length, 2);
});

test("three conflicting publishers quarantine every payload when the original disappears mid-resolution", async () => {
  const config = loadConfig({ home: tempHome() });
  const event = sampleEvent();
  await publishWithVanishingOriginal(config.home, [
    event,
    { ...event, raw_input_sha256: "f".repeat(64) },
    { ...event, raw_input_sha256: "e".repeat(64) },
  ]);

  assert.equal(fs.readdirSync(config.inboxDir).filter((name) => name.endsWith(".json")).length, 0);
  assert.equal(fs.readdirSync(config.inboxDir).some((name) => name.endsWith(".tmp")), false);
  assert.equal(fs.readdirSync(config.quarantineDir).length, 3);
});

test("quarantines malformed inbox data without blocking a valid sibling", () => {
  const config = loadConfig({ home: tempHome() });
  fs.mkdirSync(config.inboxDir, { recursive: true, mode: 0o700 });
  const secret = "do-not-leak-this-inbox-content";
  fs.writeFileSync(path.join(config.inboxDir, "000-malformed.json"), `{\"secret\":\"${secret}\"`, { mode: 0o600 });
  const event = sampleEvent();
  publishInboxEvent(config, event);
  const seen: string[] = [];

  const report = drainInbox(config, (drained) => {
    seen.push(drained.event_id);
    return "ingested";
  });

  assert.deepEqual(report, { ingested: 1, duplicates: 0, quarantined: 1 });
  assert.deepEqual(seen, [event.event_id]);
  const quarantined = fs.readdirSync(config.quarantineDir);
  assert.deepEqual(quarantined, ["000-malformed.json"]);
  assert.equal(fs.statSync(path.join(config.quarantineDir, quarantined[0]!)).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret, "u"));
});

test("leaves an inbox item in place when ingestion throws", () => {
  const config = loadConfig({ home: tempHome() });
  const queued = publishInboxEvent(config, sampleEvent());

  assert.throws(() => drainInbox(config, () => {
    throw new Error("storage unavailable");
  }), /storage unavailable/u);
  assert.equal(fs.existsSync(queued), true);
});

async function publishConcurrently(home: string, events: ReturnType<typeof sampleEvent>[]): Promise<void> {
  const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  const configUrl = new URL("../src/config.ts", import.meta.url).href;
  const inboxUrl = new URL("../src/inbox.ts", import.meta.url).href;
  const targetPath = path.join(home, "inbox", `${events[0]!.event_id}.json`);
  let ready = 0;
  let release!: () => void;
  const bothReady = new Promise<void>((resolve) => { release = resolve; });
  const completions = events.map((event) => new Promise<void>((resolve, reject) => {
    const worker = new Worker(String.raw`
      const { parentPort, workerData } = require("node:worker_threads");
      const fs = require("node:fs");
      const control = new Int32Array(workerData.control);
      const gate = (original) => (...args) => {
        if (args[1] === workerData.targetPath) {
          parentPort.postMessage("ready");
          while (Atomics.load(control, 1) === 0) Atomics.wait(control, 1, 0);
        }
        return original(...args);
      };
      fs.linkSync = gate(fs.linkSync);
      fs.renameSync = gate(fs.renameSync);
      (async () => {
        const { loadConfig } = await import(workerData.configUrl);
        const { publishInboxEvent } = await import(workerData.inboxUrl);
        publishInboxEvent(loadConfig({ home: workerData.home }), workerData.event);
        parentPort.postMessage("done");
      })().catch((error) => parentPort.postMessage({ error: error.message }));
    `, {
      eval: true,
      workerData: { control: control.buffer, configUrl, inboxUrl, home, event, targetPath },
    });
    worker.on("message", (message: "ready" | "done" | { error: string }) => {
      if (message === "ready") {
        ready += 1;
        if (ready === events.length) release();
        return;
      }
      if (message === "done") resolve();
      else reject(new Error(message.error));
    });
    worker.once("error", reject);
  }));
  await bothReady;
  Atomics.store(control, 1, 1);
  Atomics.notify(control, 1);
  await Promise.all(completions);
}

async function publishWithVanishingOriginal(home: string, events: ReturnType<typeof sampleEvent>[]): Promise<void> {
  const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  const configUrl = new URL("../src/config.ts", import.meta.url).href;
  const inboxUrl = new URL("../src/inbox.ts", import.meta.url).href;
  const targetPath = path.join(home, "inbox", `${events[0]!.event_id}.json`);
  const roles = ["winner", "first", "second"];
  await Promise.all(events.map((event, index) => new Promise<void>((resolve, reject) => {
    const worker = new Worker(String.raw`
      const { parentPort, workerData } = require("node:worker_threads");
      const fs = require("node:fs");
      const control = new Int32Array(workerData.control);
      const originalLink = fs.linkSync;
      const originalRead = fs.readFileSync;
      const originalUnlink = fs.unlinkSync;
      fs.linkSync = (...args) => {
        if (args[1] === workerData.targetPath) {
          if (workerData.role === "winner") {
            const result = originalLink(...args);
            Atomics.store(control, 0, 1);
            Atomics.notify(control, 0);
            return result;
          }
          while (Atomics.load(control, 0) === 0) Atomics.wait(control, 0, 0);
        }
        return originalLink(...args);
      };
      fs.readFileSync = (...args) => {
        if (workerData.role === "second" && args[0] === workerData.targetPath) {
          while (Atomics.load(control, 1) === 0) Atomics.wait(control, 1, 0);
        }
        return originalRead(...args);
      };
      fs.unlinkSync = (...args) => {
        const result = originalUnlink(...args);
        if (workerData.role === "first" && args[0] === workerData.targetPath) {
          Atomics.store(control, 1, 1);
          Atomics.notify(control, 1);
        }
        return result;
      };
      (async () => {
        const { loadConfig } = await import(workerData.configUrl);
        const { publishInboxEvent } = await import(workerData.inboxUrl);
        publishInboxEvent(loadConfig({ home: workerData.home }), workerData.event);
        parentPort.postMessage("done");
      })().catch((error) => parentPort.postMessage({ error: error.message }));
    `, {
      eval: true,
      workerData: { control: control.buffer, configUrl, inboxUrl, home, event, targetPath, role: roles[index] },
    });
    worker.on("message", (message: "done" | { error: string }) => {
      if (message === "done") resolve();
      else reject(new Error(message.error));
    });
    worker.once("error", reject);
  })));
}
