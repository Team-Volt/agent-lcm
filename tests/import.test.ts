import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.ts";
import { ensureDaemon, stopDaemon } from "../src/daemon-client.ts";
import { normalizeHookEvent } from "../src/events.ts";
import { importSessions, type ImportOptions } from "../src/import.ts";
import { publishInboxEvent } from "../src/inbox.ts";
import { assertCliOk, readJsonl, runCli, tempHome } from "./helpers.ts";

const fixtures = (name: string) => path.resolve("tests/fixtures", name);

test("imports supported exported sessions idempotently without changing sources", async (t) => {
  const config = loadConfig({ home: tempHome("agent-lcm-import-sources-") });
  t.after(() => stopDaemon(config));
  await ensureDaemon(config);
  const sources: Array<{ options: ImportOptions; paths: string[] }> = [
    { options: { harness: "codex", paths: [fixtures("import/codex")], config }, paths: [fixtures("import/codex/session.jsonl")] },
    { options: { harness: "copilot", paths: [fixtures("import/copilot")], config }, paths: [fixtures("import/copilot/events.jsonl")] },
    { options: { harness: "kiro", paths: [fixtures("import/kiro")], config }, paths: [fixtures("import/kiro/session.jsonl"), fixtures("import/kiro/session.json")] },
    { options: { harness: "vscode", paths: [fixtures("import/vscode/chat.json")], config }, paths: [fixtures("import/vscode/chat.json")] },
    { options: { harness: "cursor", paths: [fixtures("import/cursor/chat.md")], config }, paths: [fixtures("import/cursor/chat.md")] },
  ];

  for (const source of sources) {
    const before = source.paths.map((file) => fs.readFileSync(file));
    const first = await importSessions(source.options);
    const second = await importSessions(source.options);
    assert.ok(first.events_imported > 0, source.options.harness);
    assert.deepEqual(Object.keys(first).sort(), ["events_imported", "events_skipped_duplicate", "failures", "needs_export", "records_rejected", "sessions_imported", "sessions_scanned"]);
    assert.equal(second.events_imported, 0, source.options.harness);
    assert.equal(second.events_skipped_duplicate, first.events_imported, source.options.harness);
    assert.deepEqual(source.paths.map((file) => fs.readFileSync(file)), before, source.options.harness);
  }

  const events = readJsonl(config.rawLogPath) as Array<{ session_id: string; event_id: string }>;
  assert.ok(events.length > 0);
  assert.ok(events.every((event) => /^(codex|copilot|kiro|vscode|cursor):/u.test(event.session_id)));
  assert.equal(new Set(events.map((event) => event.event_id)).size, events.length);
});

test("keeps valid sessions when one source file is malformed", async (t) => {
  const source = tempHome("agent-lcm-import-partial-");
  const malformed = path.join(source, "bad", "events.jsonl");
  fs.mkdirSync(path.dirname(malformed), { recursive: true });
  fs.mkdirSync(path.join(source, "valid"), { recursive: true });
  fs.writeFileSync(malformed, `{bad json}\n${fs.readFileSync(fixtures("import/copilot/events.jsonl"), "utf8")}`);
  fs.copyFileSync(fixtures("import/copilot/events.jsonl"), path.join(source, "valid", "events.jsonl"));
  const config = loadConfig({ home: tempHome("agent-lcm-import-partial-home-") });
  t.after(() => stopDaemon(config));
  await ensureDaemon(config);

  const report = await importSessions({ harness: "copilot", paths: [source], config });

  assert.ok(report.events_imported > 0);
  assert.equal(report.failures.length, 1);
  assert.equal(report.records_rejected, 1);
  assert.equal(report.failures[0]?.source, malformed);
});

test("all discovers local Codex, Copilot, and Kiro homes", async (t) => {
  const root = tempHome("agent-lcm-import-homes-");
  const codex = path.join(root, "codex");
  const copilot = path.join(root, "copilot");
  const kiro = path.join(root, "kiro");
  fs.mkdirSync(path.join(codex, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(copilot, "session-state", "one"), { recursive: true });
  fs.mkdirSync(path.join(kiro, "sessions", "cli"), { recursive: true });
  fs.copyFileSync(fixtures("import/codex/session.jsonl"), path.join(codex, "sessions", "session.jsonl"));
  fs.copyFileSync(fixtures("import/copilot/events.jsonl"), path.join(copilot, "session-state", "one", "events.jsonl"));
  fs.copyFileSync(fixtures("import/kiro/session.jsonl"), path.join(kiro, "sessions", "cli", "session.jsonl"));
  const config = loadConfig({ home: tempHome("agent-lcm-import-all-home-") });
  t.after(() => stopDaemon(config));
  await ensureDaemon(config);

  const report = await importSessions({ all: true, config, paths: [root] });

  assert.ok(report.events_imported >= 3);
  assert.deepEqual(report.needs_export, ["vscode", "cursor"]);
});

test("imports VS Code OTLP debug exports and Kiro ACP session events", async (t) => {
  const config = loadConfig({ home: tempHome("agent-lcm-import-debug-home-") });
  t.after(() => stopDaemon(config));
  await ensureDaemon(config);

  const vscode = await importSessions({ harness: "vscode", paths: [fixtures("import/vscode/otlp.json")], config });
  const kiro = await importSessions({ harness: "kiro", paths: [fixtures("import/kiro/session.jsonl")], config });

  assert.equal(vscode.events_imported, 3);
  assert.equal(kiro.events_imported, 3);
});

test("CLI imports one selected harness", () => {
  const home = tempHome("agent-lcm-import-cli-");
  const result = runCli(["import", "--harness", "copilot", fixtures("import/copilot"), "--json"], {
    env: { AGENT_LCM_HOME: home },
  });

  assertCliOk(result);
  assert.equal(JSON.parse(result.stdout).events_imported, 2);
});

test("reports only this import when draining a shared inbox", async (t) => {
  const config = loadConfig({ home: tempHome("agent-lcm-import-shared-inbox-") });
  t.after(() => stopDaemon(config));
  await ensureDaemon(config);
  publishInboxEvent(config, normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: "other", cwd: "/tmp/other", prompt: "other queued event" }),
    env: {},
  }));

  const report = await importSessions({ harness: "copilot", paths: [fixtures("import/copilot")], config });

  assert.equal(report.events_imported, 2);
  assert.equal(report.events_skipped_duplicate, 0);
  assert.equal(readJsonl(config.rawLogPath).length, 3);
});

test("CLI requires exactly one import selector", () => {
  const result = runCli(["import", "--all", "--harness", "copilot", "--json"], {
    env: { AGENT_LCM_HOME: tempHome("agent-lcm-import-cli-selector-") },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /exactly one/u);
});
