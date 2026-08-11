import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { loadConfig } from "../src/config.ts";
import { ensureDaemon, stopDaemon } from "../src/daemon-client.ts";
import { normalizeHookEvent } from "../src/events.ts";
import { importSessions, type ImportOptions, type ImportProgress } from "../src/import.ts";
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

test("imports Codex rollouts whose filename ends with the session UUID", async (t) => {
  const config = loadConfig({ home: tempHome("agent-lcm-import-codex-rollout-") });
  t.after(() => stopDaemon(config));
  await ensureDaemon(config);

  const report = await importSessions({
    harness: "codex",
    paths: [fixtures("import/codex/rollout-2026-08-01T10-00-00-12345678-1234-4234-8234-123456789abc.jsonl")],
    config,
  });

  assert.equal(report.sessions_imported, 1);
  assert.ok(report.events_imported > 0);
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
  fs.copyFileSync(
    fixtures("import/codex/rollout-2026-08-01T10-00-00-12345678-1234-4234-8234-123456789abc.jsonl"),
    path.join(codex, "sessions", "rollout-2026-08-01T10-00-00-12345678-1234-4234-8234-123456789abc.jsonl"),
  );
  fs.copyFileSync(fixtures("import/copilot/events.jsonl"), path.join(copilot, "session-state", "one", "events.jsonl"));
  fs.copyFileSync(fixtures("import/kiro/session.jsonl"), path.join(kiro, "sessions", "cli", "session.jsonl"));
  const config = loadConfig({ home: tempHome("agent-lcm-import-all-home-") });
  t.after(() => stopDaemon(config));
  await ensureDaemon(config);
  const progress: ImportProgress[] = [];

  const report = await importSessions({ all: true, config, paths: [root], onProgress: (event) => progress.push(event) });

  assert.ok(report.events_imported >= 3);
  assert.deepEqual(report.needs_export, ["vscode", "cursor"]);
  assert.deepEqual(progress[0], {
    phase: "scan",
    totalSessions: 3,
    harnesses: [
      { harness: "codex", sessions: 1 },
      { harness: "copilot", sessions: 1 },
      { harness: "kiro", sessions: 1 },
    ],
  });
  assert.deepEqual(
    progress.flatMap((event) => event.phase === "harness_start" || event.phase === "harness_complete"
      ? [`${event.harness}:${event.phase}:${event.sessionsCompleted}/${event.sessionsTotal}`]
      : []),
    [
      "codex:harness_start:0/1",
      "codex:harness_complete:1/1",
      "copilot:harness_start:0/1",
      "copilot:harness_complete:1/1",
      "kiro:harness_start:0/1",
      "kiro:harness_complete:1/1",
    ],
  );
  assert.deepEqual(
    progress.flatMap((event) => event.phase === "session" ? [event.sessionsCompletedTotal] : []),
    [1, 2, 3],
  );
  const cli = runCli(["import", "--all", root, "--dry-run", "--json"], {
    env: { AGENT_LCM_HOME: tempHome("agent-lcm-import-all-cli-home-") },
  });
  assertCliOk(cli);
  assert.equal(JSON.parse(cli.stdout).sessions_scanned, 3);
  assert.match(cli.stderr, /3 sessions across 3 harnesses/u);
});

test("Copilot default import honors COPILOT_HOME", () => {
  const userHome = tempHome("agent-lcm-import-copilot-user-");
  const copilotHome = tempHome("agent-lcm-import-copilot-home-");
  const session = path.join(copilotHome, "session-state", "one");
  fs.mkdirSync(session, { recursive: true });
  fs.copyFileSync(fixtures("import/copilot/events.jsonl"), path.join(session, "events.jsonl"));
  const result = runCli(["import", "--harness", "copilot", "--dry-run", "--json"], {
    env: { HOME: userHome, USERPROFILE: userHome, COPILOT_HOME: copilotHome },
  });
  assertCliOk(result);
  assert.equal(JSON.parse(result.stdout).sessions_scanned, 1);
});

test("Kiro default import honors KIRO_HOME", () => {
  const userHome = tempHome("agent-lcm-import-kiro-user-");
  const kiroHome = tempHome("agent-lcm-import-kiro-home-");
  const sessions = path.join(kiroHome, "sessions", "cli");
  fs.mkdirSync(sessions, { recursive: true });
  fs.copyFileSync(fixtures("import/kiro/session.jsonl"), path.join(sessions, "session.jsonl"));
  const result = runCli(["import", "--harness", "kiro", "--dry-run", "--json"], {
    env: { HOME: userHome, USERPROFILE: userHome, KIRO_HOME: kiroHome },
  });
  assertCliOk(result);
  assert.equal(JSON.parse(result.stdout).sessions_scanned, 1);
});

test("dry-run progress reports zero discovered sessions without starting the daemon", async () => {
  const progress: ImportProgress[] = [];
  const config = loadConfig({ home: tempHome("agent-lcm-import-empty-progress-") });

  const report = await importSessions({
    harness: "copilot",
    paths: [path.join(config.home, "missing")],
    config,
    dryRun: true,
    onProgress: (event) => progress.push(event),
  });

  assert.equal(report.sessions_scanned, 0);
  assert.equal(report.failures.length, 1);
  assert.deepEqual(progress.map((event) => event.phase), ["scan", "harness_start", "harness_complete"]);
  assert.equal(progress.every((event) => event.phase === "scan" || event.sessionsTotal === 0), true);
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

test("CLI reports progress while importing without corrupting JSON stdout", () => {
  const home = tempHome("agent-lcm-import-cli-progress-");
  const result = runCli(["import", "--harness", "copilot", fixtures("import/copilot"), "--json"], {
    env: { AGENT_LCM_HOME: home },
  });

  assertCliOk(result);
  assert.equal(JSON.parse(result.stdout).events_imported, 2);
  assert.match(result.stderr, /agent-lcm import: 1 session across 1 harness/u);
  assert.match(result.stderr, /copilot.*sessions 1\/1/u);
  assert.match(result.stderr, /elapsed=/u);
  assert.match(result.stderr, /imported=2/u);
});

test("bulk import bypasses per-event inbox publication and remains idempotent", async (t) => {
  const source = path.join(tempHome("agent-lcm-import-bulk-source-"), "session.jsonl");
  writeCodexSession(source, "bulk-import", 2_000, "user");
  const before = fs.readFileSync(source);
  const config = loadConfig({ home: tempHome("agent-lcm-import-bulk-home-") });
  t.after(() => stopDaemon(config));
  const originalLinkSync = fs.linkSync;
  let inboxPublications = 0;
  fs.linkSync = ((existingPath: fs.PathLike, newPath: fs.PathLike) => {
    if (path.dirname(String(newPath)) === config.inboxDir) inboxPublications += 1;
    return originalLinkSync(existingPath, newPath);
  }) as typeof fs.linkSync;

  try {
    const first = await importSessions({ harness: "codex", paths: [source], config });
    const second = await importSessions({ harness: "codex", paths: [source], config });

    assert.equal(first.events_imported, 2_001);
    assert.equal(second.events_imported, 0);
    assert.equal(second.events_skipped_duplicate, first.events_imported);
    assert.equal(inboxPublications, 0);
    const stored = readJsonl(config.rawLogPath) as Array<{ event_id: string }>;
    assert.equal(new Set(stored.map((event) => event.event_id)).size, first.events_imported);
    assert.deepEqual(fs.readFileSync(source), before);
  } finally {
    fs.linkSync = originalLinkSync;
  }
});

test("bulk import rebuilds each touched session summary once", async (t) => {
  const config = loadConfig({ home: tempHome("agent-lcm-import-summary-home-") });
  t.after(() => stopDaemon(config));
  await importSessions({ harness: "codex", paths: [fixtures("import/codex/session.jsonl")], config });
  const audit = new DatabaseSync(config.indexPath);
  try {
    audit.exec(`
      CREATE TABLE import_summary_audit (session_id TEXT NOT NULL);
      CREATE TRIGGER import_summary_insert AFTER INSERT ON session_summaries BEGIN
        INSERT INTO import_summary_audit (session_id) VALUES (NEW.session_id);
      END;
      CREATE TRIGGER import_summary_update AFTER UPDATE ON session_summaries BEGIN
        INSERT INTO import_summary_audit (session_id) VALUES (NEW.session_id);
      END;
    `);
  } finally {
    audit.close();
  }
  const source = path.join(tempHome("agent-lcm-import-summary-source-"), "session.jsonl");
  writeCodexSession(source, "summary-import", 8, "assistant");

  const report = await importSessions({ harness: "codex", paths: [source], config });
  const result = new DatabaseSync(config.indexPath, { readOnly: true });
  try {
    const row = result.prepare("SELECT COUNT(*) AS count FROM import_summary_audit WHERE session_id = ?1").get("codex:summary-import") as { count: number };
    assert.equal(report.events_imported, 9);
    assert.equal(row.count, 1);
  } finally {
    result.close();
  }
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

function writeCodexSession(file: string, sessionId: string, messageCount: number, role: "user" | "assistant"): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const records = [JSON.stringify({
    timestamp: "2026-08-01T10:00:00.000Z",
    type: "session_meta",
    payload: { id: sessionId, cwd: "/tmp/import-bulk" },
  })];
  for (let index = 0; index < messageCount; index += 1) {
    records.push(JSON.stringify({
      timestamp: new Date(Date.UTC(2026, 7, 1, 10, 0, index + 1)).toISOString(),
      type: "response_item",
      payload: {
        type: "message",
        role,
        content: [{ type: role === "user" ? "input_text" : "output_text", text: `bulk import ${index}` }],
      },
    }));
  }
  fs.writeFileSync(file, `${records.join("\n")}\n`);
}
