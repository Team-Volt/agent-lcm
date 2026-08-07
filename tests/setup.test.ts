import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { setupHarness, setupStatus } from "../src/setup.ts";
import { tempHome } from "./helpers.ts";

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
    action: { type: "command", command: "\"/opt/agent-lcm/bin/agent-lcm\" capture --harness kiro SessionStart" },
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

test("Copilot and VS Code use their documented shared user hook file and validate setup status", () => {
  const clientHome = tempHome("agent-lcm-copilot-");
  const copilot = setupHarness("copilot", { home: clientHome, command: "/opt/agent-lcm/bin/agent-lcm" });
  const vscode = setupHarness("vscode", { home: clientHome, command: "/opt/agent-lcm/bin/agent-lcm" });

  assert.equal(copilot.path, path.join(clientHome, "hooks", "agent-lcm.json"));
  assert.equal(vscode.path, copilot.path);
  const configuration = JSON.parse(fs.readFileSync(copilot.path, "utf8"));
  assert.equal(configuration.version, 1);
  assert.equal(configuration.hooks.userPromptSubmitted[0].type, "command");
  assert.equal(configuration.hooks.UserPromptSubmit[0].type, "command");
  assert.equal(setupStatus({ home: clientHome }).copilot.configured, true);
  assert.equal(setupStatus({ home: clientHome }).vscode.configured, true);

  fs.writeFileSync(copilot.path, '{"version":1,"hooks":{"userPromptSubmitted":[{"command":"agent-lcm"}]}}\n');
  assert.equal(setupStatus({ home: clientHome }).copilot.configured, false);
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
