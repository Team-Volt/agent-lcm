import assert from "node:assert/strict";
import test from "node:test";

import { decodePersistedEvent, parsePersistedEvent, PersistedEventError } from "../src/event-codec.ts";

const serializedEvent = JSON.stringify({
  schema_version: 1,
  event_id: "event-1",
  timestamp: "2026-07-27T12:00:00.000Z",
  hook_event: "UserPromptSubmit",
  session_id: "session-1",
  cwd: "/tmp/project",
  payload: { prompt: "remember this" },
  redactions: [],
  truncations: [],
  raw_input_sha256: "abc123",
  original_bytes: 13,
  sanitized_bytes: 13,
});

test("parses a complete persisted event", () => {
  const event = parsePersistedEvent(serializedEvent);

  assert.equal(event?.event_id, "event-1");
  assert.deepEqual(event?.payload, { prompt: "remember this" });
});

test("rejects malformed or structurally invalid persisted events", () => {
  assert.equal(parsePersistedEvent("{not-json"), undefined);
  assert.equal(parsePersistedEvent(JSON.stringify({ event_id: "event-1" })), undefined);
  assert.throws(
    () => decodePersistedEvent(JSON.stringify({ event_id: "event-1" })),
    PersistedEventError,
  );
});
