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

test("auto capture separates VS Code and Copilot payloads", () => {
  const vscode = mapHarnessEvent("auto", undefined, readFixture("vscode"));
  const copilot = mapHarnessEvent("auto", undefined, readFixture("copilot"));

  assert.equal(vscode.harness, "vscode");
  assert.equal(copilot.harness, "copilot");
});

test("auto capture uses the documented VS Code payload spelling", () => {
  const event = mapHarnessEvent("auto", "UserPromptSubmit", {
    session_id: "vscode-plugin-format",
    cwd: "/tmp/vscode-copilot-format",
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

test("auto capture rejects mixed harness markers and event casing", () => {
  assert.throws(
    () => mapHarnessEvent("auto", "UserPromptSubmit", { session_id: "vscode", sessionId: "copilot" }),
    /Unable to determine harness/u,
  );
  assert.throws(
    () => mapHarnessEvent("auto", "userPromptSubmitted", { session_id: "vscode" }),
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
