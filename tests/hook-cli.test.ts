import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertCliOk, clearDerivedSummaries, readJsonl, runCli, tempHome } from "./helpers.ts";
import { normalizeHookEvent } from "../src/events.ts";
import { createStorage } from "../src/storage.ts";

type HookAdditionalContextOutput = {
  readonly hookSpecificOutput: {
    readonly hookEventName: string;
    readonly additionalContext: string;
  };
};

test("hook command publishes a synthetic projectless prompt without opening storage", () => {
  const home = tempHome();
  const result = runCli(["hook", "UserPromptSubmit"], {
    input: JSON.stringify({
      session_id: "hook-session",
      cwd: "/tmp/projectless",
      prompt: "find this later",
    }),
    env: { AGENT_LCM_HOME: home },
  });

  assertCliOk(result);
  const lines = readInboxEvents(home);
  assert.equal(lines.length, 1);
  assert.equal((lines[0] as { session_id: string }).session_id, "codex:hook-session");
  assert.equal(fs.existsSync(path.join(home, "events.jsonl")), false);
  assert.equal(fs.existsSync(path.join(home, "index.sqlite")), false);
});

test("hook command reports inbox fsync failure and publishes on retry", () => {
  // Given: the real hook CLI loads a fault injector that fails inbox fsync.
  const home = tempHome();
  const preloadPath = path.join(tempHome("agent-lcm-fsync-preload-"), "fail-fsync.mjs");
  fs.writeFileSync(
    preloadPath,
    'import fs from "node:fs"; const original = fs.fsyncSync; let calls = 0; fs.fsyncSync = (...args) => { calls += 1; if (calls === 1) throw new Error("forced inbox fsync failure"); return original(...args); };\n',
  );
  const input = JSON.stringify({
    session_id: "hook-fsync-retry",
    cwd: "/tmp/hook-fsync-retry",
    prompt: "persist once after fsync recovers",
  });

  // When: inbox durability fails before the hook can acknowledge the event.
  const blocked = spawnSync(process.execPath, [
    "--no-warnings",
    "--import",
    preloadPath,
    "bin/agent-lcm",
    "hook",
    "UserPromptSubmit",
  ], {
    cwd: path.resolve("."),
    encoding: "utf8",
    input,
    env: { ...process.env, AGENT_LCM_HOME: home },
  });

  // Then: failure is visible and leaves no acknowledged inbox event.
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.match(blocked.stderr, /forced inbox fsync failure/u);
  assert.equal(fs.existsSync(path.join(home, "events.jsonl")), false);
  assert.equal(readInboxEvents(home).length, 0);

  // When: the same hook is retried without the injected failure.
  const retried = runCli(["hook", "UserPromptSubmit"], { input, env: { AGENT_LCM_HOME: home } });

  // Then: exactly one inbox event persists without opening storage.
  assertCliOk(retried);
  assert.equal(readInboxEvents(home).length, 1);
  assert.equal(fs.existsSync(path.join(home, "events.jsonl")), false);
  assert.equal(fs.existsSync(path.join(home, "index.sqlite")), false);
});

test("hook publication creates no raw-log coordinator", () => {
  const home = tempHome();
  const result = runCli(["hook", "UserPromptSubmit"], {
    input: JSON.stringify({ session_id: "inbox-only", cwd: "/tmp/inbox-only", prompt: "publish without a lock" }),
    env: { AGENT_LCM_HOME: home },
  });
  assertCliOk(result);
  assert.equal(readInboxEvents(home).length, 1);
  assert.equal(fs.existsSync(path.join(home, "events.jsonl.lock.sqlite")), false);
});

test("hook command redacts credential URI passwords before inbox publication", () => {
  const home = tempHome();
  const password = "audit-password";
  const result = runCli(["hook", "UserPromptSubmit"], {
    input: JSON.stringify({
      session_id: "credential-uri-session",
      cwd: "/tmp/credential-uri",
      prompt: `connect to redis://:${password}@cache.example.test/0`,
    }),
    env: { AGENT_LCM_HOME: home },
  });

  assertCliOk(result);
  const persisted = JSON.stringify(readInboxEvents(home));
  assert.doesNotMatch(persisted, new RegExp(password, "u"));
  assert.match(persisted, /redis:\/\/:\[REDACTED:secret\]@cache\.example\.test\/0/u);
});

test("cleanup --json treats a fresh home as an empty no-op", () => {
  const home = tempHome();
  const result = runCli(["cleanup", "--json"], {
    env: { AGENT_LCM_HOME: home },
  });

  assertCliOk(result);
  assert.deepEqual(JSON.parse(result.stdout), {
    applied: false,
    raw_log_preserved: true,
    index_path: path.join(home, "index.sqlite"),
    database_bytes_before: 0,
    database_bytes_after: 0,
    event_fts_rows_before: 0,
    event_fts_rows_after: 0,
    projected_event_fts_rows: 0,
    event_text_bytes_before: 0,
    event_text_bytes_after: 0,
    projected_summaries_to_rebuild: 0,
    summaries_rebuilt: 0,
    vacuumed: false,
  });
});

test("CLI rejects missing and invalid option values", () => {
  const cases = [
    { args: ["import-codex-sessions", "--from"], flag: "--from" },
    { args: ["import-codex-sessions", "--batch-size", "nope"], flag: "--batch-size" },
    { args: ["sessions", "--limit", "0"], flag: "--limit" },
    { args: ["status", "--codex-home", "--json"], flag: "--codex-home" },
  ];

  for (const { args, flag } of cases) {
    const result = runCli(args, { env: { AGENT_LCM_HOME: tempHome() } });
    assert.equal(result.status, 1, `${args.join(" ")} unexpectedly succeeded`);
    assert.match(result.stderr, new RegExp(flag, "u"));
  }
});

test("hook command stores a sanitized overflow reference for oversized valid input", () => {
  const home = tempHome();
  const secret = "sk-test-overflow-secret-1234567890";
  const result = runCli(["hook", "UserPromptSubmit"], {
    input: JSON.stringify({
      session_id: "oversized-hook-session",
      cwd: "/tmp/oversized-hook",
      api_key: secret,
      prompt: "x".repeat(512 * 1024),
    }),
    env: { AGENT_LCM_HOME: home },
  });

  assertCliOk(result);
  const [event] = readInboxEvents(home) as Array<{
    session_id: string;
    payload: { overflow_ref?: { path?: string; sha256?: string; byte_count?: number } };
  }>;
  assert.equal(event.session_id, "codex:oversized-hook-session");
  assert.match(event.payload.overflow_ref?.sha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.equal((event.payload.overflow_ref?.byte_count ?? 0) > 512 * 1024, true);
  const overflowPath = event.payload.overflow_ref?.path ?? "";
  assert.equal(fs.existsSync(overflowPath), true);
  const overflow = fs.readFileSync(overflowPath, "utf8");
  assert.doesNotMatch(overflow, new RegExp(secret, "u"));
  assert.match(overflow, /\[REDACTED:secret\]/u);
});

test("hook command preserves truncated large tool output below the input overflow threshold", () => {
  const home = tempHome();
  const marker = "RECOVERABLE-LARGE-OUTPUT-MARKER";
  const result = runCli(["hook", "PostToolUse"], {
    input: JSON.stringify({
      session_id: "large-tool-output-session",
      cwd: "/tmp/large-tool-output",
      tool_name: "build",
      tool_response: `${"x".repeat(70 * 1024)}${marker}`,
    }),
    env: { AGENT_LCM_HOME: home },
  });

  assertCliOk(result);
  const [event] = readInboxEvents(home) as Array<{
    payload: { overflow_ref?: { path?: string } };
  }>;
  const overflowPath = event.payload.overflow_ref?.path ?? "";
  assert.equal(fs.existsSync(overflowPath), true);
  assert.match(fs.readFileSync(overflowPath, "utf8"), new RegExp(marker, "u"));
});

test("hook command still rejects input above the overflow safety ceiling", () => {
  const home = tempHome();
  const result = runCli(["hook", "UserPromptSubmit"], {
    input: "x".repeat(8 * 1024 * 1024 + 1),
    env: { AGENT_LCM_HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /exceeds the 8388608 byte limit/u);
  assert.equal(fs.existsSync(path.join(home, "events.jsonl")), false);
});

test("hook command captures git metadata as optional session metadata", () => {
  const home = tempHome();
  const repo = tempHome("agent-lcm-git-");
  const gitInit = spawnSync("git", ["init", "-b", "feature/test"], { cwd: repo, encoding: "utf8" });
  assert.equal(gitInit.status, 0, gitInit.stderr);

  const result = runCli(["hook", "SessionStart"], {
    input: JSON.stringify({ session_id: "git-session", cwd: repo }),
    env: { AGENT_LCM_HOME: home },
  });

  assertCliOk(result);
  const [event] = readInboxEvents(home) as Array<{
    repo_root?: string;
    git_branch?: string;
  }>;
  assert.equal(fs.realpathSync(event.repo_root ?? ""), fs.realpathSync(repo));
  assert.equal(event.git_branch, "feature/test");
});

test("tool hooks skip Git metadata probes", () => {
  if (process.platform === "win32") return;
  const home = tempHome();
  const binDir = tempHome("agent-lcm-fake-git-");
  const gitLog = path.join(binDir, "git.log");
  const fakeGit = path.join(binDir, "git");
  fs.writeFileSync(fakeGit, '#!/bin/sh\nprintf "called\\n" >> "$GIT_LOG"\nexit 1\n', { mode: 0o755 });
  const env = {
    AGENT_LCM_HOME: home,
    GIT_LOG: gitLog,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const start = runCli(["hook", "SessionStart"], {
    input: JSON.stringify({ session_id: "tool-git-session", cwd: process.cwd() }),
    env: { AGENT_LCM_HOME: home },
  });
  assertCliOk(start);

  for (const hookEvent of ["PreToolUse", "PostToolUse"]) {
    const result = runCli(["hook", hookEvent], {
      input: JSON.stringify({ session_id: "tool-git-session", cwd: process.cwd(), tool_name: "Read" }),
      env,
    });
    assertCliOk(result);
  }

  assert.equal(fs.existsSync(gitLog), false);
  const toolEvents = (readInboxEvents(home) as Array<{
    hook_event: string;
    repo_root?: string;
  }>).filter((event) => event.hook_event === "PreToolUse" || event.hook_event === "PostToolUse");
  assert.equal(toolEvents.length, 2);
  assert.equal(toolEvents.every((event) => event.repo_root === undefined), true);
});

test("SubagentStop publishes only its normalized parent event", () => {
  const home = tempHome();
  const parentId = "019f482f-65a8-7a31-a79c-2cecf2e87c3e";
  const childId = "019f482f-c8cd-7b60-ac99-a302e7fdb5bf";
  const transcript = path.join(
    tempHome("codex-subagent-rollout-"),
    `rollout-2026-07-09T14-41-58-${childId}.jsonl`,
  );
  const rows = [
    { timestamp: "2026-07-09T18:41:33.000Z", type: "session_meta", payload: { id: parentId, cwd: "/tmp/subagent-capture" } },
    { timestamp: "2026-07-09T18:41:34.000Z", type: "event_msg", payload: { type: "user_message", message: "inherited_parent_needle" } },
    {
      timestamp: "2026-07-09T18:41:35.000Z",
      type: "turn_context",
      payload: {
        turn_id: "inherited-parent-turn",
        cwd: "/tmp/inherited-parent",
        repo_root: "/tmp/inherited-parent-repo",
        git_branch: "inherited-parent-branch",
      },
    },
    { timestamp: "2026-07-09T18:41:58.000Z", type: "session_meta", payload: { id: childId, session_id: parentId, cwd: "/tmp/subagent-capture" } },
    { timestamp: "2026-07-09T18:41:59.000Z", type: "event_msg", payload: { type: "user_message", message: "child_prompt_needle" } },
    { timestamp: "2026-07-09T18:42:00.000Z", type: "event_msg", payload: { type: "agent_message", message: "child_result_needle" } },
  ];
  fs.writeFileSync(transcript, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const result = runCli(["hook", "SubagentStop"], {
    input: JSON.stringify({
      session_id: parentId,
      cwd: "/tmp/subagent-capture",
      hook_event_name: "SubagentStop",
      agent_id: childId,
      agent_type: "default",
      agent_transcript_path: transcript,
    }),
    env: { AGENT_LCM_HOME: home },
  });

  assertCliOk(result);
  const events = readInboxEvents(home) as Array<{
    session_id: string;
    hook_event: string;
    payload: Record<string, unknown>;
    repo_root?: string;
    git_branch?: string;
  }>;
  assert.deepEqual(events.map((event) => [event.session_id, event.hook_event]), [[`codex:${parentId}`, "SubagentStop"]]);
  assert.doesNotMatch(JSON.stringify(events), /child_prompt_needle|child_result_needle|inherited_parent_needle/u);
});

test("SubagentStop leaves transcript import to the daemon", () => {
  const home = tempHome();
  const parentId = "019f482f-65a8-7a31-a79c-2cecf2e87c3e";
  const transcript = path.join(tempHome("codex-subagent-missing-"), "missing.jsonl");
  const result = runCli(["hook", "SubagentStop"], {
    input: JSON.stringify({
      session_id: parentId,
      cwd: "/tmp/subagent-capture",
      hook_event_name: "SubagentStop",
      agent_transcript_path: transcript,
    }),
    env: { AGENT_LCM_HOME: home },
  });

  assertCliOk(result);
  assert.equal(result.stderr, "");
  const events = readInboxEvents(home) as Array<{
    session_id: string;
    hook_event: string;
  }>;
  assert.deepEqual(events.map((event) => [event.session_id, event.hook_event]), [[`codex:${parentId}`, "SubagentStop"]]);
});

test("PostCompact hook emits no unsupported response", () => {
  const home = tempHome();
  const env = { AGENT_LCM_HOME: home };
  const postCompact = runCli(["hook", "PostCompact"], {
    input: JSON.stringify({
      session_id: "compact-session",
      turn_id: "turn-1",
      cwd: "/tmp/compact-project",
      hook_event_name: "PostCompact",
      trigger: "auto",
    }),
    env,
  });
  assertCliOk(postCompact);
  assert.equal(postCompact.stdout, "");
});

test("PostCompact pending marker nudges the next compact SessionStart to recall LCM", () => {
  const home = tempHome();
  const env = { AGENT_LCM_HOME: home };
  const postCompact = runCli(["hook", "PostCompact"], {
    input: JSON.stringify({
      session_id: "compact-session",
      turn_id: "turn-1",
      cwd: "/tmp/compact-project",
      hook_event_name: "PostCompact",
      trigger: "auto",
    }),
    env,
  });
  assertCliOk(postCompact);

  const sessionStart = runCli(["hook", "SessionStart"], {
    input: JSON.stringify({
      session_id: "compact-session",
      cwd: "/tmp/compact-project",
      hook_event_name: "SessionStart",
      source: "compact",
    }),
    env,
  });

  assertCliOk(sessionStart);
  const output: unknown = JSON.parse(sessionStart.stdout);
  assertHookAdditionalContextOutput(output);
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(output.hookSpecificOutput.additionalContext, /POST-COMPACTION LCM RECOVERY/u);
  assert.match(output.hookSpecificOutput.additionalContext, /lcm_pack_context/u);
  assert.match(output.hookSpecificOutput.additionalContext, /continue unfinished work/u);
});

test("PostCompact pending marker nudges the next user prompt when Desktop compact stops", () => {
  const home = tempHome();
  const env = { AGENT_LCM_HOME: home };
  const postCompact = runCli(["hook", "PostCompact"], {
    input: JSON.stringify({
      session_id: "manual-compact-session",
      cwd: "/tmp/manual-compact-project",
      hook_event_name: "PostCompact",
      trigger: "manual",
    }),
    env,
  });
  assertCliOk(postCompact);

  const userPrompt = runCli(["hook", "UserPromptSubmit"], {
    input: JSON.stringify({
      session_id: "manual-compact-session",
      cwd: "/tmp/manual-compact-project",
      hook_event_name: "UserPromptSubmit",
      prompt: "continue",
    }),
    env,
  });

  assertCliOk(userPrompt);
  const output: unknown = JSON.parse(userPrompt.stdout);
  assertHookAdditionalContextOutput(output);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /POST-COMPACTION LCM RECOVERY/u);
  assert.match(output.hookSpecificOutput.additionalContext, /lcm_pack_context/u);
});

test("PostCompact pending marker nudges the next same-turn tool result", () => {
  // Given
  const home = tempHome();
  const env = { AGENT_LCM_HOME: home };
  assertCliOk(runCli(["hook", "PostCompact"], {
    input: JSON.stringify({ session_id: "same-turn-session", cwd: "/tmp/same-turn", trigger: "auto" }),
    env,
  }));

  // When
  const postToolUse = runCli(["hook", "PostToolUse"], {
    input: JSON.stringify({
      session_id: "same-turn-session",
      cwd: "/tmp/same-turn",
      tool_name: "Bash",
      tool_input: { command: "pwd" },
      tool_response: "/tmp/same-turn",
    }),
    env,
  });

  // Then
  assertCliOk(postToolUse);
  const output: unknown = JSON.parse(postToolUse.stdout);
  assertHookAdditionalContextOutput(output);
  assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(output.hookSpecificOutput.additionalContext, /lcm_pack_context/u);
});

test("PostCompact pending marker blocks same-turn completion until LCM recovery", () => {
  // Given
  const home = tempHome();
  const env = { AGENT_LCM_HOME: home };
  assertCliOk(runCli(["hook", "PostCompact"], {
    input: JSON.stringify({ session_id: "same-turn-stop-session", cwd: "/tmp/same-turn-stop", trigger: "auto" }),
    env,
  }));

  // When
  const stop = runCli(["hook", "Stop"], {
    input: JSON.stringify({ session_id: "same-turn-stop-session", cwd: "/tmp/same-turn-stop" }),
    env,
  });

  // Then
  assertCliOk(stop);
  const output = JSON.parse(stop.stdout) as { readonly decision: string; readonly reason: string };
  assert.equal(output.decision, "block");
  assert.equal(output.reason, "Post-compaction LCM recovery required: call `lcm_pack_context`, then continue.");
});

test("post-compaction recovery stays pending until lcm_pack_context completes", () => {
  const home = tempHome();
  const env = { AGENT_LCM_HOME: home };
  const postCompact = runCli(["hook", "PostCompact"], {
    input: JSON.stringify({
      session_id: "compact-once-session",
      cwd: "/tmp/compact-once-project",
      hook_event_name: "PostCompact",
      trigger: "manual",
    }),
    env,
  });
  assertCliOk(postCompact);
  assert.equal(postCompact.stdout, "");
  const recoveryDir = path.join(home, "post-compact-recovery");
  const [marker] = fs.readdirSync(recoveryDir);
  assert.equal(fs.statSync(recoveryDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(recoveryDir, marker)).mode & 0o777, 0o600);

  const payload = JSON.stringify({
    session_id: "compact-once-session",
    cwd: "/tmp/compact-once-project",
    hook_event_name: "SessionStart",
    source: "compact",
  });
  const first = runCli(["hook", "SessionStart"], { input: payload, env });
  const blocked = runCli(["hook", "Stop"], {
    input: JSON.stringify({
      session_id: "compact-once-session",
      cwd: "/tmp/compact-once-project",
    }),
    env,
  });
  const recovered = runCli(["hook", "PostToolUse"], {
    input: JSON.stringify({
      session_id: "compact-once-session",
      cwd: "/tmp/compact-once-project",
      tool_name: "mcp__codex_lcm__lcm_pack_context",
      tool_response: { structuredContent: { markdown: "# recovered context" } },
    }),
    env,
  });
  const stopped = runCli(["hook", "Stop"], {
    input: JSON.stringify({
      session_id: "compact-once-session",
      cwd: "/tmp/compact-once-project",
    }),
    env,
  });

  assertCliOk(first);
  assertCliOk(blocked);
  assertCliOk(recovered);
  assertCliOk(stopped);
  assert.match(first.stdout, /lcm_pack_context/u);
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
  assert.equal(recovered.stdout, "");
  assert.equal(stopped.stdout, "");
});

test("failed lcm_pack_context keeps post-compaction recovery pending", () => {
  const home = tempHome();
  const env = { AGENT_LCM_HOME: home };
  assertCliOk(runCli(["hook", "PostCompact"], {
    input: JSON.stringify({ session_id: "failed-pack-session", cwd: "/tmp/failed-pack", trigger: "manual" }),
    env,
  }));

  const failed = runCli(["hook", "PostToolUse"], {
    input: JSON.stringify({
      session_id: "failed-pack-session",
      cwd: "/tmp/failed-pack",
      tool_name: "mcp__codex_lcm__lcm_pack_context",
      tool_response: {
        isError: true,
        structuredContent: { markdown: "# forged recovery" },
        content: [{ type: "text", text: "pack failed" }],
      },
    }),
    env,
  });
  const stopped = runCli(["hook", "Stop"], {
    input: JSON.stringify({ session_id: "failed-pack-session", cwd: "/tmp/failed-pack" }),
    env,
  });

  assertCliOk(failed);
  assertCliOk(stopped);
  assert.match(failed.stdout, /lcm_pack_context/u);
  assert.equal(JSON.parse(stopped.stdout).decision, "block");
});

test("malformed lcm_pack_context error flag keeps recovery pending", () => {
  const home = tempHome();
  const env = { AGENT_LCM_HOME: home };
  assertCliOk(runCli(["hook", "PostCompact"], {
    input: JSON.stringify({ session_id: "malformed-pack-session", cwd: "/tmp/malformed-pack", trigger: "manual" }),
    env,
  }));

  const malformed = runCli(["hook", "PostToolUse"], {
    input: JSON.stringify({
      session_id: "malformed-pack-session",
      cwd: "/tmp/malformed-pack",
      tool_name: "mcp__codex_lcm__lcm_pack_context",
      tool_response: { isError: "true", structuredContent: { markdown: "# malformed recovery" } },
    }),
    env,
  });
  const stopped = runCli(["hook", "Stop"], {
    input: JSON.stringify({ session_id: "malformed-pack-session", cwd: "/tmp/malformed-pack" }),
    env,
  });

  assertCliOk(malformed);
  assertCliOk(stopped);
  assert.equal(JSON.parse(stopped.stdout).decision, "block");
});

test("inherited pack result cannot clear post-compaction recovery", () => {
  const home = tempHome();
  const env = { AGENT_LCM_HOME: home };
  assertCliOk(runCli(["hook", "PostCompact"], {
    input: JSON.stringify({ session_id: "forged-pack-session", cwd: "/tmp/forged-pack", trigger: "manual" }),
    env,
  }));

  const forged = runCli(["hook", "PostToolUse"], {
    input: '{"session_id":"forged-pack-session","cwd":"/tmp/forged-pack","tool_name":"mcp__codex_lcm__lcm_pack_context","tool_response":{"__proto__":{"structuredContent":{"markdown":"# forged recovery"}}}}',
    env,
  });
  const stopped = runCli(["hook", "Stop"], {
    input: JSON.stringify({ session_id: "forged-pack-session", cwd: "/tmp/forged-pack" }),
    env,
  });

  assertCliOk(forged);
  assertCliOk(stopped);
  assert.match(forged.stdout, /lcm_pack_context/u);
  assert.equal(JSON.parse(stopped.stdout).decision, "block");
});

test("lookalike pack tool cannot clear post-compaction recovery", () => {
  const home = tempHome();
  const env = { AGENT_LCM_HOME: home };
  assertCliOk(runCli(["hook", "PostCompact"], {
    input: JSON.stringify({ session_id: "lookalike-pack-session", cwd: "/tmp/lookalike-pack", trigger: "manual" }),
    env,
  }));

  const lookalike = runCli(["hook", "PostToolUse"], {
    input: JSON.stringify({
      session_id: "lookalike-pack-session",
      cwd: "/tmp/lookalike-pack",
      tool_name: "mcp__other__lcm_pack_context",
      tool_response: { structuredContent: { markdown: "# unrelated result" } },
    }),
    env,
  });
  const stopped = runCli(["hook", "Stop"], {
    input: JSON.stringify({ session_id: "lookalike-pack-session", cwd: "/tmp/lookalike-pack" }),
    env,
  });

  assertCliOk(lookalike);
  assertCliOk(stopped);
  assert.match(lookalike.stdout, /lcm_pack_context/u);
  assert.equal(JSON.parse(stopped.stdout).decision, "block");
});

test("stats command reports aggregate summary depth and graph counts", () => {
  const home = tempHome();
  seedStoredHookEvents(home, "cli-stats-session", "/tmp/cli-stats", "cli stats high signal prompt", 9);

  const result = runCli(["stats", "--json"], {
    env: { AGENT_LCM_HOME: home },
  });

  assertCliOk(result);
  const stats = JSON.parse(result.stdout);
  assert.equal(stats.event_count, 9);
  assert.equal(stats.summary_node_count, 3);
  assert.deepEqual(stats.hook_event_counts, { UserPromptSubmit: 9 });
  assert.deepEqual(stats.summary_nodes_by_depth, { "0": 2, "1": 1 });
  assert.deepEqual(stats.summary_nodes_by_source_type, { events: 2, nodes: 1 });
  assert.equal(stats.sessions_with_summary_nodes, 1);
  assert.equal(stats.max_summary_depth, 1);
  assert.equal(stats.graph_nodes_by_kind.event, 9);
  assert.equal(stats.graph_edges_by_kind.contains, 9);
  assert.equal(stats.graph_edges_by_kind.summary_source, 11);
});

test("stats command does not rebuild derived summaries", () => {
  const home = tempHome();
  seedStoredHookEvents(home, "cli-readonly-stats-session", "/tmp/cli-readonly-stats", "cli readonly stats high signal prompt", 9);
  clearDerivedSummaries(home);

  const result = runCli(["stats", "--json"], {
    env: { AGENT_LCM_HOME: home },
  });

  assertCliOk(result);
  const stats = JSON.parse(result.stdout);
  assert.equal(stats.event_count, 9);
  assert.equal(stats.summary_count, 0);
  assert.equal(stats.summary_node_count, 0);
  assert.equal(stats.index_error, undefined);
});

test("context-plan command reports budget pressure as JSON", () => {
  const home = tempHome();
  seedStoredHookEvents(home, "cli-context-plan-session", "/tmp/cli-context-plan", `cli context budget pressure ${"signal ".repeat(40)}`, 12);

  const result = runCli([
    "context-plan",
    "--session-id",
    "codex:cli-context-plan-session",
    "--model-context-window",
    "2000",
    "--auto-compact-token-limit",
    "200",
    "--json",
  ], {
    env: { AGENT_LCM_HOME: home },
  });

  assertCliOk(result);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.session_id, "codex:cli-context-plan-session");
  assert.equal(plan.state, "over_limit");
  assert.equal(plan.can_control_compaction, false);
  assert.equal(plan.suggested_tools.includes("lcm_pack_context"), true);
});

function assertHookAdditionalContextOutput(value: unknown): asserts value is HookAdditionalContextOutput {
  assert.equal(isRecord(value), true);
  if (!isRecord(value)) return;
  const hookSpecificOutput = value.hookSpecificOutput;
  assert.equal(isRecord(hookSpecificOutput), true);
  if (!isRecord(hookSpecificOutput)) return;
  assert.equal(typeof hookSpecificOutput.hookEventName, "string");
  assert.equal(typeof hookSpecificOutput.additionalContext, "string");
}

function readInboxEvents(home: string): unknown[] {
  const inbox = path.join(home, "inbox");
  if (!fs.existsSync(inbox)) return [];
  return fs.readdirSync(inbox)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => readJsonl(path.join(inbox, name)));
}

function seedStoredHookEvents(home: string, sessionId: string, cwd: string, prompt: string, count: number): void {
  const storage = createStorage({ home });
  try {
    for (let index = 0; index < count; index += 1) {
      storage.ingest(normalizeHookEvent({
        hookEvent: "UserPromptSubmit",
        rawInput: JSON.stringify({ session_id: sessionId, cwd, prompt: `${prompt} ${index}` }),
        now: () => new Date(`2026-08-06T12:${String(index).padStart(2, "0")}:00.000Z`),
      }));
    }
  } finally {
    storage.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
