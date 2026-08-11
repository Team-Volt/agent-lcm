import assert from "node:assert/strict";
import test from "node:test";
import { readJson } from "./helpers.ts";

test("root is an Agent Plugins 1.0 package", () => {
  const plugin = readJson("plugin.json");
  assert.deepEqual(Object.keys(plugin).sort(), ["$schema", "description", "homepage", "name", "version"]);
  assert.equal(plugin.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(plugin.name, "agent-lcm");
  assert.equal(plugin.homepage, "https://github.com/Team-Volt/agent-lcm");

  const mcp = readJson("mcp.json");
  assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  assert.deepEqual(mcp.mcpServers["agent-lcm"], {
    type: "stdio",
    command: "node",
    args: ["${PLUGIN_ROOT}/bin/agent-lcm", "mcp"],
  });
});

test("client hook manifests invoke explicit or detected harness capture", () => {
  const codex = readJson(".codex-plugin/plugin.json");
  assert.equal(codex.hooks, "./hooks/codex.json");
  assert.equal(codex.homepage, "https://github.com/Team-Volt/agent-lcm");
  const codexManifest = readJson("hooks/codex.json");
  const codexHooks = JSON.stringify(codexManifest);
  assert.deepEqual(Object.keys(codexManifest.hooks).sort(), [
    "PostCompact",
    "PostToolUse",
    "PreCompact",
    "PreToolUse",
    "SessionStart",
    "Stop",
    "SubagentStop",
    "UserPromptSubmit",
  ]);
  assert.match(codexHooks, /capture --harness codex SessionStart/u);
  assert.equal(codexManifest.hooks.PreToolUse[0].matcher, ".*");
  assert.match(codexHooks, /hook PreToolUse/u);
  assert.match(codexHooks, /hook PreCompact/u);
  assert.match(codexHooks, /hook PostCompact/u);
  assert.match(codexHooks, /hook SubagentStop/u);
  assert.match(codexHooks, /capture --harness codex Stop/u);

  const cursor = readJson(".cursor-plugin/plugin.json");
  assert.equal(cursor.hooks, "./hooks/cursor.json");
  assert.equal(cursor.homepage, "https://github.com/Team-Volt/agent-lcm");
  assert.equal(cursor.mcpServers, "./mcp.cursor.json");
  assert.deepEqual(readJson("mcp.cursor.json").mcpServers["agent-lcm"], {
    type: "stdio",
    command: "node",
    args: ["${CURSOR_PLUGIN_ROOT}/bin/agent-lcm", "mcp"],
  });
  const cursorManifest = readJson("hooks/cursor.json");
  assert.equal(cursorManifest.version, 1);
  assert.deepEqual(Object.keys(cursorManifest.hooks).sort(), ["beforeSubmitPrompt", "postToolUse", "sessionStart", "stop"]);
  const cursorHooks = JSON.stringify(cursorManifest);
  assert.match(cursorHooks, /capture --harness cursor beforeSubmitPrompt/u);
  assert.match(cursorHooks, /\$\{CURSOR_PLUGIN_ROOT\}/u);
  assert.doesNotMatch(cursorHooks, /\$\{PLUGIN_ROOT\}/u);
  assert.doesNotMatch(cursorHooks, /"hooks":\s*\[/u);
  const portableHooks = readJson("hooks.json");
  assert.equal(portableHooks.version, 1);
  assert.equal(portableHooks.hooks.sessionStart[0].type, "command");
  assert.deepEqual(Object.keys(portableHooks.hooks).sort(), ["agentStop", "postToolUse", "sessionStart", "userPromptSubmitted"]);
  for (const event of ["sessionStart", "userPromptSubmitted", "postToolUse", "agentStop"]) {
    assert.match(portableHooks.hooks[event][0].command, new RegExp(`capture --harness copilot ${event}$`, "u"));
  }
});
