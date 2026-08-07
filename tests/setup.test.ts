import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { writeSetupConfiguration } from "../src/setup-files.ts";
import { setupHarness, setupStatus } from "../src/setup.ts";
import { assertCliOk, runCli, tempHome } from "./helpers.ts";

test("Kiro setup uses the native array schema, is repeatable, and leaves sibling hooks unchanged", () => {
  const kiroHome = tempHome("agent-lcm-kiro-");
  const unrelatedKiroHook = path.join(kiroHome, "hooks", "other.json");
  fs.mkdirSync(path.dirname(unrelatedKiroHook), { recursive: true });
  fs.writeFileSync(unrelatedKiroHook, '{"version":"v1","hooks":[{"name":"other","trigger":"SessionStart","action":{"type":"command","command":"other"}}]}\n');
  const original = fs.readFileSync(unrelatedKiroHook);

  const first = setupHarness("kiro", { home: kiroHome, command: "/opt/agent-lcm/bin/agent-lcm" });
  const second = setupHarness("kiro", { home: kiroHome, command: "/opt/agent-lcm/bin/agent-lcm" });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(first.path, path.join(kiroHome, "hooks", "agent-lcm.json"));
  assert.deepEqual(fs.readFileSync(unrelatedKiroHook), original);
  const configuration = JSON.parse(fs.readFileSync(first.path, "utf8"));
  assert.equal(configuration.version, "v1");
  assert.equal(Array.isArray(configuration.hooks), true);
  assert.equal(configuration.hooks.length, 4);
  assert.deepEqual(configuration.hooks[0], {
    name: "agent-lcm-kiro-SessionStart",
    trigger: "SessionStart",
    action: { type: "command", command: "node \"/opt/agent-lcm/bin/agent-lcm\" capture --harness kiro SessionStart" },
  });
});

test("setup leaves invalid owned configuration untouched", () => {
  const kiroHome = tempHome("agent-lcm-kiro-invalid-");
  const setupPath = path.join(kiroHome, "hooks", "agent-lcm.json");
  fs.mkdirSync(path.dirname(setupPath), { recursive: true });
  fs.writeFileSync(setupPath, "{not json");
  const original = fs.readFileSync(setupPath);

  assert.throws(
    () => setupHarness("kiro", { home: kiroHome, command: "/opt/agent-lcm/bin/agent-lcm" }),
    new RegExp(setupPath.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"), "u"),
  );
  assert.deepEqual(fs.readFileSync(setupPath), original);
});

test("setup rejects malformed Kiro schema without changing the owned file", () => {
  const kiroHome = tempHome("agent-lcm-kiro-schema-");
  const setupPath = path.join(kiroHome, "hooks", "agent-lcm.json");
  fs.mkdirSync(path.dirname(setupPath), { recursive: true });
  fs.writeFileSync(setupPath, '{"version":"v1","hooks":{}}\n');
  const original = fs.readFileSync(setupPath);

  assert.throws(() => setupHarness("kiro", { home: kiroHome, command: "/opt/agent-lcm/bin/agent-lcm" }), /invalid setup configuration/u);
  assert.deepEqual(fs.readFileSync(setupPath), original);
});

test("setup rejects malformed Codex custom events without changing or backing up the file", () => {
  const clientHome = tempHome("agent-lcm-codex-schema-");
  const setupPath = path.join(clientHome, "hooks.json");
  const original = Buffer.from('{"hooks":{"CustomEvent":"invalid"}}\n');
  fs.writeFileSync(setupPath, original);

  assert.throws(
    () => setupHarness("codex", { home: clientHome, command: "/opt/agent-lcm/bin/agent-lcm" }),
    /invalid setup configuration/u,
  );
  assert.deepEqual(fs.readFileSync(setupPath), original);
  assert.deepEqual(fs.readdirSync(clientHome), ["hooks.json"]);
});

test("Copilot and VS Code converge on one lower-camel shared user hook configuration", () => {
  const clientHome = tempHome("agent-lcm-copilot-");
  const copilot = setupHarness("copilot", { home: clientHome, command: "/opt/agent-lcm/bin/agent-lcm" });
  const vscode = setupHarness("vscode", { home: clientHome, command: "/opt/agent-lcm/bin/agent-lcm" });

  assert.equal(copilot.path, path.join(clientHome, "hooks", "agent-lcm.json"));
  assert.equal(vscode.path, copilot.path);
  assert.equal(vscode.changed, false);
  const configuration = JSON.parse(fs.readFileSync(copilot.path, "utf8"));
  assert.equal(configuration.version, 1);
  assert.equal(configuration.hooks.userPromptSubmitted[0].type, "command");
  assert.equal(
    configuration.hooks.userPromptSubmitted[0].command,
    'node "/opt/agent-lcm/bin/agent-lcm" capture --harness auto userPromptSubmitted',
  );
  assert.deepEqual(Object.keys(configuration.hooks).sort(), ["postToolUse", "sessionEnd", "sessionStart", "userPromptSubmitted"]);
  assert.equal(setupStatus({ home: clientHome }).copilot.configured, true);
  assert.equal(setupStatus({ home: clientHome }).vscode.configured, true);

  fs.writeFileSync(copilot.path, '{"version":1,"hooks":{"userPromptSubmitted":[{"command":"agent-lcm"}]}}\n');
  assert.equal(setupStatus({ home: clientHome }).copilot.configured, false);
});

test("shared setup replaces older Agent LCM registrations after a binary move without touching sibling hooks", () => {
  const clientHome = tempHome("agent-lcm-copilot-legacy-");
  const setupPath = path.join(clientHome, "hooks", "agent-lcm.json");
  fs.mkdirSync(path.dirname(setupPath), { recursive: true });
  fs.writeFileSync(setupPath, JSON.stringify({
    version: 1,
    owner: "user",
    hooks: {
      UserPromptSubmit: [
        { type: "command", command: "\"/old-location/bin/agent-lcm\" capture --harness vscode UserPromptSubmit" },
        { type: "command", command: "\"/opt/custom-agent-lcm\" capture --harness vscode UserPromptSubmit" },
      ],
      sessionStart: [{ type: "command", command: "other-hook", timeout: 30 }],
      customEvent: [{ type: "command", command: "custom-hook", custom: true }],
      customCaptureEvent: [{
        type: "command",
        command: 'node "/opt/custom/agent-lcm" capture --harness vscode Stop',
        owner: "user",
      }],
    },
  }));

  const first = setupHarness("vscode", { home: clientHome, command: "/new-location/bin/agent-lcm" });
  const second = setupHarness("copilot", { home: clientHome, command: "/new-location/bin/agent-lcm" });
  const configuration = JSON.parse(fs.readFileSync(setupPath, "utf8"));

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(configuration.owner, "user");
  assert.deepEqual(configuration.hooks.UserPromptSubmit, [
    { type: "command", command: "\"/opt/custom-agent-lcm\" capture --harness vscode UserPromptSubmit" },
  ]);
  assert.deepEqual(configuration.hooks.sessionStart[0], { type: "command", command: "other-hook", timeout: 30 });
  assert.equal(configuration.hooks.sessionStart[1].command, "node \"/new-location/bin/agent-lcm\" capture --harness auto sessionStart");
  assert.deepEqual(configuration.hooks.customEvent, [{ type: "command", command: "custom-hook", custom: true }]);
  assert.deepEqual(configuration.hooks.customCaptureEvent, [{
    type: "command",
    command: 'node "/opt/custom/agent-lcm" capture --harness vscode Stop',
    owner: "user",
  }]);
});

test("Codex setup replaces its old Agent LCM commands and preserves unrelated hooks", () => {
  const clientHome = tempHome("agent-lcm-codex-legacy-");
  const setupPath = path.join(clientHome, "hooks.json");
  fs.mkdirSync(path.dirname(setupPath), { recursive: true });
  const original = JSON.stringify({ owner: "user", hooks: {
    SessionStart: [{ matcher: "*", hooks: [
      { type: "command", command: "\"/old/bin/agent-lcm\" capture --harness codex SessionStart", timeout: 15 },
      { type: "command", command: "other-hook", timeout: 30 },
    ] }],
    CustomEvent: [{ hooks: [{
      type: "command",
      command: 'node "/opt/custom/agent-lcm" capture --harness codex Stop',
      owner: "user",
    }] }],
  } });
  fs.writeFileSync(setupPath, original);

  const first = setupHarness("codex", { home: clientHome, command: "/new/bin/agent-lcm" });
  const second = setupHarness("codex", { home: clientHome, command: "/new/bin/agent-lcm" });
  const configuration = JSON.parse(fs.readFileSync(setupPath, "utf8"));

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(configuration.owner, "user");
  assert.deepEqual(configuration.hooks.SessionStart, [{ matcher: "*", hooks: [
    {
      type: "command",
      command: "node \"/new/bin/agent-lcm\" capture --harness codex SessionStart",
      timeout: 15,
    },
    { type: "command", command: "other-hook", timeout: 30 },
  ] }]);
  assert.deepEqual(configuration.hooks.CustomEvent, [{ hooks: [{
    type: "command",
    command: 'node "/opt/custom/agent-lcm" capture --harness codex Stop',
    owner: "user",
  }] }]);
  const backups = fs.readdirSync(clientHome).filter((name) => name.startsWith("hooks-pre-agent-lcm-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(clientHome, backups[0] ?? ""), "utf8"), original);
});

test("Cursor setup writes the user hooks file in Cursor's native schema", () => {
  const clientHome = tempHome("agent-lcm-cursor-");
  const hooksPath = path.join(clientHome, "hooks.json");
  fs.writeFileSync(hooksPath, JSON.stringify({ version: 1, owner: "user", hooks: {
    stop: [{ command: "other-hook", timeout: 30 }],
  } }));
  const report = setupHarness("cursor", { home: clientHome, command: "/opt/agent-lcm/bin/agent-lcm" });

  assert.equal(report.path, path.join(clientHome, "hooks.json"));
  assert.deepEqual(JSON.parse(fs.readFileSync(report.path, "utf8")), {
    version: 1,
    owner: "user",
    hooks: {
      sessionStart: [{ command: 'node "/opt/agent-lcm/bin/agent-lcm" capture --harness cursor SessionStart' }],
      beforeSubmitPrompt: [{ command: 'node "/opt/agent-lcm/bin/agent-lcm" capture --harness cursor UserPromptSubmit' }],
      postToolUse: [{ command: 'node "/opt/agent-lcm/bin/agent-lcm" capture --harness cursor PostToolUse' }],
      stop: [
        { command: "other-hook", timeout: 30 },
        { command: 'node "/opt/agent-lcm/bin/agent-lcm" capture --harness cursor Stop' },
      ],
    },
  });
});

test("setup all configures only harnesses already installed for the user", () => {
  const userHome = tempHome("agent-lcm-detected-");
  fs.mkdirSync(path.join(userHome, ".codex"));

  const result = runCli(["setup", "all", "--json"], { env: { HOME: userHome, USERPROFILE: userHome } });
  assertCliOk(result);
  assert.deepEqual(JSON.parse(result.stdout), [{
    harness: "codex",
    path: path.join(userHome, ".codex", "hooks.json"),
    changed: true,
  }]);
  assert.equal(fs.existsSync(path.join(userHome, ".cursor")), false);
  assert.equal(fs.existsSync(path.join(userHome, ".copilot")), false);
  assert.equal(fs.existsSync(path.join(userHome, ".kiro")), false);
});

test("setup prints a clear result for people and keeps JSON output for scripts", () => {
  const userHome = tempHome("agent-lcm-output-");
  const text = runCli(["setup", "codex", "--home", userHome]);
  assertCliOk(text);
  assert.equal(text.stdout, `codex hooks have been configured: ${path.join(userHome, "hooks.json")}\n`);

  const json = runCli(["setup", "codex", "--home", userHome, "--json"]);
  assertCliOk(json);
  assert.deepEqual(JSON.parse(json.stdout), {
    harness: "codex",
    path: path.join(userHome, "hooks.json"),
    changed: false,
  });
});

test("setup never overwrites an existing timestamped backup", () => {
  const clientHome = tempHome("agent-lcm-backup-collision-");
  const setupPath = path.join(clientHome, "hooks.json");
  const original = '{"hooks":{}}\n';
  const timestamp = "2026-08-07T12-34-56-789Z";
  const firstBackup = path.join(clientHome, `hooks-pre-agent-lcm-${timestamp}.json`);
  const nextBackup = path.join(clientHome, `hooks-pre-agent-lcm-${timestamp}-1.json`);
  fs.writeFileSync(setupPath, original);
  fs.writeFileSync(firstBackup, "existing backup");
  const originalToISOString = Date.prototype.toISOString;
  Date.prototype.toISOString = () => "2026-08-07T12:34:56.789Z";
  try {
    setupHarness("codex", { home: clientHome, command: "/opt/agent-lcm/bin/agent-lcm" });
  } finally {
    Date.prototype.toISOString = originalToISOString;
  }

  assert.equal(fs.readFileSync(firstBackup, "utf8"), "existing backup");
  assert.equal(fs.readFileSync(nextBackup, "utf8"), original);
});

test("setup writes never follow a predictable temporary symlink", { skip: process.platform === "win32" }, () => {
  const clientHome = tempHome("agent-lcm-temp-symlink-");
  const setupPath = path.join(clientHome, "hooks.json");
  const victim = path.join(clientHome, "victim.txt");
  fs.writeFileSync(victim, "do not overwrite");
  fs.symlinkSync(victim, `${setupPath}.${process.pid}.tmp`);

  writeSetupConfiguration(setupPath, { hooks: {} });

  assert.equal(fs.readFileSync(victim, "utf8"), "do not overwrite");
  assert.deepEqual(JSON.parse(fs.readFileSync(setupPath, "utf8")), { hooks: {} });
});

test("Kiro setup updates its owned hooks after a binary move", () => {
  const clientHome = tempHome("agent-lcm-kiro-legacy-");
  const setupPath = path.join(clientHome, "hooks", "agent-lcm.json");
  fs.mkdirSync(path.dirname(setupPath), { recursive: true });
  fs.writeFileSync(setupPath, JSON.stringify({ version: "v1", owner: "user", hooks: [
    {
      name: "agent-lcm-kiro-SessionStart",
      trigger: "SessionStart",
      action: { type: "command", command: "\"/old/bin/agent-lcm\" capture --harness kiro SessionStart" },
    },
    {
      name: "other-hook",
      trigger: "Stop",
      action: { type: "command", command: "other-command", timeout: 30 },
      custom: true,
    },
    {
      name: "agent-lcm-kiro-PostToolUse",
      trigger: "PostToolUse",
      action: { type: "command", command: "user-owned-command", timeout: 45 },
      metadata: { owner: "user" },
    },
  ] }));

  setupHarness("kiro", { home: clientHome, command: "/new/bin/agent-lcm" });
  const configuration = JSON.parse(fs.readFileSync(setupPath, "utf8"));
  assert.equal(configuration.owner, "user");
  assert.equal(configuration.hooks[0].action.command, "node \"/new/bin/agent-lcm\" capture --harness kiro SessionStart");
  assert.deepEqual(configuration.hooks[1], {
    name: "other-hook",
    trigger: "Stop",
    action: { type: "command", command: "other-command", timeout: 30 },
    custom: true,
  });
  assert.deepEqual(configuration.hooks[2], {
    name: "agent-lcm-kiro-PostToolUse",
    trigger: "PostToolUse",
    action: { type: "command", command: "user-owned-command", timeout: 45 },
    metadata: { owner: "user" },
  });
});

test("setup rejects shell-sensitive binary paths before writing a hook file", () => {
  const clientHome = tempHome("agent-lcm-command-");
  const setupPath = path.join(clientHome, "hooks", "agent-lcm.json");

  assert.throws(
    () => setupHarness("copilot", { home: clientHome, command: '/opt/agent-lcm/bin/agent-lcm"; touch unsafe' }),
    /unsafe shell characters/u,
  );
  assert.equal(fs.existsSync(setupPath), false);
});

test("setup requires an absolute installed binary path", () => {
  const clientHome = tempHome("agent-lcm-relative-command-");

  assert.throws(
    () => setupHarness("copilot", { home: clientHome, command: "agent-lcm" }),
    /absolute binary path/u,
  );
  assert.equal(fs.existsSync(path.join(clientHome, "hooks", "agent-lcm.json")), false);
});
