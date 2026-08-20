import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { parse } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";

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

test("capture publishes a mapped harness event before starting the shared daemon", () => {
  const home = tempHome("agent-lcm-capture-");
  const env = { AGENT_LCM_HOME: home };
  const result = runCli(["capture", "--harness", "cursor", "UserPromptSubmit"], {
    input: JSON.stringify({ session_id: "cursor-capture", cwd: "/tmp/cursor-capture", prompt: "capture through queue" }),
    env,
    timeout: 15_000,
  });
  assertCliOk(result);
  const [event] = readJsonl(path.join(home, "events.jsonl")) as Array<{
    harness: string;
    native_event: string;
    hook_event: string;
    session_id: string;
  }>;
  assert.equal(event.harness, "cursor");
  assert.equal(event.native_event, "UserPromptSubmit");
  assert.equal(event.hook_event, "UserPromptSubmit");
  assert.equal(event.session_id, "cursor:cursor-capture");
  const status = runCli(["daemon", "status"], { env, timeout: 15_000 });
  assertCliOk(status);
  assert.equal(JSON.parse(status.stdout).running, false);
});

test("Claude Code capture persists a canonical event and rejects unsupported events before publication", () => {
  const home = tempHome("agent-lcm-claude-capture-");
  const env = { AGENT_LCM_HOME: home };
  const captured = runCli(["capture", "--harness", "claude", "UserPromptSubmit"], {
    input: JSON.stringify({ session_id: "claude-capture", cwd: "/tmp/claude-capture", prompt: "capture through queue" }),
    env,
    timeout: 15_000,
  });
  assertCliOk(captured);
  const [event] = readJsonl(path.join(home, "events.jsonl")) as Array<{
    harness: string;
    native_event: string;
    hook_event: string;
    session_id: string;
  }>;
  assert.equal(event.harness, "claude");
  assert.equal(event.native_event, "UserPromptSubmit");
  assert.equal(event.hook_event, "UserPromptSubmit");
  assert.equal(event.session_id, "claude:claude-capture");

  const rejectedHome = tempHome("agent-lcm-claude-rejected-");
  const rejected = runCli(["capture", "--harness", "claude", "MessageDisplay"], {
    input: JSON.stringify({ session_id: "claude-rejected", cwd: "/tmp/claude-rejected" }),
    env: { AGENT_LCM_HOME: rejectedHome },
    timeout: 15_000,
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Unsupported claude capture event: MessageDisplay/u);
  assert.equal(fs.existsSync(path.join(rejectedHome, "inbox")), false);
  assert.equal(fs.existsSync(path.join(rejectedHome, "events.jsonl")), false);
});

test("OpenCode capture accepts sessionID and rejects unsupported event names", () => {
  const home = tempHome("agent-lcm-opencode-capture-");
  const env = { AGENT_LCM_HOME: home };
  const captured = runCli(["capture", "--harness", "opencode", "UserPromptSubmit"], {
    input: JSON.stringify({ sessionID: "opencode-capture", cwd: "/tmp/opencode-capture", prompt: "capture through queue" }),
    env,
    timeout: 15_000,
  });
  assertCliOk(captured);
  const [event] = readJsonl(path.join(home, "events.jsonl")) as Array<{
    harness: string;
    native_event: string;
    hook_event: string;
    session_id: string;
  }>;
  assert.equal(event.harness, "opencode");
  assert.equal(event.native_event, "UserPromptSubmit");
  assert.equal(event.hook_event, "UserPromptSubmit");
  assert.equal(event.session_id, "opencode:opencode-capture");

  const rejectedHome = tempHome("agent-lcm-opencode-rejected-");
  const rejected = runCli(["capture", "--harness", "opencode", "userPromptSubmitted"], {
    input: JSON.stringify({ sessionID: "opencode-rejected", cwd: "/tmp/opencode-rejected" }),
    env: { AGENT_LCM_HOME: rejectedHome },
    timeout: 15_000,
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Unsupported opencode capture event: userPromptSubmitted/u);
  assert.equal(fs.existsSync(path.join(rejectedHome, "inbox")), false);
  assert.equal(fs.existsSync(path.join(rejectedHome, "events.jsonl")), false);
});

test("import help lists Claude Code", () => {
  const home = tempHome("agent-lcm-claude-import-");
  const help = runCli(["--help"], { env: { AGENT_LCM_HOME: home } });
  assertCliOk(help);
  assert.match(help.stdout, /import --all\|--harness codex\|cursor\|vscode\|copilot\|kiro\|claude/u);
});

test("help lists OpenCode capture and setup vocabulary", () => {
  const help = runCli(["--help"], { env: { AGENT_LCM_HOME: tempHome("agent-lcm-opencode-help-") } });
  assertCliOk(help);
  assert.match(help.stdout, /capture --harness codex\|cursor\|vscode\|copilot\|kiro\|claude\|opencode\|auto/u);
  assert.match(help.stdout, /setup <codex\|cursor\|vscode\|copilot\|kiro\|claude\|opencode>/u);
  assert.match(help.stdout, /remove <codex\|cursor\|vscode\|copilot\|kiro\|claude\|opencode>/u);
});

test("OpenCode setup, repeat, status, and remove work through the CLI boundary", () => {
  const home = tempHome("agent-lcm-opencode-cli-");
  const setup = runCli(["setup", "opencode", "--home", home, "--json"]);
  assert.equal(setup.status, 0, setup.stderr);
  const first = JSON.parse(setup.stdout) as { status: string; hooks: { changed: boolean }; mcp: { changed: boolean } };
  assert.equal(first.status, "complete");
  assert.equal(first.hooks.changed, true);
  assert.equal(first.mcp.changed, true);
  const configPath = path.join(home, "opencode.json");
  const configured = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    mcp: { "agent-lcm": { type: string; command: string[]; enabled: boolean } };
  };
  assert.deepEqual(configured.mcp["agent-lcm"], {
    type: "local",
    command: ["node", path.resolve("bin/agent-lcm"), "mcp"],
    enabled: true,
  });

  const repeat = runCli(["setup", "opencode", "--home", home, "--json"]);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal((JSON.parse(repeat.stdout) as { hooks: { changed: boolean } }).hooks.changed, false);
  assert.equal((JSON.parse(repeat.stdout) as { mcp: { changed: boolean } }).mcp.changed, false);

  const status = runCli(["setup", "status", "--home", home, "--json"]);
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual((JSON.parse(status.stdout) as { opencode: { hooksConfigured: boolean; mcpConfigured: boolean } }).opencode, {
    hooksConfigured: true,
    mcpConfigured: true,
    path: path.join(home, "plugins", "agent-lcm.ts"),
  });

  const remove = runCli(["remove", "opencode", "--home", home, "--json"]);
  assert.equal(remove.status, 0, remove.stderr);
  assert.equal((JSON.parse(remove.stdout) as { hooks: { changed: boolean }; mcp: { changed: boolean } }).hooks.changed, true);
  assert.equal((JSON.parse(remove.stdout) as { mcp: { changed: boolean } }).mcp.changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), { mcp: {} });
  assert.equal(fs.existsSync(path.join(home, "plugins", "agent-lcm.ts")), true);
  assert.equal(fs.readFileSync(path.join(home, "plugins", ".agent-lcm-opencode-plugin.state"), "utf8"), `disabled\n${JSON.stringify(path.resolve("bin/agent-lcm"))}\n`);

  const repeatedRemove = runCli(["remove", "opencode", "--home", home, "--json"]);
  assert.equal(repeatedRemove.status, 0, repeatedRemove.stderr);
  assert.equal((JSON.parse(repeatedRemove.stdout) as { hooks: { changed: boolean } }).hooks.changed, false);
  assert.equal((JSON.parse(repeatedRemove.stdout) as { mcp: { changed: boolean } }).mcp.changed, false);
});

test("OpenCode CLI setup preserves JSON and configures JSONC without losing comments", () => {
  const preservedHome = tempHome("agent-lcm-opencode-config-");
  fs.writeFileSync(path.join(preservedHome, "opencode.json"), JSON.stringify({
    theme: "dark",
    mcp: { unrelated: { type: "local", command: ["other"] } },
  }));
  const preserved = runCli(["setup", "opencode", "--home", preservedHome, "--json"]);
  assert.equal(preserved.status, 0, preserved.stderr);
  const preservedConfig = JSON.parse(fs.readFileSync(path.join(preservedHome, "opencode.json"), "utf8")) as {
    theme: string;
    mcp: { unrelated: unknown; "agent-lcm": unknown };
  };
  assert.equal(preservedConfig.theme, "dark");
  assert.deepEqual(preservedConfig.mcp.unrelated, { type: "local", command: ["other"] });
  assert.ok(preservedConfig.mcp["agent-lcm"]);

  const malformedHome = tempHome("agent-lcm-opencode-malformed-");
  const malformed = Buffer.from("{not valid json\n");
  fs.writeFileSync(path.join(malformedHome, "opencode.json"), malformed);
  const malformedResult = runCli(["setup", "opencode", "--home", malformedHome, "--json"]);
  assert.equal(malformedResult.status, 1);
  assert.match(malformedResult.stderr, /Cannot safely setup OpenCode configuration/u);
  assert.deepEqual(fs.readFileSync(path.join(malformedHome, "opencode.json")), malformed);
  assert.equal(fs.existsSync(path.join(malformedHome, "plugins")), false);

  const jsoncHome = tempHome("agent-lcm-opencode-jsonc-");
  const jsoncPath = path.join(jsoncHome, "opencode.jsonc");
  const jsoncBytes = Buffer.from('{\n  // keep comments\n  "theme": "dark",\n}\n');
  fs.writeFileSync(jsoncPath, jsoncBytes);
  const jsonc = runCli(["setup", "opencode", "--home", jsoncHome, "--json"]);
  assert.equal(jsonc.status, 0, jsonc.stderr);
  const jsoncReport = JSON.parse(jsonc.stdout) as {
    status: string;
    hooks: { changed: boolean };
    mcp: { changed: boolean; path: string };
  };
  assert.equal(jsoncReport.status, "complete");
  assert.equal(jsoncReport.hooks.changed, true);
  assert.deepEqual(jsoncReport.mcp, { changed: true, path: jsoncPath });
  const configuredJsonc = fs.readFileSync(jsoncPath, "utf8");
  assert.match(configuredJsonc, /\/\/ keep comments/u);
  assert.match(configuredJsonc, /"theme": "dark",/u);
  assert.match(configuredJsonc, /"agent-lcm"/u);
  assert.equal(fs.existsSync(path.join(jsoncHome, "plugins", "agent-lcm.ts")), true);
  assert.equal(fs.readFileSync(path.join(jsoncHome, "plugins", ".agent-lcm-opencode-plugin.state"), "utf8"), `enabled\n${JSON.stringify(path.resolve("bin/agent-lcm"))}\n`);
  assert.equal(fs.existsSync(path.join(jsoncHome, "opencode.json")), false);
  const jsoncStatus = runCli(["setup", "status", "--home", jsoncHome, "--json"]);
  assert.equal(jsoncStatus.status, 0, jsoncStatus.stderr);
  assert.equal((JSON.parse(jsoncStatus.stdout) as { opencode: { mcpConfigured: boolean } }).opencode.mcpConfigured, true);

  const jsoncText = runCli(["setup", "opencode", "--home", jsoncHome]);
  assert.equal(jsoncText.status, 0, jsoncText.stderr);
  assert.doesNotMatch(jsoncText.stdout, /manual/u);
  assert.doesNotMatch(jsoncText.stdout, /Native CLI unavailable/u);

  const jsoncRemoval = runCli(["remove", "opencode", "--home", jsoncHome, "--json"]);
  assert.equal(jsoncRemoval.status, 0, jsoncRemoval.stderr);
  const removedJsonc = fs.readFileSync(jsoncPath, "utf8");
  assert.match(removedJsonc, /\/\/ keep comments/u);
  assert.match(removedJsonc, /"theme": "dark",/u);
  assert.doesNotMatch(removedJsonc, /"agent-lcm"/u);

  const malformedJsoncHome = tempHome("agent-lcm-opencode-invalid-jsonc-");
  const malformedJsonc = Buffer.from("{ // broken\n");
  fs.writeFileSync(path.join(malformedJsoncHome, "opencode.jsonc"), malformedJsonc);
  const malformedJsoncResult = runCli(["setup", "opencode", "--home", malformedJsoncHome, "--json"]);
  assert.equal(malformedJsoncResult.status, 1);
  assert.match(malformedJsoncResult.stderr, /Cannot safely setup OpenCode configuration/u);
  assert.deepEqual(fs.readFileSync(path.join(malformedJsoncHome, "opencode.jsonc")), malformedJsonc);
  assert.equal(fs.existsSync(path.join(malformedJsoncHome, "plugins")), false);

  const malformedJsonHome = tempHome("agent-lcm-opencode-jsonc-invalid-json-");
  const malformedJson = Buffer.from("{not valid json\n");
  fs.writeFileSync(path.join(malformedJsonHome, "opencode.json"), malformedJson);
  fs.writeFileSync(path.join(malformedJsonHome, "opencode.jsonc"), "{ // valid JSONC\n}\n");
  const malformedJsonResult = runCli(["setup", "opencode", "--home", malformedJsonHome, "--json"]);
  assert.equal(malformedJsonResult.status, 1);
  assert.match(malformedJsonResult.stderr, /Cannot safely setup OpenCode configuration/u);
  assert.deepEqual(fs.readFileSync(path.join(malformedJsonHome, "opencode.json")), malformedJson);
  assert.equal(fs.existsSync(path.join(malformedJsonHome, "plugins")), false);

  const removalJsoncHome = tempHome("agent-lcm-opencode-remove-jsonc-");
  const removalSetup = runCli(["setup", "opencode", "--home", removalJsoncHome, "--json"]);
  assert.equal(removalSetup.status, 0, removalSetup.stderr);
  fs.writeFileSync(path.join(removalJsoncHome, "opencode.jsonc"), "{ // manual comments\n}\n");
  const removal = runCli(["remove", "opencode", "--home", removalJsoncHome, "--json"]);
  assert.equal(removal.status, 0, removal.stderr);
  assert.equal((JSON.parse(removal.stdout) as { status: string }).status, "complete");
  assert.equal(fs.existsSync(path.join(removalJsoncHome, "plugins", "agent-lcm.ts")), true);
  assert.equal(fs.readFileSync(path.join(removalJsoncHome, "plugins", ".agent-lcm-opencode-plugin.state"), "utf8"), `disabled\n${JSON.stringify(path.resolve("bin/agent-lcm"))}\n`);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(removalJsoncHome, "opencode.json"), "utf8")), { mcp: {} });
});

test("OpenCode CLI removal cleans the exact owned MCP entry when the plugin is missing", () => {
  const home = tempHome("agent-lcm-opencode-missing-plugin-");
  const setup = runCli(["setup", "opencode", "--home", home, "--json"]);
  assert.equal(setup.status, 0, setup.stderr);
  fs.unlinkSync(path.join(home, "plugins", "agent-lcm.ts"));

  const status = runCli(["setup", "status", "--home", home, "--json"]);
  assert.equal(status.status, 0, status.stderr);
  const openCodeStatus = (JSON.parse(status.stdout) as { opencode: { hooksConfigured: boolean; mcpConfigured: boolean } }).opencode;
  assert.equal(openCodeStatus.hooksConfigured, false);
  assert.equal(openCodeStatus.mcpConfigured, true);

  const removal = runCli(["remove", "opencode", "--home", home, "--json"]);

  assert.equal(removal.status, 0, removal.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "opencode.json"), "utf8")), { mcp: {} });
  assert.equal(fs.readFileSync(path.join(home, "plugins", ".agent-lcm-opencode-plugin.state"), "utf8"), `disabled\n${JSON.stringify(path.resolve("bin/agent-lcm"))}\n`);
});

test("OpenCode CLI removal preserves a different MCP command when the plugin is missing", () => {
  const home = tempHome("agent-lcm-opencode-missing-plugin-near-match-");
  const setup = runCli(["setup", "opencode", "--home", home, "--json"]);
  assert.equal(setup.status, 0, setup.stderr);
  fs.unlinkSync(path.join(home, "plugins", "agent-lcm.ts"));
  const configPath = path.join(home, "opencode.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
    mcp: { "agent-lcm": { command: string[] } };
  };
  config.mcp["agent-lcm"].command[1] = "/opt/other/agent-lcm";
  fs.writeFileSync(configPath, JSON.stringify(config));

  const removal = runCli(["remove", "opencode", "--home", home, "--json"]);

  assert.equal(removal.status, 0, removal.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), config);

  fs.unlinkSync(path.join(home, "plugins", ".agent-lcm-opencode-plugin.state"));
  const removalWithoutMarker = runCli(["remove", "opencode", "--home", home, "--json"]);
  assert.equal(removalWithoutMarker.status, 0, removalWithoutMarker.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), config);
});

test("OpenCode CLI refuses a near-matching Agent LCM MCP server", () => {
  const home = tempHome("agent-lcm-opencode-mcp-owner-");
  const original = {
    mcp: { "agent-lcm": { type: "local", command: ["node", "/other/agent-lcm", "mcp"], enabled: true } },
  };
  fs.writeFileSync(path.join(home, "opencode.json"), JSON.stringify(original));
  const result = runCli(["setup", "opencode", "--home", home, "--json"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unmanaged OpenCode MCP entry/u);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "opencode.json"), "utf8")), original);
  assert.equal(fs.existsSync(path.join(home, "plugins")), false);
});

test("OpenCode CLI removal keeps a sole trailing-comma JSONC MCP entry valid", () => {
  const home = tempHome("agent-lcm-opencode-jsonc-trailing-removal-");
  const setup = runCli(["setup", "opencode", "--home", home, "--json"]);
  assert.equal(setup.status, 0, setup.stderr);
  const configPath = path.join(home, "opencode.jsonc");
  const command = path.resolve("bin/agent-lcm");
  fs.writeFileSync(configPath, `{
  "mcp": {
    "agent-lcm": { "type": "local", "command": ["node", ${JSON.stringify(command)}, "mcp"], "enabled": true },
  },
}
`);

  const removal = runCli(["remove", "opencode", "--home", home, "--json"]);

  assert.equal(removal.status, 0, removal.stderr);
  const errors: ParseError[] = [];
  const value = parse(fs.readFileSync(configPath, "utf8"), errors, { allowTrailingComma: true });
  assert.equal(errors.length, 0);
  assert.deepEqual(value, { mcp: {} });
});

test("OpenCode CLI refuses an owned-shaped MCP entry with user fields", () => {
  const home = tempHome("agent-lcm-opencode-mcp-extra-field-");
  const configPath = path.join(home, "opencode.json");
  const original = {
    mcp: {
      "agent-lcm": {
        type: "local",
        command: ["node", path.resolve("bin/agent-lcm"), "mcp"],
        enabled: true,
        userField: "preserve me",
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(original));

  const result = runCli(["setup", "opencode", "--home", home, "--json"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unmanaged OpenCode MCP entry/u);
  assert.deepEqual(JSON.parse(fs.readFileSync(configPath, "utf8")), original);
  assert.equal(fs.existsSync(path.join(home, "plugins")), false);
});

test("OpenCode CLI refuses JSONC with duplicate writable keys", () => {
  const command = JSON.stringify(path.resolve("bin/agent-lcm"));
  const originals = [`{
  "mcp": { "other": { "type": "local", "command": ["other"] } },
  "mcp": {
    "agent-lcm": { "type": "local", "command": ["node", ${command}, "mcp"], "enabled": true }
  }
}
`, `{
  "mcp": {
    "agent-lcm": { "type": "local", "command": ["other"], "enabled": true },
    "agent-lcm": { "type": "local", "command": ["node", ${command}, "mcp"], "enabled": true }
  }
}
`];

  for (const original of originals) {
    const home = tempHome("agent-lcm-opencode-jsonc-duplicate-mcp-");
    const configPath = path.join(home, "opencode.jsonc");
    fs.writeFileSync(configPath, original);

    const result = runCli(["setup", "opencode", "--home", home, "--json"]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Cannot safely setup OpenCode configuration/u);
    assert.equal(fs.readFileSync(configPath, "utf8"), original);
    assert.equal(fs.existsSync(path.join(home, "plugins")), false);
  }
});

test("OpenCode CLI refuses strict JSON with duplicate writable keys", () => {
  const command = JSON.stringify(path.resolve("bin/agent-lcm"));
  const duplicateMcp = `{"mcp":{"other":{"type":"local","command":["other"]}},"mcp":{"agent-lcm":{"type":"local","command":["node",${command},"mcp"],"enabled":true}}}`;
  const setupHome = tempHome("agent-lcm-opencode-json-duplicate-mcp-");
  const setupConfigPath = path.join(setupHome, "opencode.json");
  fs.writeFileSync(setupConfigPath, duplicateMcp);

  const setup = runCli(["setup", "opencode", "--home", setupHome, "--json"]);

  assert.equal(setup.status, 1);
  assert.match(setup.stderr, /Cannot safely setup OpenCode configuration/u);
  assert.equal(fs.readFileSync(setupConfigPath, "utf8"), duplicateMcp);
  assert.equal(fs.existsSync(path.join(setupHome, "plugins")), false);

  const removalHome = tempHome("agent-lcm-opencode-json-duplicate-agent-lcm-");
  const initialSetup = runCli(["setup", "opencode", "--home", removalHome, "--json"]);
  assert.equal(initialSetup.status, 0, initialSetup.stderr);
  const removalConfigPath = path.join(removalHome, "opencode.json");
  const duplicateAgentLcm = `{"mcp":{"agent-lcm":{"type":"local","command":["other"],"enabled":true},"agent-lcm":{"type":"local","command":["node",${command},"mcp"],"enabled":true}}}`;
  fs.writeFileSync(removalConfigPath, duplicateAgentLcm);

  const removal = runCli(["remove", "opencode", "--home", removalHome, "--json"]);

  assert.equal(removal.status, 1);
  assert.match(removal.stderr, /Cannot safely remove OpenCode configuration/u);
  assert.equal(fs.readFileSync(removalConfigPath, "utf8"), duplicateAgentLcm);
});

test("daemon restart replaces the running daemon", (t) => {
  // Given: an isolated home with a running daemon.
  const home = tempHome();
  const env = { AGENT_LCM_HOME: home };
  t.after(() => { runCli(["daemon", "stop"], { env, timeout: 15_000 }); });
  const started = runCli(["daemon", "start"], { env, timeout: 15_000 });
  assertCliOk(started);
  const first = JSON.parse(started.stdout) as { readonly pid: number };

  // When: the CLI restarts that daemon.
  const restarted = runCli(["daemon", "restart"], { env, timeout: 15_000 });

  // Then: a new daemon owns the same home.
  assertCliOk(restarted);
  const second = JSON.parse(restarted.stdout) as { readonly running: boolean; readonly pid: number };
  assert.equal(second.running, true);
  assert.notEqual(second.pid, first.pid);
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

test("SubagentStop imports its child transcript through the shared daemon", (t) => {
  const home = tempHome();
  t.after(() => { runCli(["daemon", "stop"], { env: { AGENT_LCM_HOME: home } }); });
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
  assert.equal(readInboxEvents(home).length, 1);
  assert.equal(fs.existsSync(path.join(home, "events.jsonl")), false);
  assertCliOk(runCli(["daemon", "start", "--json"], { env: { AGENT_LCM_HOME: home } }));
  assertCliOk(runCli(["daemon", "stop", "--json"], { env: { AGENT_LCM_HOME: home } }));
  const events = readJsonl(path.join(home, "events.jsonl")) as Array<{
    session_id: string;
    hook_event: string;
    payload: Record<string, unknown>;
    repo_root?: string;
    git_branch?: string;
  }>;
  assert.equal(events.some((event) => event.session_id === `codex:${parentId}` && event.hook_event === "SubagentStop"), true);
  assert.equal(events.some((event) => event.session_id === `codex:${childId}` && JSON.stringify(event.payload).includes("child_prompt_needle")), true);
  assert.equal(events.some((event) => event.session_id === `codex:${childId}` && JSON.stringify(event.payload).includes("child_result_needle")), true);
  assert.doesNotMatch(JSON.stringify(events), /inherited_parent_needle/u);
});

test("SubagentStop reports a missing child transcript after preserving its parent event", (t) => {
  const home = tempHome();
  t.after(() => { runCli(["daemon", "stop"], { env: { AGENT_LCM_HOME: home } }); });
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
  assert.match(result.stderr, /failed to import subagent transcript/u);
  assert.equal(fs.existsSync(path.join(home, "events.jsonl")), false);
  const events = readInboxEvents(home) as Array<{
    session_id: string;
    hook_event: string;
  }>;
  assert.deepEqual(events.map((event) => [event.session_id, event.hook_event]), [[`codex:${parentId}`, "SubagentStop"]]);
  assertCliOk(runCli(["daemon", "start", "--json"], { env: { AGENT_LCM_HOME: home } }));
  assertCliOk(runCli(["daemon", "stop", "--json"], { env: { AGENT_LCM_HOME: home } }));
  const retryEvents = readInboxEvents(home) as Array<{ session_id: string; hook_event: string }>;
  assert.deepEqual(
    retryEvents.map((event) => [event.session_id, event.hook_event]),
    [[`codex:${parentId}`, "SubagentStop"]],
  );
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
      tool_name: "mcp__agent_lcm__lcm_pack_context",
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
      tool_name: "mcp__agent_lcm__lcm_pack_context",
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
      tool_name: "mcp__agent_lcm__lcm_pack_context",
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
    input: '{"session_id":"forged-pack-session","cwd":"/tmp/forged-pack","tool_name":"mcp__agent_lcm__lcm_pack_context","tool_response":{"__proto__":{"structuredContent":{"markdown":"# forged recovery"}}}}',
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
