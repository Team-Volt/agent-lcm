import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertSafeSetupCommand } from "./setup-hook-status.ts";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function withCopilotPluginSource<T>(command: string, callback: (source: string) => T): T {
  assertSafeSetupCommand(command);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lcm-copilot-plugin-"));
  const source = path.join(temporary, "agent-lcm");
  try {
    fs.mkdirSync(source, { mode: 0o700 });
    const packageJson = readPackageJson();
    writeJson(path.join(source, "plugin.json"), {
      name: "agent-lcm",
      version: packageJson.version,
      description: packageJson.description,
      author: { name: "Team Volt" },
      homepage: "https://github.com/Team-Volt/agent-lcm",
      license: "MIT",
      skills: "skills/",
      hooks: "hooks.json",
      mcpServers: ".mcp.json",
    });
    writeJson(path.join(source, "hooks.json"), copilotHooks(command));
    writeJson(path.join(source, ".mcp.json"), {
      mcpServers: {
        "agent-lcm": { type: "stdio", command: "node", args: [command, "mcp"] },
      },
    });
    fs.cpSync(path.join(PACKAGE_ROOT, "skills"), path.join(source, "skills"), { recursive: true });
    return callback(source);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function copilotHooks(command: string): Record<string, unknown> {
  const capture = `node "${command}" capture --harness auto`;
  return {
    version: 1,
    hooks: {
      sessionStart: [{ type: "command", command: capture }],
      userPromptSubmitted: [{ type: "command", command: capture }],
      postToolUse: [{ type: "command", command: capture }],
      sessionEnd: [{ type: "command", command: capture }],
    },
  };
}

function readPackageJson(): { readonly version: string; readonly description: string } {
  const value: unknown = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
  if (!isRecord(value) || typeof value.version !== "string" || typeof value.description !== "string") {
    throw new Error("Agent LCM package metadata is invalid.");
  }
  return { version: value.version, description: value.description };
}

function writeJson(target: string, value: unknown): void {
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
