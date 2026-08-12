import assert from "node:assert/strict";
import test from "node:test";
import { readJson } from "./helpers.ts";

test("root is an Agent Plugins 1.0 package", () => {
  const plugin = readJson("plugin.json");
  assert.deepEqual(Object.keys(plugin).sort(), ["$schema", "author", "description", "homepage", "keywords", "name", "version"]);
  assert.equal(plugin.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(plugin.name, "agent-lcm");
  assert.deepEqual(plugin.author, { name: "Team Volt" });
  assert.deepEqual(plugin.keywords, ["agent-memory", "context", "recall", "sessions"]);
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
  assert.equal(codex.mcpServers, "./.mcp.json");
  assert.equal(codex.homepage, "https://github.com/Team-Volt/agent-lcm");
  assert.deepEqual(codex.interface, {
    displayName: "Agent LCM",
    shortDescription: "Use shared local context memory in Codex.",
    longDescription: "Agent LCM captures and recalls coding-agent sessions from one local store.",
    developerName: "Team Volt",
    category: "Developer Tools",
    capabilities: [],
    defaultPrompt: "Recall relevant work from earlier coding sessions.",
  });
  assert.deepEqual(readJson(".mcp.json").mcpServers["agent-lcm"], {
    type: "stdio",
    command: "node",
    args: ["./bin/agent-lcm", "mcp"],
    cwd: ".",
  });
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
  const cursorHooks = JSON.stringify(readJson("hooks/cursor.json"));
  assert.match(cursorHooks, /capture --harness cursor UserPromptSubmit/u);
  assert.match(cursorHooks, /\$\{CURSOR_PLUGIN_ROOT\}/u);
  assert.doesNotMatch(cursorHooks, /\$\{PLUGIN_ROOT\}/u);
  const portableHooks = readJson("hooks.json");
  assert.equal(portableHooks.version, 1);
  assert.equal(portableHooks.hooks.sessionStart[0].type, "command");
  assert.deepEqual(Object.keys(portableHooks.hooks).sort(), ["postToolUse", "sessionEnd", "sessionStart", "userPromptSubmitted"]);
  assert.match(JSON.stringify(portableHooks), /capture --harness auto/u);
});

test("Claude Code plugin artifacts use isolated native components", () => {
  const packageJson = readJson("package.json");
  const portablePlugin = readJson("plugin.json");
  assert.equal(portablePlugin.version, packageJson.version);
  delete portablePlugin.$schema;
  const plugin = readJson(".claude-plugin/plugin.json");
  assert.deepEqual(plugin, {
    ...portablePlugin,
    skills: "./skills/",
    mcpServers: "./mcp.claude.json",
  });
  assert.equal("hooks" in plugin, false);
  assert.equal(plugin.version, packageJson.version);

  const marketplace = readJson(".claude-plugin/marketplace.json");
  assert.deepEqual(marketplace, {
    name: "agent-lcm",
    description: "Shared local context memory for agent harnesses.",
    owner: { name: "Team Volt" },
    plugins: [{ name: "agent-lcm", source: "." }],
  });
  assert.equal(marketplace.plugins.length, 1);

  const expectedEvents = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];
  const hooks = readJson("hooks/hooks.json");
  assert.deepEqual(Object.keys(hooks.hooks).sort(), [...expectedEvents].sort());
  for (const event of expectedEvents) {
    assert.equal(hooks.hooks[event].length, 1);
    assert.deepEqual(Object.keys(hooks.hooks[event][0]).sort(), ["hooks"]);
    assert.deepEqual(hooks.hooks[event][0].hooks, [{
      type: "command",
      command: "node",
      args: ["${CLAUDE_PLUGIN_ROOT}/bin/agent-lcm", "capture", "--harness", "claude", event],
    }]);
  }

  const mcp = readJson("mcp.claude.json");
  assert.deepEqual(Object.keys(mcp).sort(), ["mcpServers"]);
  assert.deepEqual(Object.keys(mcp.mcpServers), ["agent-lcm"]);
  assert.deepEqual(mcp.mcpServers["agent-lcm"], {
    type: "stdio",
    command: "node",
    args: ["${CLAUDE_PLUGIN_ROOT}/bin/agent-lcm", "mcp"],
  });
  assert.doesNotMatch(JSON.stringify({ plugin, hooks, mcp }), /\$\{PLUGIN_ROOT\}/u);
  assert.doesNotMatch(JSON.stringify(hooks), /node ["']/u);
  assert.deepEqual(readJson(".mcp.json"), {
    mcpServers: {
      "agent-lcm": {
        type: "stdio",
        command: "node",
        args: ["./bin/agent-lcm", "mcp"],
        cwd: ".",
      },
    },
  });
});
