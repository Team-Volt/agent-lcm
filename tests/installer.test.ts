import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { readStatus } from "../src/installer.ts";
import { assertCliOk, runCli, tempHome } from "./helpers.ts";

test("status reads Codex home and reports absent wiring", () => {
  const codexHome = tempHome();
  fs.writeFileSync(path.join(codexHome, "config.toml"), "[features]\nhooks = true\n");
  fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify({ hooks: {} }, null, 2));

  const result = runCli(["status", "--codex-home", codexHome, "--json"]);

  assertCliOk(result);
  const status = JSON.parse(result.stdout);
  assert.equal(status.codex_home, codexHome);
  assert.equal(status.config_exists, true);
  assert.equal(status.hooks_json_exists, true);
  assert.equal(status.marketplace_configured, false);
  assert.equal(status.plugin_configured, false);
  assert.equal(status.plugin_manifest_available, true);
  assert.equal(status.plugin_declares_mcp, true);
  assert.equal(status.plugin_declares_hooks, true);
  assert.equal(status.mcp_manifest_available, true);
  assert.equal(status.hook_manifest_available, true);
  assert.equal(status.manual_mcp_configured, false);
  assert.equal(status.manual_hooks_configured, false);
  assert.equal(status.mcp_configured, false);
  assert.equal(status.hooks_configured, false);
  assert.equal(status.recall_skill_available, true);
});

test("status does not claim native hooks when the portable manifest wins", () => {
  const codexHome = tempHome();
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    [
      "[marketplaces.agent-lcm]",
      'source_type = "local"',
      `source = ${JSON.stringify(path.resolve("../.."))}`,
      "",
      '[plugins."other@other"]',
      "enabled = false",
      "",
      "[plugins.\"agent-lcm@agent-lcm\"]",
      "enabled = true",
      'path = "/tmp/agent-lcm"',
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify({ hooks: {} }, null, 2));

  const result = runCli(["status", "--codex-home", codexHome, "--json"]);

  assertCliOk(result);
  const status = JSON.parse(result.stdout);
  assert.equal(status.marketplace_configured, true);
  assert.equal(status.plugin_configured, true);
  assert.equal(status.plugin_manifest_available, true);
  assert.equal(status.plugin_declares_mcp, true);
  assert.equal(status.plugin_declares_hooks, true);
  assert.equal(status.mcp_manifest_available, true);
  assert.equal(status.hook_manifest_available, true);
  assert.equal(status.manual_mcp_configured, false);
  assert.equal(status.manual_hooks_configured, false);
  assert.equal(status.mcp_configured, true);
  assert.equal(status.hooks_configured, false);
  assert.equal(status.recall_skill_available, true);
});

test("status recognizes packed Codex-native plugin wiring", () => {
  const codexHome = tempHome();
  const root = tempHome();
  fs.mkdirSync(path.join(root, ".codex-plugin"));
  fs.mkdirSync(path.join(root, "hooks"));
  fs.mkdirSync(path.join(root, "skills", "lcm-recall"), { recursive: true });
  fs.copyFileSync(".codex-plugin/plugin.json", path.join(root, ".codex-plugin", "plugin.json"));
  fs.copyFileSync(".mcp.json", path.join(root, ".mcp.json"));
  fs.copyFileSync("hooks/codex.json", path.join(root, "hooks", "codex.json"));
  fs.copyFileSync("skills/lcm-recall/SKILL.md", path.join(root, "skills", "lcm-recall", "SKILL.md"));
  fs.writeFileSync(path.join(codexHome, "config.toml"), '[plugins."agent-lcm@agent-lcm"]\nenabled = true\n');

  const status = readStatus({ codexHome, root });

  assert.equal(status.plugin_configured, true);
  assert.equal(status.mcp_configured, true);
  assert.equal(status.hooks_configured, true);
});

test("status treats an explicitly disabled native plugin as disabled", () => {
  const codexHome = tempHome();
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    [
      "[plugins.\"agent-lcm@agent-lcm\"]",
      "enabled = false",
      'path = "/tmp/agent-lcm"',
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify({ hooks: {} }, null, 2));

  const result = runCli(["status", "--codex-home", codexHome, "--json"]);

  assertCliOk(result);
  const status = JSON.parse(result.stdout);
  assert.equal(status.plugin_configured, false);
  assert.equal(status.mcp_configured, false);
  assert.equal(status.hooks_configured, false);
});
