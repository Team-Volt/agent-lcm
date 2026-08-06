import assert from "node:assert/strict";
import test from "node:test";
import { readJson } from "./helpers.ts";

test("root is an Agent Plugins 1.0 package", () => {
  const plugin = readJson("plugin.json");
  assert.deepEqual(Object.keys(plugin).sort(), ["$schema", "description", "name", "version"]);
  assert.equal(plugin.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  assert.equal(plugin.name, "agent-lcm");

  const mcp = readJson("mcp.json");
  assert.equal(mcp.$schema, "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  assert.deepEqual(mcp.mcpServers["agent-lcm"], {
    type: "stdio",
    command: "node",
    args: ["${PLUGIN_ROOT}/bin/agent-lcm", "mcp"],
  });
});
