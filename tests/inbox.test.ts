import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

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

test("discards a matching duplicate and quarantines a conflicting publication", () => {
  const config = loadConfig({ home: tempHome() });
  const event = sampleEvent();
  const queued = publishInboxEvent(config, event);

  assert.equal(publishInboxEvent(config, event), queued);
  assert.equal(fs.readdirSync(config.inboxDir).filter((name) => name.endsWith(".json")).length, 1);
  publishInboxEvent(config, { ...event, raw_input_sha256: "f".repeat(64) });

  assert.equal(fs.readdirSync(config.inboxDir).filter((name) => name.endsWith(".json")).length, 0);
  assert.equal(fs.readdirSync(config.quarantineDir).length, 2);
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
