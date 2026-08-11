import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { mapHarnessEvent } from "../src/harnesses.ts";

const FIXTURES = path.join("tests", "fixtures", "hooks");

test("maps each supported harness into a namespaced sanitized event", () => {
  for (const harness of ["codex", "cursor", "vscode", "copilot", "kiro"] as const) {
    const mapped = mapHarnessEvent(harness, undefined, readFixture(harness));
    assert.equal(mapped.harness, harness);
    assert.match(mapped.session_id, new RegExp(`^${harness}:`, "u"));
    assert.ok(mapped.native_event.length > 0);
    assert.equal(mapped.hook_event, "UserPromptSubmit");
  }
});

test("auto capture separates documented VS Code and Copilot payloads", () => {
  const vscode = mapHarnessEvent("auto", undefined, readFixture("vscode"));
  const copilot = mapHarnessEvent("auto", undefined, readFixture("copilot"));

  assert.equal(vscode.harness, "vscode");
  assert.equal(copilot.harness, "copilot");
});

test("explicit VS Code capture accepts its documented payload spelling", () => {
  const event = mapHarnessEvent("vscode", "UserPromptSubmit", {
    session_id: "vscode-plugin-format",
    cwd: "/tmp/vscode-copilot-format",
  });
  assert.equal(event.harness, "vscode");
  assert.equal(event.hook_event, "UserPromptSubmit");
});

test("Copilot hook arguments supply the event name absent from documented camel-case payloads", () => {
  const event = mapHarnessEvent("auto", "userPromptSubmitted", {
    sessionId: "copilot-without-synthetic-event-field",
    timestamp: 1785578582000,
    cwd: "/tmp/copilot",
    prompt: "documented Copilot payload",
  });
  assert.equal(event.harness, "copilot");
  assert.equal(event.hook_event, "UserPromptSubmit");
});

test("maps the documented Copilot agentStop and VS Code Stop event pair", () => {
  const copilot = mapHarnessEvent("auto", "agentStop", {
    sessionId: "copilot-stop",
    timestamp: 1785578582000,
    cwd: "/tmp/copilot",
    transcriptPath: "/tmp/transcript",
    stopReason: "end_turn",
    stop_hook_active: false,
  });
  const vscode = mapHarnessEvent("vscode", "Stop", {
    hook_event_name: "Stop",
    session_id: "vscode-stop",
    timestamp: "2026-08-01T10:01:00.000Z",
    cwd: "/tmp/vscode",
    transcript_path: "/tmp/transcript",
    stop_reason: "end_turn",
    stop_hook_active: false,
  });
  assert.equal(copilot.hook_event, "Stop");
  assert.equal(vscode.hook_event, "Stop");
});

test("auto capture accepts a lower-camel VS Code compatibility event", () => {
  const event = mapHarnessEvent("auto", "userPromptSubmitted", {
    session_id: "vscode-shared-hook",
    cwd: "/tmp/vscode-shared-hook",
  });
  assert.equal(event.harness, "vscode");
  assert.equal(event.hook_event, "UserPromptSubmit");
});

test("auto capture rejects input without an unambiguous client marker", () => {
  assert.throws(
    () => mapHarnessEvent("auto", "UserPromptSubmit", { conversationId: "ambiguous", cwd: "/tmp/ambiguous" }),
    /Unable to determine harness/u,
  );
});

test("auto capture rejects mixed harness markers and unsupported event casing", () => {
  assert.throws(
    () => mapHarnessEvent("auto", "UserPromptSubmit", { session_id: "vscode", sessionId: "copilot" }),
    /Unable to determine harness/u,
  );
  assert.throws(
    () => mapHarnessEvent("auto", "UserPromptSubmit", { sessionId: "copilot" }),
    /Unable to determine harness/u,
  );
});

test("capture replaces a pre-existing harness namespace instead of nesting it", () => {
  const event = mapHarnessEvent("vscode", "UserPromptSubmit", {
    session_id: "copilot:shared-session",
    cwd: "/tmp/namespaced",
  });
  assert.equal(event.session_id, "vscode:shared-session");
});

test("Cursor maps its documented lower-camel hook names while preserving native provenance", () => {
  const event = mapHarnessEvent("cursor", "beforeSubmitPrompt", {
    session_id: "cursor-native",
    cwd: "/tmp/cursor",
    prompt: "capture me",
  });
  assert.equal(event.hook_event, "UserPromptSubmit");
  assert.equal(event.native_event, "beforeSubmitPrompt");
  assert.equal(event.session_id, "cursor:cursor-native");
});

test("Kiro accepts the former lower-camel event aliases without changing its native event", () => {
  const event = mapHarnessEvent("kiro", "userPromptSubmitted", {
    sessionId: "kiro-legacy",
    cwd: "/tmp/kiro",
  });
  assert.equal(event.hook_event, "UserPromptSubmit");
  assert.equal(event.native_event, "userPromptSubmitted");
});

function readFixture(harness: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, `${harness}.json`), "utf8"));
}
