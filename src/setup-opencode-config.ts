import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { applyEdits, modify, parse, printParseErrorCode, visit } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";

import { assertSafeSetupCommand } from "./setup-hook-status.ts";
import {
  mutateSetupConfiguration,
  mutateSetupFile,
  readSetupFileBytes,
} from "./setup-files.ts";
import type { SetupConfigurationSnapshot } from "./setup-files.ts";
import { openCodeJsoncPath } from "./setup-targets.ts";

export function readOpenCodeConfigurationSnapshot(
  target: string,
  action: "setup" | "remove",
): SetupConfigurationSnapshot {
  try {
    const bytes = readSetupFileBytes(target);
    return {
      configuration: bytes === undefined ? undefined : target.endsWith(".jsonc")
        ? parseOpenCodeJsonc(bytes, target)
        : parseOpenCodeJson(bytes, target),
      hash: bytes === undefined ? "missing" : createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    throw new Error(
      `Cannot safely ${action} OpenCode configuration ${target}; fix it as valid JSON before rerunning.`,
      { cause: error },
    );
  }
}

export function mutateOpenCodeMcp(
  target: string,
  action: "setup" | "remove",
  command: string,
  snapshot: SetupConfigurationSnapshot,
): boolean {
  if (!target.endsWith(".jsonc")) {
    return mutateSetupConfiguration(target, (existing) => action === "setup"
      ? updateOpenCodeMcp(existing, command)
      : removeOpenCodeMcp(existing, command), snapshot.hash);
  }
  return mutateSetupFile(target, (current) => {
    const source = current?.toString("utf8") ?? "{}\n";
    const existing = parseOpenCodeJsonc(Buffer.from(source), target);
    const currentMcp = isRecord(existing.mcp) ? existing.mcp["agent-lcm"] : undefined;
    if (action === "remove" && !isOwnedOpenCodeMcp(currentMcp, command)) return current;
    const formattingOptions = {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
        eol: source.includes("\r\n") ? "\r\n" : "\n",
      },
    };
    const removeSoleMcpEntry = action === "remove" && isRecord(existing.mcp)
      && Object.keys(existing.mcp).length === 1;
    const edits = removeSoleMcpEntry
      ? modify(source, ["mcp"], {}, formattingOptions)
      : modify(source, ["mcp", "agent-lcm"], action === "setup" ? openCodeMcpEntry(command) : undefined, formattingOptions);
    const candidate = Buffer.from(applyEdits(source, edits), "utf8");
    parseOpenCodeJsonc(candidate, target);
    return candidate;
  }, snapshot.hash);
}

export function updateOpenCodeMcp(
  existing: Record<string, unknown> | undefined,
  command: string,
): Record<string, unknown> {
  const servers = isRecord(existing?.mcp) ? existing.mcp : {};
  return {
    ...(existing ?? {}),
    mcp: {
      ...servers,
      "agent-lcm": openCodeMcpEntry(command),
    },
  };
}

export function removeOpenCodeMcp(
  existing: Record<string, unknown> | undefined,
  expectedCommand?: string,
): Record<string, unknown> | undefined {
  if (expectedCommand === undefined || existing === undefined || !isRecord(existing.mcp)
    || !isOwnedOpenCodeMcp(existing.mcp["agent-lcm"], expectedCommand)) return existing;
  const servers = { ...existing.mcp };
  delete servers["agent-lcm"];
  return { ...existing, mcp: servers };
}

export function validateOpenCodeConfiguration(
  configuration: Record<string, unknown> | undefined,
  target: string,
  action: "setup" | "remove",
  expectedCommand?: string,
): void {
  if (configuration === undefined) return;
  if (configuration.mcp !== undefined && !isRecord(configuration.mcp)) {
    throw new Error(`Cannot safely ${action} OpenCode MCP configuration: mcp must be an object in ${target}.`);
  }
  const mcp = configuration.mcp;
  if (action === "setup" && isRecord(mcp) && mcp["agent-lcm"] !== undefined
    && !isOwnedOpenCodeMcp(mcp["agent-lcm"], expectedCommand)) {
    throw new Error(`Refusing to overwrite unmanaged OpenCode MCP entry: ${target}`);
  }
}

export function isOwnedOpenCodeMcp(value: unknown, expectedCommand?: string): boolean {
  if (!isRecord(value) || value.type !== "local" || value.enabled !== true || !Array.isArray(value.command)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 3 || !Object.hasOwn(value, "type") || !Object.hasOwn(value, "command") || !Object.hasOwn(value, "enabled")) return false;
  if (value.command.length !== 3 || value.command[0] !== "node" || value.command[2] !== "mcp") return false;
  const command = value.command[1];
  if (typeof command !== "string" || !path.isAbsolute(command) || (expectedCommand !== undefined && command !== expectedCommand)) return false;
  try {
    assertSafeSetupCommand(command);
    return true;
  } catch {
    return false;
  }
}

export function openCodeJsoncExists(home?: string): boolean {
  try {
    fs.lstatSync(openCodeJsoncPath(home));
    return true;
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return false;
    throw error;
  }
}

function openCodeMcpEntry(command: string): Record<string, unknown> {
  return { type: "local", command: ["node", command, "mcp"], enabled: true };
}

function parseOpenCodeJsonc(bytes: Buffer, target: string): Record<string, unknown> {
  return parseOpenCodeConfiguration(bytes, target, true);
}

function parseOpenCodeJson(bytes: Buffer, target: string): Record<string, unknown> {
  return parseOpenCodeConfiguration(bytes, target, false);
}

function parseOpenCodeConfiguration(bytes: Buffer, target: string, allowJsonc: boolean): Record<string, unknown> {
  const source = bytes.toString("utf8");
  const errors: ParseError[] = [];
  const options = { disallowComments: !allowJsonc, allowTrailingComma: allowJsonc };
  const value: unknown = parse(source, errors, options);
  if (errors.length > 0 || !isRecord(value)) {
    const issue = errors[0];
    const detail = issue === undefined ? "root must be an object" : `${printParseErrorCode(issue.error)} at offset ${String(issue.offset)}`;
    throw new Error(`Cannot update invalid setup configuration: ${target} (${detail})`);
  }
  assertUnambiguousOpenCodePaths(source, target, options);
  return value;
}

function assertUnambiguousOpenCodePaths(
  source: string,
  target: string,
  options: { readonly disallowComments: boolean; readonly allowTrailingComma: boolean },
): void {
  const paths = new Set<string>();
  let duplicate: string | undefined;
  visit(source, {
    onObjectProperty: (property, _offset, _length, _line, _character, pathSupplier) => {
      const parentPath = pathSupplier();
      const key = property === "mcp" && parentPath.length === 0
        ? "mcp"
        : property === "agent-lcm" && parentPath.length === 1 && parentPath[0] === "mcp"
          ? "mcp.agent-lcm"
          : undefined;
      if (key === undefined || duplicate !== undefined) return;
      if (paths.has(key)) duplicate = key;
      else paths.add(key);
    },
  }, options);
  if (duplicate !== undefined) {
    throw new Error(`Cannot update ambiguous OpenCode configuration: ${target} (duplicate ${duplicate} key)`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
