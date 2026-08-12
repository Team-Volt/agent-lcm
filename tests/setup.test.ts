import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { mutateSetupConfiguration } from "../src/setup-files.ts";
import { removeHarness, setupHarness, setupStatus } from "../src/setup.ts";
import { assertCliOk, runCli, tempHome } from "./helpers.ts";

const GUIDE_ROOT = "https://github.com/Team-Volt/agent-lcm/blob/main/docs/install";
const NO_CLI_ENV = { PATH: "" };
const PACKAGE_ROOT = path.resolve(".");

test("remove Codex deletes only exact owned hooks and is repeatable", (t) => {
  const fake = fakeSetupCli(t, "codex");
  const home = tempHome("agent-lcm-remove-codex-");
  const target = path.join(home, "hooks.json");
  const original = JSON.stringify({ owner: "user", hooks: {
    SessionStart: [{ matcher: "*", hooks: [
      { type: "command", command: 'node "/old/bin/agent-lcm" capture --harness codex SessionStart' },
      { type: "command", command: 'node "/old/bin/agent-lcm" capture --harness codex SessionStart extra', keep: true },
    ] }],
    PreToolUse: [{ matcher: ".*", hooks: [
      { type: "command", command: 'node "/old/bin/agent-lcm" hook PreToolUse' },
      { type: "command", command: 'node "/old/bin/agent-lcm" hook PostCompact', keep: true },
    ] }],
    CustomEvent: [{ hooks: [{ type: "command", command: "keep-custom" }] }],
  } });
  fs.writeFileSync(target, original);

  const first = removeHarness("codex", { home, env: fake.env });
  const second = removeHarness("codex", { home, env: fake.env });

  assert.deepEqual(first, {
    harness: "codex",
    action: "remove",
    status: "complete",
    nativeCli: "codex",
    hooks: { path: target, changed: true },
    guide: `${GUIDE_ROOT}/codex.md`,
  });
  assert.equal(second.hooks.changed, false);
  const configuration = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(configuration, { owner: "user", hooks: {
    SessionStart: [{ matcher: "*", hooks: [
      { type: "command", command: 'node "/old/bin/agent-lcm" capture --harness codex SessionStart extra', keep: true },
    ] }],
    PreToolUse: [{ matcher: ".*", hooks: [
      { type: "command", command: 'node "/old/bin/agent-lcm" hook PostCompact', keep: true },
    ] }],
    CustomEvent: [{ hooks: [{ type: "command", command: "keep-custom" }] }],
  } });
  assert.deepEqual(readSetupCalls(fake.log), [
    ["plugin", "list"],
    ["plugin", "remove", "agent-lcm@agent-lcm"],
    ["plugin", "list"],
    ["plugin", "remove", "agent-lcm@agent-lcm"],
  ]);
  assert.equal(fs.readdirSync(home).filter((name) => name.startsWith("hooks-pre-agent-lcm-")).length, 1);
  assert.equal(fs.readFileSync(path.join(home, fs.readdirSync(home).find((name) => name.startsWith("hooks-pre-agent-lcm-")) ?? ""), "utf8"), original);
});

test("remove Cursor and Kiro preserves adversarial near matches", () => {
  const cursorHome = tempHome("agent-lcm-remove-cursor-");
  const cursorTarget = path.join(cursorHome, "hooks.json");
  fs.writeFileSync(cursorTarget, JSON.stringify({ version: 1, hooks: {
    sessionStart: [
      { command: 'node "/old/bin/agent-lcm" capture --harness cursor SessionStart' },
      { command: 'node "/old/bin/agent-lcm" capture --harness codex SessionStart', keep: true },
    ],
  } }));
  const cursor = removeHarness("cursor", { home: cursorHome, env: NO_CLI_ENV });
  assert.equal(cursor.status, "manual-required");
  assert.equal(cursor.hooks.changed, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(cursorTarget, "utf8")).hooks.sessionStart, [
    { command: 'node "/old/bin/agent-lcm" capture --harness codex SessionStart', keep: true },
  ]);

  const kiroHome = tempHome("agent-lcm-remove-kiro-");
  const kiroTarget = path.join(kiroHome, "hooks", "agent-lcm.json");
  fs.mkdirSync(path.dirname(kiroTarget), { recursive: true });
  fs.writeFileSync(kiroTarget, JSON.stringify({ version: "v1", hooks: [
    { name: "agent-lcm-kiro-SessionStart", trigger: "SessionStart", action: { type: "command", command: 'node "/old/bin/agent-lcm" capture --harness kiro SessionStart' } },
    { name: "agent-lcm-kiro-SessionStart", trigger: "Stop", action: { type: "command", command: 'node "/old/bin/agent-lcm" capture --harness kiro SessionStart' }, keep: true },
    { name: "agent-lcm-kiro-Stop", trigger: "Stop", action: { type: "command", command: 'node "/old/bin/agent-lcm" capture --harness kiro Stop extra' }, keep: true },
  ] }));
  const kiro = removeHarness("kiro", { home: kiroHome, env: NO_CLI_ENV });
  assert.equal(kiro.status, "manual-required");
  assert.equal(kiro.hooks.changed, true);
  assert.equal(JSON.parse(fs.readFileSync(kiroTarget, "utf8")).hooks.length, 2);
});

test("remove shared harnesses retains byte-identical resources without spawning", (t) => {
  const fake = fakeSetupCli(t, "copilot");
  const home = tempHome("agent-lcm-remove-shared-");
  const target = path.join(home, "hooks", "agent-lcm.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = Buffer.from('{"version":1,"hooks":{"sessionStart":[{"command":"node \\"/old/bin/agent-lcm\\" capture --harness auto sessionStart"}]}}\n');
  fs.writeFileSync(target, original);

  const report = removeHarness("vscode", { home, env: fake.env });

  assert.equal(report.status, "shared-retained");
  assert.deepEqual(report.hooks, { path: target, changed: false });
  assert.deepEqual(fs.readFileSync(target), original);
  assert.equal(fs.existsSync(fake.log), false);
});

test("remove validates before native work and missing targets stay missing", (t) => {
  const fake = fakeSetupCli(t, "codex");
  const invalidHome = tempHome("agent-lcm-remove-invalid-");
  const invalidTarget = path.join(invalidHome, "hooks.json");
  const original = Buffer.from('{"hooks":{"SessionStart":"invalid"}}\n');
  fs.writeFileSync(invalidTarget, original);
  assert.throws(() => removeHarness("codex", { home: invalidHome, env: fake.env }), /invalid setup configuration/u);
  assert.deepEqual(fs.readFileSync(invalidTarget), original);
  assert.equal(fs.existsSync(fake.log), false);
  assert.deepEqual(fs.readdirSync(invalidHome), ["hooks.json"]);

  const missingHome = tempHome("agent-lcm-remove-missing-");
  const missing = removeHarness("kiro", { home: missingHome, env: NO_CLI_ENV });
  assert.equal(missing.hooks.changed, false);
  assert.equal(fs.existsSync(path.join(missingHome, "hooks")), false);
});

test("setup validates an existing hook schema before starting the native CLI", (t) => {
  // Given: malformed Codex hooks and a fake CLI that records every process start.
  const fake = fakeSetupCli(t, "codex");
  const clientHome = tempHome("agent-lcm-setup-order-");
  fs.writeFileSync(path.join(clientHome, "hooks.json"), '{"hooks":{"CustomEvent":"invalid"}}\n');

  // When: Codex setup is requested.
  const run = () => setupHarness("codex", {
    home: clientHome,
    command: "/opt/agent-lcm/bin/agent-lcm",
    env: fake.env,
  });

  // Then: validation fails and no native process starts.
  assert.throws(run, /invalid setup configuration/u);
  assert.equal(fs.existsSync(fake.log), false);
});

test("Codex setup uses native plugin hooks without creating user hooks", (t) => {
  // Given: a capable native Codex CLI and an empty Codex home.
  const fake = fakeSetupCli(t, "codex");
  const clientHome = tempHome("agent-lcm-codex-native-");

  // When: Codex setup completes.
  const report = setupHarness("codex", {
    home: clientHome,
    command: "/opt/agent-lcm/bin/agent-lcm",
    env: fake.env,
  });

  // Then: the native plugin owns hooks and no duplicate user hook file is created.
  assert.deepEqual(report, {
    harness: "codex",
    action: "setup",
    status: "complete",
    nativeCli: "codex",
    hooks: { path: path.join(clientHome, "hooks.json"), changed: false },
    guide: `${GUIDE_ROOT}/codex.md`,
  });
  assert.deepEqual(readSetupCalls(fake.log), [
    ["plugin", "list"],
    ["plugin", "marketplace", "add", PACKAGE_ROOT],
    ["plugin", "add", "agent-lcm@agent-lcm"],
  ]);
  assert.equal(fs.existsSync(path.join(clientHome, "hooks.json")), false);
});

test("Codex setup reports recoverable partial state when hooks change during native install", (t) => {
  const fake = fakeSetupCli(t, "codex");
  const clientHome = tempHome("agent-lcm-codex-race-");
  const target = path.join(clientHome, "hooks.json");
  fs.writeFileSync(target, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{
    type: "command",
    command: 'node "/old/bin/agent-lcm" capture --harness codex SessionStart',
  }] }] } }));

  const concurrent = JSON.stringify({ metadata: { user: true }, hooks: { SessionStart: [{ hooks: [{
    type: "command",
    command: 'node "/old/bin/agent-lcm" capture --harness codex SessionStart',
  }] }] } });
  assert.throws(() => setupHarness("codex", {
    home: clientHome,
    command: "/opt/agent-lcm/bin/agent-lcm",
    env: { ...fake.env, AGENT_LCM_FAKE_MUTATE_TARGET: target, AGENT_LCM_FAKE_MUTATE_CONTENT: concurrent },
  }), /Native codex setup completed.*concurrent change.*did not overwrite.*rerun agent-lcm setup codex/u);

  assert.equal(fs.readFileSync(target, "utf8"), concurrent);
  assert.deepEqual(readSetupCalls(fake.log), [
    ["plugin", "list"],
    ["plugin", "marketplace", "add", PACKAGE_ROOT],
    ["plugin", "add", "agent-lcm@agent-lcm"],
  ]);
});

test("Codex remove reports recoverable partial state when hooks appear during native removal", (t) => {
  const fake = fakeSetupCli(t, "codex");
  const clientHome = tempHome("agent-lcm-codex-remove-race-");
  const target = path.join(clientHome, "hooks.json");
  const concurrent = JSON.stringify({ metadata: { user: true }, hooks: {} });

  assert.throws(() => removeHarness("codex", {
    home: clientHome,
    env: { ...fake.env, AGENT_LCM_FAKE_MUTATE_TARGET: target, AGENT_LCM_FAKE_MUTATE_CONTENT: concurrent },
  }), /Native codex remove completed.*concurrent change.*did not overwrite.*rerun agent-lcm remove codex/u);

  assert.equal(fs.readFileSync(target, "utf8"), concurrent);
  assert.deepEqual(readSetupCalls(fake.log), [
    ["plugin", "list"],
    ["plugin", "remove", "agent-lcm@agent-lcm"],
  ]);
});

test("successful Copilot setup removes only legacy shared Agent LCM hooks", (t) => {
  // Given: a capable Copilot CLI and a shared hook file with owned and unrelated hooks.
  const fake = fakeSetupCli(t, "copilot");
  const clientHome = tempHome("agent-lcm-copilot-native-");
  const hooksPath = path.join(clientHome, "hooks", "agent-lcm.json");
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(hooksPath, JSON.stringify({ version: 1, hooks: {
    sessionStart: [
      { type: "command", command: 'node "/old/bin/agent-lcm" capture --harness auto sessionStart' },
      { type: "command", command: "keep-me" },
    ],
    userPromptSubmitted: [
      { type: "command", command: 'node "/old/bin/agent-lcm" capture --harness auto userPromptSubmitted' },
    ],
    PostToolUse: [
      { type: "command", command: 'node "/old/bin/agent-lcm" capture --harness vscode PostToolUse' },
    ],
    custom: [{ type: "command", command: "also-keep-me" }],
  } }));

  // When: native Copilot setup succeeds.
  const report = setupHarness("copilot", {
    home: clientHome,
    command: "/opt/agent-lcm/bin/agent-lcm",
    env: fake.env,
  });

  // Then: the legacy registration is removed without touching sibling hooks.
  assert.deepEqual(report, {
    harness: "copilot",
    action: "setup",
    status: "complete",
    nativeCli: "copilot",
    hooks: { path: hooksPath, changed: true },
    guide: `${GUIDE_ROOT}/copilot.md`,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(hooksPath, "utf8")), { version: 1, hooks: {
    sessionStart: [{ type: "command", command: "keep-me" }],
    userPromptSubmitted: [],
    PostToolUse: [],
    custom: [{ type: "command", command: "also-keep-me" }],
  } });
  assert.deepEqual(setupStatus({ home: clientHome }).copilot, {
    hooksConfigured: false,
    path: hooksPath,
  });
});

test("manual setup preserves legacy shared hooks and creates no target", (t) => {
  // Given: an empty PATH, one existing shared target, and one absent Cursor target.
  const emptyBin = fs.mkdtempSync(path.join(tempHome("agent-lcm-empty-cli-"), "bin"));
  t.after(() => fs.rmSync(path.dirname(emptyBin), { recursive: true, force: true }));
  const clientHome = tempHome("agent-lcm-manual-shared-");
  const hooksPath = path.join(clientHome, "hooks", "agent-lcm.json");
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  const original = '{"version":1,"hooks":{"sessionStart":[{"command":"node \\"/old/bin/agent-lcm\\" capture --harness auto sessionStart"}]}}\n';
  fs.writeFileSync(hooksPath, original);

  // When: shared and Cursor setup both require manual work.
  const shared = setupHarness("vscode", {
    home: clientHome,
    command: "/opt/agent-lcm/bin/agent-lcm",
    env: { PATH: emptyBin },
  });
  const cursorHome = tempHome("agent-lcm-manual-cursor-");
  const cursor = setupHarness("cursor", {
    home: cursorHome,
    command: "/opt/agent-lcm/bin/agent-lcm",
    env: { PATH: emptyBin },
  });

  // Then: both report manual work, preserving or omitting files as found.
  assert.equal(shared.status, "manual-required");
  assert.deepEqual(shared.hooks, { path: hooksPath, changed: false });
  assert.equal(fs.readFileSync(hooksPath, "utf8"), original);
  assert.equal(cursor.status, "manual-required");
  assert.deepEqual(cursor.hooks, { path: path.join(cursorHome, "hooks.json"), changed: false });
  assert.equal(fs.existsSync(path.join(cursorHome, "hooks.json")), false);
});

test("manual setup preserves a concurrent hook rewrite when no mutation is needed", (t) => {
  const fake = fakeSetupCli(t, "cursor-agent");
  const clientHome = tempHome("agent-lcm-cursor-manual-race-");
  const target = path.join(clientHome, "hooks.json");
  fs.writeFileSync(target, JSON.stringify({ version: 1, hooks: {} }));
  const concurrent = JSON.stringify({ version: 1, metadata: { user: true }, hooks: {} });

  const report = setupHarness("cursor", {
    home: clientHome,
    command: "/opt/agent-lcm/bin/agent-lcm",
    env: { ...fake.env, AGENT_LCM_FAKE_MUTATE_TARGET: target, AGENT_LCM_FAKE_MUTATE_CONTENT: concurrent },
  });

  assert.equal(report.status, "manual-required");
  assert.deepEqual(report.hooks, { path: target, changed: false });
  assert.equal(fs.readFileSync(target, "utf8"), concurrent);
  assert.deepEqual(readSetupCalls(fake.log), [["--version"]]);
});

test("Kiro setup reports a concurrent hook rewrite without claiming native install", (t) => {
  const fake = fakeSetupCli(t, "kiro-cli");
  const clientHome = tempHome("agent-lcm-kiro-race-");
  const target = path.join(clientHome, "hooks", "agent-lcm.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ version: "v1", hooks: [] }));
  const concurrent = JSON.stringify({ version: "v1", metadata: { user: true }, hooks: [] });

  assert.throws(() => setupHarness("kiro", {
    home: clientHome,
    command: "/opt/agent-lcm/bin/agent-lcm",
    env: { ...fake.env, AGENT_LCM_FAKE_MUTATE_TARGET: target, AGENT_LCM_FAKE_MUTATE_CONTENT: concurrent },
  }), /kiro setup stopped.*concurrent change.*did not overwrite.*rerun agent-lcm setup kiro/u);

  assert.equal(fs.readFileSync(target, "utf8"), concurrent);
  assert.deepEqual(readSetupCalls(fake.log), [["--version"]]);
});

test("Kiro setup uses the native array schema, is repeatable, and leaves sibling hooks unchanged", () => {
  const kiroHome = tempHome("agent-lcm-kiro-");
  const unrelatedKiroHook = path.join(kiroHome, "hooks", "other.json");
  fs.mkdirSync(path.dirname(unrelatedKiroHook), { recursive: true });
  fs.writeFileSync(unrelatedKiroHook, '{"version":"v1","hooks":[{"name":"other","trigger":"SessionStart","action":{"type":"command","command":"other"}}]}\n');
  const original = fs.readFileSync(unrelatedKiroHook);

  const first = setupHarness("kiro", { home: kiroHome, command: "/opt/agent-lcm/bin/agent-lcm", env: NO_CLI_ENV });
  const second = setupHarness("kiro", { home: kiroHome, command: "/opt/agent-lcm/bin/agent-lcm", env: NO_CLI_ENV });

  assert.equal(first.hooks.changed, true);
  assert.equal(second.hooks.changed, false);
  assert.equal(first.hooks.path, path.join(kiroHome, "hooks", "agent-lcm.json"));
  assert.deepEqual(fs.readFileSync(unrelatedKiroHook), original);
  const configuration = JSON.parse(fs.readFileSync(first.hooks.path, "utf8"));
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
    () => setupHarness("kiro", { home: kiroHome, command: "/opt/agent-lcm/bin/agent-lcm", env: NO_CLI_ENV }),
    new RegExp(setupPath.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"), "u"),
  );
  assert.deepEqual(fs.readFileSync(setupPath), original);
  assert.deepEqual(fs.readdirSync(path.dirname(setupPath)).sort(), ["agent-lcm.json"]);
});

test("setup rejects malformed Kiro schema without changing the owned file", () => {
  const kiroHome = tempHome("agent-lcm-kiro-schema-");
  const setupPath = path.join(kiroHome, "hooks", "agent-lcm.json");
  fs.mkdirSync(path.dirname(setupPath), { recursive: true });
  fs.writeFileSync(setupPath, '{"version":"v1","hooks":{}}\n');
  const original = fs.readFileSync(setupPath);

  assert.throws(() => setupHarness("kiro", { home: kiroHome, command: "/opt/agent-lcm/bin/agent-lcm", env: NO_CLI_ENV }), /invalid setup configuration/u);
  assert.deepEqual(fs.readFileSync(setupPath), original);
  assert.deepEqual(fs.readdirSync(path.dirname(setupPath)).sort(), ["agent-lcm.json"]);
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
  assert.deepEqual(fs.readdirSync(clientHome).sort(), ["hooks.json"]);
});

test("manual Copilot and VS Code setup creates no shared user hook configuration", () => {
  const clientHome = tempHome("agent-lcm-copilot-");
  const env = { PATH: path.join(clientHome, "empty-bin") };
  const copilot = setupHarness("copilot", { home: clientHome, command: "/opt/agent-lcm/bin/agent-lcm", env });
  const vscode = setupHarness("vscode", { home: clientHome, command: "/opt/agent-lcm/bin/agent-lcm", env });

  assert.equal(copilot.status, "manual-required");
  assert.equal(vscode.status, "manual-required");
  assert.equal(copilot.hooks.path, path.join(clientHome, "hooks", "agent-lcm.json"));
  assert.equal(vscode.hooks.path, copilot.hooks.path);
  assert.equal(vscode.hooks.changed, false);
  assert.equal(fs.existsSync(copilot.hooks.path), false);
});

test("native shared setup removes older Agent LCM registrations without touching sibling hooks", (t) => {
  const clientHome = tempHome("agent-lcm-copilot-legacy-");
  const fake = fakeSetupCli(t, "copilot");
  const setupPath = path.join(clientHome, "hooks", "agent-lcm.json");
  fs.mkdirSync(path.dirname(setupPath), { recursive: true });
  fs.writeFileSync(setupPath, JSON.stringify({
    version: 1,
    owner: "user",
    hooks: {
      UserPromptSubmit: [
        {
          type: "command",
          command: "\"/old-location/bin/agent-lcm\" capture --harness vscode UserPromptSubmit",
          timeout: 45,
          metadata: { keep: true },
        },
        {
          type: "command",
          command: "\"/older-location/bin/agent-lcm\" capture --harness copilot UserPromptSubmit",
          timeout: 60,
          metadata: { keep: "duplicate" },
        },
        { type: "command", command: "\"/opt/custom-agent-lcm\" capture --harness vscode UserPromptSubmit" },
      ],
      sessionStart: [{
        type: "command",
        command: 'node "/opt/not-agent-lcm" capture --harness auto sessionStart',
        timeout: 30,
        metadata: { owner: "user" },
      }],
      customEvent: [{ type: "command", command: "custom-hook", custom: true }],
      customCaptureEvent: [{
        type: "command",
        command: 'node "/opt/custom/agent-lcm" capture --harness vscode Stop',
        owner: "user",
      }],
    },
  }));

  const first = setupHarness("vscode", { home: clientHome, command: "/new-location/bin/agent-lcm", env: fake.env });
  const second = setupHarness("copilot", { home: clientHome, command: "/new-location/bin/agent-lcm", env: fake.env });
  const configuration = JSON.parse(fs.readFileSync(setupPath, "utf8"));

  assert.equal(first.hooks.changed, true);
  assert.equal(second.hooks.changed, false);
  assert.equal(configuration.owner, "user");
  assert.deepEqual(configuration.hooks.UserPromptSubmit, [
    { type: "command", command: "\"/opt/custom-agent-lcm\" capture --harness vscode UserPromptSubmit" },
  ]);
  assert.deepEqual(configuration.hooks.sessionStart[0], {
    type: "command",
    command: 'node "/opt/not-agent-lcm" capture --harness auto sessionStart',
    timeout: 30,
    metadata: { owner: "user" },
  });
  assert.equal(configuration.hooks.sessionStart.length, 1);
  assert.equal(configuration.hooks.userPromptSubmitted, undefined);
  assert.deepEqual(configuration.hooks.customEvent, [{ type: "command", command: "custom-hook", custom: true }]);
  assert.deepEqual(configuration.hooks.customCaptureEvent, [{
    type: "command",
    command: 'node "/opt/custom/agent-lcm" capture --harness vscode Stop',
    owner: "user",
  }]);
});

test("Codex setup removes old Agent LCM commands and preserves unrelated hooks", (t) => {
  const clientHome = tempHome("agent-lcm-codex-legacy-");
  const fake = fakeSetupCli(t, "codex");
  const setupPath = path.join(clientHome, "hooks.json");
  fs.mkdirSync(path.dirname(setupPath), { recursive: true });
  const original = JSON.stringify({ owner: "user", hooks: {
    SessionStart: [{ matcher: "*", hooks: [
      { type: "command", command: "\"/old/bin/agent-lcm\" capture --harness codex SessionStart", timeout: 15 },
      { type: "command", command: "other-hook", timeout: 30 },
    ] }],
    PostCompact: [{ matcher: "*", hooks: [
      { type: "command", command: "\"/old/bin/agent-lcm\" hook PostCompact", timeout: 15 },
      { type: "command", command: "other-post-compact-hook", timeout: 30 },
    ] }],
    PreToolUse: [{ matcher: "Read", hooks: [
      {
        type: "command",
        command: 'node "/opt/not-agent-lcm" capture --harness codex PreToolUse',
        timeout: 30,
        metadata: { owner: "user" },
      },
    ] }],
    CustomEvent: [{ hooks: [{
      type: "command",
      command: 'node "/opt/custom/agent-lcm" capture --harness codex Stop',
      owner: "user",
    }] }],
  } });
  fs.writeFileSync(setupPath, original);

  const first = setupHarness("codex", { home: clientHome, command: "/new/bin/agent-lcm", env: fake.env });
  const second = setupHarness("codex", { home: clientHome, command: "/new/bin/agent-lcm", env: fake.env });
  const configuration = JSON.parse(fs.readFileSync(setupPath, "utf8"));

  assert.equal(first.hooks.changed, true);
  assert.equal(second.hooks.changed, false);
  assert.equal(configuration.owner, "user");
  assert.deepEqual(configuration.hooks.SessionStart, [{ matcher: "*", hooks: [
    { type: "command", command: "other-hook", timeout: 30 },
  ] }]);
  assert.deepEqual(configuration.hooks.CustomEvent, [{ hooks: [{
    type: "command",
    command: 'node "/opt/custom/agent-lcm" capture --harness codex Stop',
    owner: "user",
  }] }]);
  assert.deepEqual(configuration.hooks.PostCompact, [{ matcher: "*", hooks: [
    { type: "command", command: "other-post-compact-hook", timeout: 30 },
  ] }]);
  assert.deepEqual(configuration.hooks.PreToolUse, [{ matcher: "Read", hooks: [
    {
      type: "command",
      command: 'node "/opt/not-agent-lcm" capture --harness codex PreToolUse',
      timeout: 30,
      metadata: { owner: "user" },
    },
  ] }]);
  assert.equal(configuration.hooks.PreCompact, undefined);
  assert.equal(configuration.hooks.SubagentStop, undefined);
  assert.equal(setupStatus({ home: clientHome }).codex.hooksConfigured, false);
  const backups = fs.readdirSync(clientHome).filter((name) => name.startsWith("hooks-pre-agent-lcm-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(clientHome, backups[0] ?? ""), "utf8"), original);
});

test("Cursor setup validates and preserves its legacy user hooks", () => {
  const clientHome = tempHome("agent-lcm-cursor-");
  const hooksPath = path.join(clientHome, "hooks.json");
  fs.writeFileSync(hooksPath, JSON.stringify({ version: 1, owner: "user", hooks: {
    stop: [{
      command: 'node "/opt/not-agent-lcm" capture --harness cursor Stop',
      timeout: 30,
      metadata: { owner: "user" },
    }],
  } }));
  const original = fs.readFileSync(hooksPath);
  const report = setupHarness("cursor", { home: clientHome, command: "/opt/agent-lcm/bin/agent-lcm", env: NO_CLI_ENV });

  assert.equal(report.hooks.path, path.join(clientHome, "hooks.json"));
  assert.equal(report.hooks.changed, false);
  assert.deepEqual(fs.readFileSync(report.hooks.path), original);
});

test("setup all configures only harnesses already installed for the user", () => {
  const userHome = tempHome("agent-lcm-detected-");
  fs.mkdirSync(path.join(userHome, ".codex"));

  const result = runCli(["setup", "all", "--json"], { env: { HOME: userHome, USERPROFILE: userHome, PATH: "" } });
  assert.equal(result.status, 2, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [{
    harness: "codex",
    action: "setup",
    status: "manual-required",
    nativeCli: null,
    hooks: { path: path.join(userHome, ".codex", "hooks.json"), changed: false },
    guide: `${GUIDE_ROOT}/codex.md`,
  }]);
  assert.equal(fs.existsSync(path.join(userHome, ".cursor")), false);
  assert.equal(fs.existsSync(path.join(userHome, ".copilot")), false);
  assert.equal(fs.existsSync(path.join(userHome, ".kiro")), false);
});

test("Claude setup, removal, and status never inspect or mutate settings", (t) => {
  const configDir = tempHome("agent-lcm-claude-config-");
  const settings = path.join(configDir, "settings.json");
  const original = Buffer.from("{not json\n");
  fs.writeFileSync(settings, original);
  const fake = fakeClaudeLifecycleCli(t);

  const setup = setupHarness("claude", { home: configDir, command: "not-an-absolute-command", env: fake.env });
  const status = setupStatus({ home: configDir }).claude;
  const remove = removeHarness("claude", { home: configDir, env: fake.env });

  assert.equal(setup.status, "complete");
  assert.equal(remove.status, "complete");
  assert.deepEqual(setup.hooks, { path: settings, changed: false });
  assert.deepEqual(remove.hooks, { path: settings, changed: false });
  assert.deepEqual(status, { hooksConfigured: false, path: settings });
  assert.deepEqual(fs.readFileSync(settings), original);
  assert.equal(fs.existsSync(path.join(configDir, "hooks")), false);
});

test("Claude setup does not follow a symlinked settings path", { skip: process.platform === "win32" }, (t) => {
  const configDir = tempHome("agent-lcm-claude-symlink-");
  const victim = path.join(tempHome("agent-lcm-claude-victim-"), "victim.json");
  fs.writeFileSync(victim, "victim bytes\n");
  fs.symlinkSync(victim, path.join(configDir, "settings.json"));
  const fake = fakeClaudeLifecycleCli(t);

  setupHarness("claude", { home: configDir, command: "/unused/agent-lcm", env: fake.env });

  assert.equal(fs.readFileSync(victim, "utf8"), "victim bytes\n");
  assert.equal(fs.readlinkSync(path.join(configDir, "settings.json")), victim);
  assert.equal(fs.existsSync(path.join(configDir, "hooks")), false);
});

test("Claude CLI --home sets only the Claude config directory lifecycle override", (t) => {
  const configDir = tempHome("agent-lcm-claude-cli-home-");
  const fake = fakeClaudeLifecycleCli(t);

  const result = runCli(["setup", "claude", "--home", configDir, "--json"], { env: fake.env });

  assertCliOk(result);
  const calls = readSetupCalls(fake.log) as Array<{ argv: string[]; claudeConfigDir: string | null }>;
  assert.equal(calls[0]?.claudeConfigDir, configDir);
  assert.deepEqual(calls.map((call) => call.argv), [
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "add", PACKAGE_ROOT, "--scope", "user"],
    ["plugin", "list", "--json"],
    ["plugin", "install", "agent-lcm@agent-lcm", "--scope", "user"],
  ]);
});

test("setup all detects a Claude config directory", (t) => {
  const userHome = tempHome("agent-lcm-detected-claude-");
  fs.mkdirSync(path.join(userHome, ".claude"));
  const fake = fakeClaudeLifecycleCli(t);

  const result = runCli(["setup", "all", "--json"], {
    env: { ...fake.env, HOME: userHome, USERPROFILE: userHome },
  });

  assertCliOk(result);
  const reports = JSON.parse(result.stdout);
  assert.deepEqual(reports.map((report: { harness: string }) => report.harness), ["claude"]);
  assert.equal(reports[0].hooks.path, path.join(userHome, ".claude", "settings.json"));
});

test("setup prints a clear result for people and keeps JSON output for scripts", () => {
  const userHome = tempHome("agent-lcm-output-");
  const text = runCli(["setup", "codex", "--home", userHome], { env: { PATH: "" } });
  assert.equal(text.status, 2, text.stderr);
  assert.match(text.stdout, /codex setup: manual-required/u);
  assert.match(text.stdout, /Native CLI unavailable/u);
  assert.match(text.stdout, new RegExp(`${GUIDE_ROOT}/codex\\.md`, "u"));

  const json = runCli(["setup", "codex", "--home", userHome, "--json"], { env: { PATH: "" } });
  assert.equal(json.status, 2, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), {
    harness: "codex",
    action: "setup",
    status: "manual-required",
    nativeCli: null,
    hooks: { path: path.join(userHome, "hooks.json"), changed: false },
    guide: `${GUIDE_ROOT}/codex.md`,
  });
});

test("CLI setup and remove use native Codex with an isolated explicit home", (t) => {
  const home = path.join(tempHome("agent-lcm-cli-native-"), "new-codex-home");
  const fake = fakeLifecycleCli(t, "codex");
  const env = { PATH: fake.path, AGENT_LCM_FAKE_LOG: fake.log };

  const setup = runCli(["setup", "codex", "--home", home, "--json"], { env });
  assertCliOk(setup);
  assert.equal(JSON.parse(setup.stdout).status, "complete");

  const remove = runCli(["remove", "codex", "--home", home, "--json"], { env });
  assertCliOk(remove);
  assert.deepEqual(JSON.parse(remove.stdout), {
    harness: "codex",
    action: "remove",
    status: "complete",
    nativeCli: "codex",
    hooks: { path: path.join(home, "hooks.json"), changed: false },
    guide: `${GUIDE_ROOT}/codex.md`,
  });

  const calls = fs.readFileSync(fake.log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.argv), [
    ["plugin", "list"],
    ["plugin", "marketplace", "add", PACKAGE_ROOT],
    ["plugin", "add", "agent-lcm@agent-lcm"],
    ["plugin", "list"],
    ["plugin", "remove", "agent-lcm@agent-lcm"],
  ]);
  for (const call of calls) assert.deepEqual(call.env, {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: home,
    COPILOT_HOME: home,
    AGENT_LCM_HOME: path.join(home, "agent-lcm"),
  });
});

test("CLI reports a native probe failure without writing hooks or leaking stderr", (t) => {
  const home = path.join(tempHome("agent-lcm-cli-probe-failure-"), "new-codex-home");
  const fake = fakeLifecycleCli(t, "codex", true);

  const result = runCli(["setup", "codex", "--home", home, "--json"], {
    env: { PATH: fake.path, AGENT_LCM_FAKE_LOG: fake.log },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /status=23 stderr=suppressed/u);
  assert.doesNotMatch(result.stderr, /secret-token/u);
  assert.equal(fs.existsSync(path.join(home, "hooks.json")), false);
});

test("CLI remove reports unsupported native removal without changing shared resources", () => {
  const home = tempHome("agent-lcm-cli-shared-");
  const target = path.join(home, "hooks", "agent-lcm.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const original = Buffer.from('{"version":1,"hooks":{}}\n');
  fs.writeFileSync(target, original);

  const result = runCli(["remove", "vscode", "--home", home]);

  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stdout, /vscode remove: shared-retained/u);
  assert.match(result.stdout, new RegExp(`${GUIDE_ROOT}/vscode\\.md`, "u"));
  assert.deepEqual(fs.readFileSync(target), original);
});

test("setup never overwrites an existing timestamped backup", (t) => {
  const clientHome = tempHome("agent-lcm-backup-collision-");
  const fake = fakeSetupCli(t, "codex");
  const setupPath = path.join(clientHome, "hooks.json");
  const original = '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"node \\\"/old/bin/agent-lcm\\\" capture --harness codex SessionStart"}]}]}}\n';
  const timestamp = "2026-08-07T12-34-56-789Z";
  const firstBackup = path.join(clientHome, `hooks-pre-agent-lcm-${timestamp}.json`);
  const nextBackup = path.join(clientHome, `hooks-pre-agent-lcm-${timestamp}-1.json`);
  fs.writeFileSync(setupPath, original);
  fs.writeFileSync(firstBackup, "existing backup");
  const originalToISOString = Date.prototype.toISOString;
  Date.prototype.toISOString = () => "2026-08-07T12:34:56.789Z";
  try {
    setupHarness("codex", { home: clientHome, command: "/opt/agent-lcm/bin/agent-lcm", env: fake.env });
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

  mutateSetupConfiguration(setupPath, () => ({ hooks: {} }));

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
      action: {
        type: "command",
        command: "\"/old/bin/agent-lcm\" capture --harness kiro SessionStart",
        timeout: 45,
      },
      metadata: { keep: true },
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
      action: {
        type: "command",
        command: 'node "/opt/not-agent-lcm" capture --harness kiro PostToolUse',
        timeout: 45,
      },
      metadata: { owner: "user" },
    },
    {
      name: "agent-lcm-kiro-SessionStart",
      trigger: "SessionStart",
      action: {
        type: "command",
        command: "\"/older/bin/agent-lcm\" capture --harness kiro SessionStart",
        timeout: 60,
      },
      metadata: { keep: "duplicate" },
    },
  ] }));

  setupHarness("kiro", { home: clientHome, command: "/new/bin/agent-lcm", env: NO_CLI_ENV });
  const configuration = JSON.parse(fs.readFileSync(setupPath, "utf8"));
  assert.equal(configuration.owner, "user");
  assert.equal(configuration.hooks[0].action.command, "node \"/new/bin/agent-lcm\" capture --harness kiro SessionStart");
  assert.equal(configuration.hooks[0].action.timeout, 45);
  assert.deepEqual(configuration.hooks[0].metadata, { keep: true });
  assert.deepEqual(configuration.hooks[1], {
    name: "other-hook",
    trigger: "Stop",
    action: { type: "command", command: "other-command", timeout: 30 },
    custom: true,
  });
  assert.deepEqual(configuration.hooks[2], {
    name: "agent-lcm-kiro-PostToolUse",
    trigger: "PostToolUse",
    action: {
      type: "command",
      command: 'node "/opt/not-agent-lcm" capture --harness kiro PostToolUse',
      timeout: 45,
    },
    metadata: { owner: "user" },
  });
  assert.equal(configuration.hooks[3].action.command, "node \"/new/bin/agent-lcm\" capture --harness kiro SessionStart");
  assert.equal(configuration.hooks[3].action.timeout, 60);
  assert.deepEqual(configuration.hooks[3].metadata, { keep: "duplicate" });
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

function fakeSetupCli(
  t: test.TestContext,
  name: "codex" | "copilot" | "cursor-agent" | "kiro-cli",
): { readonly env: NodeJS.ProcessEnv; readonly log: string } {
  const bin = fs.mkdtempSync(path.join(tempHome("agent-lcm-setup-cli-parent-"), "bin-"));
  const log = path.join(bin, "calls.jsonl");
  const script = `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst argv = process.argv.slice(2);\nfs.appendFileSync(process.env.AGENT_LCM_FAKE_LOG, JSON.stringify(argv) + "\\n");\nif (process.env.AGENT_LCM_FAKE_MUTATE_TARGET && (JSON.stringify(argv) === JSON.stringify(["plugin", "list"]) || JSON.stringify(argv) === JSON.stringify(["--version"]))) fs.writeFileSync(process.env.AGENT_LCM_FAKE_MUTATE_TARGET, process.env.AGENT_LCM_FAKE_MUTATE_CONTENT);\n`;
  writeFakeSetupCli(bin, name, script);
  t.after(() => fs.rmSync(path.dirname(bin), { recursive: true, force: true }));
  return {
    env: { AGENT_LCM_FAKE_LOG: log, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    log,
  };
}

function fakeLifecycleCli(
  t: test.TestContext,
  name: "codex" | "copilot",
  failProbe = false,
): { readonly path: string; readonly log: string } {
  const bin = fs.mkdtempSync(path.join(tempHome("agent-lcm-lifecycle-cli-parent-"), "bin-"));
  const log = path.join(bin, "calls.jsonl");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
if (!fs.existsSync(process.env.CODEX_HOME)) process.exit(24);
fs.appendFileSync(process.env.AGENT_LCM_FAKE_LOG, JSON.stringify({ argv: process.argv.slice(2), env: { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, COPILOT_HOME: process.env.COPILOT_HOME, AGENT_LCM_HOME: process.env.AGENT_LCM_HOME } }) + "\\n");
if (${String(failProbe)} && JSON.stringify(process.argv.slice(2)) === JSON.stringify(["plugin", "list"])) { process.stderr.write("secret-token\\n"); process.exit(23); }
`;
  writeFakeSetupCli(bin, name, script);
  t.after(() => fs.rmSync(path.dirname(bin), { recursive: true, force: true }));
  return {
    path: `${bin}${path.delimiter}${path.dirname(process.execPath)}`,
    log,
  };
}

function fakeClaudeLifecycleCli(t: test.TestContext): { readonly env: NodeJS.ProcessEnv; readonly log: string; readonly path: string } {
  const bin = fs.mkdtempSync(path.join(tempHome("agent-lcm-claude-lifecycle-parent-"), "bin-"));
  const log = path.join(bin, "calls.jsonl");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.AGENT_LCM_FAKE_LOG, JSON.stringify({ argv, claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null }) + "\\n");
if (JSON.stringify(argv) === JSON.stringify(["plugin", "marketplace", "list", "--json"])) process.stdout.write("[]");
if (JSON.stringify(argv) === JSON.stringify(["plugin", "list", "--json"])) process.stdout.write("[]");
`;
  writeFakeSetupCli(bin, "claude", script);
  t.after(() => fs.rmSync(path.dirname(bin), { recursive: true, force: true }));
  const executablePath = `${bin}${path.delimiter}${path.dirname(process.execPath)}`;
  return { env: { AGENT_LCM_FAKE_LOG: log, PATH: executablePath }, log, path: executablePath };
}

function writeFakeSetupCli(bin: string, name: string, script: string): void {
  if (process.platform === "win32") {
    const source = path.join(bin, `${name}.cjs`);
    fs.writeFileSync(source, script.replace(/^#![^\n]*\n/u, ""));
    fs.writeFileSync(path.join(bin, `${name}.cmd`), `@"${process.execPath}" "${source}" %*\r\n`);
    return;
  }
  fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
}

function readSetupCalls(log: string): unknown[] {
  return fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
}
