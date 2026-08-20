import assert from "node:assert/strict";
import test from "node:test";

import { generateOpenCodePluginSource } from "../src/opencode-plugin.ts";

type Capture = { event: string; payload: Record<string, unknown> };
type GeneratedHook = (...args: unknown[]) => Promise<void>;
type GeneratedPlugin = (context: { directory: string }) => Promise<Record<string, GeneratedHook>>;

function loadGeneratedPlugin(source: string, captures: Capture[], state = "enabled\n", url = "file:///tmp/agent-lcm.ts") {
  const executable = source
    .replace('import { spawn } from "node:child_process";\n', "")
    .replace('import fs from "node:fs";\n', "")
    .replaceAll("import.meta.url", JSON.stringify(url))
    .replace("export const AgentLcmPlugin", "const AgentLcmPlugin")
    .replace("export default AgentLcmPlugin;", "");
  const spawn = (_command: string, args: string[]) => {
    const event = args.at(-1);
    if (event === undefined) throw new Error("Generated capture command has no event.");
    return {
      on: () => {},
      stdin: {
        on: () => {},
        end: (input: string) => {
          const payload: unknown = JSON.parse(input);
          if (!isRecord(payload)) throw new Error("Generated capture payload must be an object.");
          captures.push({ event, payload });
        },
      },
    };
  };
  const fs = { readFileSync: () => state };
  const plugin: unknown = new Function("spawn", "fs", `${executable}\nreturn AgentLcmPlugin;`)(spawn, fs);
  if (!isGeneratedPlugin(plugin)) throw new Error("Generated OpenCode plugin did not export a function.");
  return plugin;
}

function isGeneratedPlugin(value: unknown): value is GeneratedPlugin {
  return typeof value === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("generates a quoted OpenCode plugin command with a durable ownership marker", () => {
  const command = "/Users/test tools/bin/agent-lcm";
  const source = generateOpenCodePluginSource(command);

  assert.match(source, /^\/\/ agent-lcm-opencode-plugin: 1\n/u);
  assert.ok(source.includes(`const AGENT_LCM_COMMAND = ${JSON.stringify(command)};`));
  assert.match(source, /spawn\("node", \[AGENT_LCM_COMMAND, "capture", "--harness", "opencode", hookEvent\]/u);
  assert.match(source, /shell: false/u);
  assert.doesNotMatch(source, /@opencode-ai\/plugin/u);
});

test("captures stable OpenCode callbacks with canonical payload fields", async () => {
  const captures: Capture[] = [];
  const plugin = loadGeneratedPlugin(generateOpenCodePluginSource("/opt/agent-lcm/bin/agent-lcm"), captures);
  const hooks = await plugin({ directory: "/repo" });

  await hooks.event({ event: { type: "session.created", properties: { sessionID: "session-1", metadata: { branch: "main" } } } });
  await hooks["chat.message"](
    { sessionID: "session-1", messageID: "message-1", agent: "build", metadata: { source: "user" } },
    { parts: [{ type: "text", text: "hello " }, { type: "image", url: "ignored" }, { type: "text", text: "world" }] },
  );
  await hooks["tool.execute.after"](
    { sessionID: "session-1", tool: "read", callID: "call-1", args: { path: "README.md" } },
    { output: "file contents", metadata: { durationMs: 3 } },
  );

  assert.deepEqual(captures[0], {
    event: "SessionStart",
    payload: { sessionID: "session-1", metadata: { branch: "main" }, event_type: "session.created", cwd: "/repo" },
  });
  assert.equal(captures[1]?.event, "UserPromptSubmit");
  assert.equal(captures[1]?.payload.prompt, "hello world");
  assert.equal(captures[1]?.payload.sessionID, "session-1");
  assert.deepEqual(captures[1]?.payload.metadata, { source: "user" });
  assert.equal(captures[1]?.payload.cwd, "/repo");
  assert.equal(captures[2]?.event, "PostToolUse");
  assert.equal(captures[2]?.payload.tool_name, "read");
  assert.equal(captures[2]?.payload.tool_use_id, "call-1");
  assert.deepEqual(captures[2]?.payload.tool_input, { path: "README.md" });
  assert.equal(captures[2]?.payload.tool_response, "file contents");
  assert.deepEqual(captures[2]?.payload.metadata, { durationMs: 3 });
  assert.equal(captures[2]?.payload.cwd, "/repo");
});

test("disabled OpenCode state prevents capture", async () => {
  const captures: Capture[] = [];
  const plugin = loadGeneratedPlugin(generateOpenCodePluginSource("/opt/agent-lcm/bin/agent-lcm"), captures, "disabled\n");
  const hooks = await plugin({ directory: "/repo" });
  await hooks["chat.message"]({}, { parts: [{ type: "text", text: "must not capture" }] });
  assert.deepEqual(captures, []);
});

test("a loadable legacy backup source cannot capture as a second plugin", async () => {
  const captures: Capture[] = [];
  const plugin = loadGeneratedPlugin(generateOpenCodePluginSource("/opt/agent-lcm/bin/agent-lcm"), captures, "enabled\n", "file:///tmp/agent-lcm-pre-agent-lcm-old.ts");
  const hooks = await plugin({ directory: "/repo" });
  await hooks["chat.message"]({}, { parts: [{ type: "text", text: "backup" }] });
  assert.deepEqual(captures, []);
});

test("rejects relative and shell-injected Agent LCM commands", () => {
  assert.throws(() => generateOpenCodePluginSource("agent-lcm"), /absolute binary path/u);
  assert.throws(
    () => generateOpenCodePluginSource('/opt/agent-lcm"; process.exit(1); //'),
    /unsafe shell characters/u,
  );
});
