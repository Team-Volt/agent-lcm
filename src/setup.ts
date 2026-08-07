import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CaptureHarness } from "./harnesses.ts";

export type SetupOptions = { home?: string; command: string };
export type SetupReport = { harness: CaptureHarness; path: string; changed: boolean };

export type HarnessSetupStatus = { configured: boolean; path: string };

const HARNESSES: CaptureHarness[] = ["codex", "cursor", "vscode", "copilot", "kiro"];

export function setupHarness(harness: CaptureHarness, options: SetupOptions): SetupReport {
  const target = setupPath(harness, options.home);
  const command = options.command.trim();
  if (!command) throw new Error("setup command must not be empty");
  const existing = readConfiguration(target);
  const next = mergeConfiguration(existing, harness, command, target);
  if (existing && JSON.stringify(existing) === JSON.stringify(next)) return { harness, path: target, changed: false };
  writeConfiguration(target, next);
  return { harness, path: target, changed: true };
}

export function setupStatus(): Record<CaptureHarness, HarnessSetupStatus> {
  return Object.fromEntries(HARNESSES.map((harness) => {
    const target = setupPath(harness);
    return [harness, { configured: configured(target), path: target }];
  })) as Record<CaptureHarness, HarnessSetupStatus>;
}

function setupPath(harness: CaptureHarness, home?: string): string {
  if (home) {
    const root = path.resolve(home);
    return harness === "vscode" ? path.join(root, "agent-lcm-hooks.json") : path.join(root, "hooks", "agent-lcm.json");
  }
  const userHome = os.homedir();
  switch (harness) {
    case "codex": return path.join(userHome, ".codex", "hooks", "agent-lcm.json");
    case "cursor": return path.join(userHome, ".cursor", "hooks", "agent-lcm.json");
    case "vscode": return path.join(userHome, ".config", "Code", "User", "agent-lcm-hooks.json");
    case "copilot": return path.join(userHome, ".copilot", "hooks", "agent-lcm.json");
    case "kiro": return path.join(userHome, ".kiro", "hooks", "agent-lcm.json");
  }
}

function readConfiguration(target: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(target, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`Cannot update invalid setup configuration: ${target}`);
  }
  if (!isRecord(value) || !isRecord(value.hooks)) throw new Error(`Cannot update invalid setup configuration: ${target}`);
  return value;
}

function mergeConfiguration(
  existing: Record<string, unknown> | undefined,
  harness: CaptureHarness,
  command: string,
  target: string,
): Record<string, unknown> {
  const configuration = existing ? structuredClone(existing) : { ...(harness === "kiro" ? { version: "v1" } : {}), hooks: {} };
  if (!isRecord(configuration.hooks)) throw new Error(`Cannot update invalid setup configuration: ${target}`);
  for (const event of eventsFor(harness)) {
    const hooks = configuration.hooks[event];
    if (hooks === undefined) {
      configuration.hooks[event] = [{ command: captureCommand(command, harness, event) }];
      continue;
    }
    if (!Array.isArray(hooks) || !hooks.every(isRecord)) throw new Error(`Cannot update invalid setup configuration: ${target}`);
    if (!hooks.some((entry) => entry.command === captureCommand(command, harness, event))) {
      hooks.push({ command: captureCommand(command, harness, event) });
    }
  }
  return configuration;
}

function eventsFor(harness: CaptureHarness): string[] {
  return harness === "copilot"
    ? ["sessionStart", "userPromptSubmitted", "postToolUse", "sessionEnd"]
    : ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];
}

function captureCommand(command: string, harness: CaptureHarness, event: string): string {
  return `\"${command}\" capture --harness ${harness} ${event}`;
}

function writeConfiguration(target: string, configuration: Record<string, unknown>): void {
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

function configured(target: string): boolean {
  try {
    return /(?:^|[^A-Za-z])agent-lcm(?:[^A-Za-z]|$)/u.test(fs.readFileSync(target, "utf8"));
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && Reflect.get(error, "code") === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
