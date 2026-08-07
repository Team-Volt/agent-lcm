import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CaptureHarness } from "./harnesses.ts";

export type SetupOptions = { home?: string; command: string };
export type SetupReport = { harness: CaptureHarness; path: string; changed: boolean };
export type SetupStatusOptions = { home?: string };

export type HarnessSetupStatus = { configured: boolean; path: string };

const HARNESSES: CaptureHarness[] = ["codex", "cursor", "vscode", "copilot", "kiro"];

export function setupHarness(harness: CaptureHarness, options: SetupOptions): SetupReport {
  const target = setupPath(harness, options.home);
  const command = options.command.trim();
  assertSafeCommand(command);
  const existing = readConfiguration(target);
  const next = mergeConfiguration(existing, harness, command, target);
  if (existing && JSON.stringify(existing) === JSON.stringify(next)) return { harness, path: target, changed: false };
  writeConfiguration(target, next);
  return { harness, path: target, changed: true };
}

export function setupStatus(options: SetupStatusOptions = {}): Record<CaptureHarness, HarnessSetupStatus> {
  return Object.fromEntries(HARNESSES.map((harness) => {
    const target = setupPath(harness, options.home);
    return [harness, { configured: configured(harness, target), path: target }];
  })) as Record<CaptureHarness, HarnessSetupStatus>;
}

function setupPath(harness: CaptureHarness, home?: string): string {
  if (home) return path.join(path.resolve(home), "hooks", "agent-lcm.json");
  const userHome = os.homedir();
  switch (harness) {
    case "codex": return path.join(userHome, ".codex", "hooks", "agent-lcm.json");
    case "cursor": return path.join(userHome, ".cursor", "hooks", "agent-lcm.json");
    case "vscode":
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
    throw invalidConfiguration(target);
  }
  if (!isRecord(value)) throw invalidConfiguration(target);
  return value;
}

function mergeConfiguration(
  existing: Record<string, unknown> | undefined,
  harness: CaptureHarness,
  command: string,
  target: string,
): Record<string, unknown> {
  return harness === "kiro"
    ? mergeKiroConfiguration(existing, command, target)
    : mergeHookConfiguration(existing, harness, command, target);
}

function mergeHookConfiguration(
  existing: Record<string, unknown> | undefined,
  harness: Exclude<CaptureHarness, "kiro">,
  command: string,
  target: string,
): Record<string, unknown> {
  const requiresVersion = harness === "copilot" || harness === "vscode";
  const configuration = existing ? structuredClone(existing) : { ...(requiresVersion ? { version: 1 } : {}), hooks: {} };
  if ((requiresVersion && configuration.version !== 1) || !isRecord(configuration.hooks)) throw invalidConfiguration(target);
  removeAgentLcmHooks(configuration.hooks, harness, target);

  for (const event of eventsFor(harness)) {
    const hooks = configuration.hooks[event];
    const expectedCommand = captureCommand(command, setupCaptureHarness(harness), event);
    if (hooks === undefined) {
      configuration.hooks[event] = [{ type: "command", command: expectedCommand }];
      continue;
    }
    if (!Array.isArray(hooks) || !hooks.every(isRecord)) throw invalidConfiguration(target);
    if (!hooks.some((entry) => entry.type === "command" && entry.command === expectedCommand)) {
      hooks.push({ type: "command", command: expectedCommand });
    }
  }
  return configuration;
}

function mergeKiroConfiguration(existing: Record<string, unknown> | undefined, command: string, target: string): Record<string, unknown> {
  const configuration: Record<string, unknown> = existing ? structuredClone(existing) : { version: "v1", hooks: [] };
  const hooks = configuration.hooks;
  if (configuration.version !== "v1" || !Array.isArray(hooks) || !hooks.every(isKiroHook)) {
    throw invalidConfiguration(target);
  }
  const kiroHooks = hooks as KiroHook[];
  for (const event of eventsFor("kiro")) {
    const expected = kiroHook(command, event);
    const index = kiroHooks.findIndex((hook) => hook.name === expected.name);
    if (index < 0) kiroHooks.push(expected);
    else kiroHooks[index] = expected;
  }
  return configuration;
}

function eventsFor(harness: CaptureHarness): string[] {
  return isSharedHookHarness(harness)
    ? ["sessionStart", "userPromptSubmitted", "postToolUse", "sessionEnd"]
    : ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];
}

function isSharedHookHarness(harness: CaptureHarness): harness is "copilot" | "vscode" {
  return harness === "copilot" || harness === "vscode";
}

function setupCaptureHarness(harness: CaptureHarness): CaptureHarness | "auto" {
  return isSharedHookHarness(harness) ? "auto" : harness;
}

function removeAgentLcmHooks(
  hooksByEvent: Record<string, unknown>,
  harness: Exclude<CaptureHarness, "kiro">,
  target: string,
): void {
  for (const [event, hooks] of Object.entries(hooksByEvent)) {
    if (!Array.isArray(hooks) || !hooks.every(isRecord)) throw invalidConfiguration(target);
    const kept = hooks.filter((hook) => !isAgentLcmHook(hook, event, harness));
    if (kept.length === 0) delete hooksByEvent[event];
    else hooksByEvent[event] = kept;
  }
}

function kiroHook(command: string, event: string): KiroHook {
  return {
    name: `agent-lcm-kiro-${event}`,
    trigger: event,
    action: { type: "command", command: captureCommand(command, "kiro", event) },
  };
}

function captureCommand(command: string, harness: CaptureHarness | "auto", event: string): string {
  return `"${command}" capture --harness ${harness} ${event}`;
}

function assertSafeCommand(command: string): void {
  if (!command) throw new Error("setup command must not be empty");
  if (!path.isAbsolute(command) && !/^[A-Za-z]:[\\/]/u.test(command)) {
    throw new Error("setup command must be an absolute binary path");
  }
  if (/["'`$;&|<>\n\r%^]/u.test(command) || command.endsWith("\\")) {
    throw new Error("setup command contains unsafe shell characters");
  }
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

function configured(harness: CaptureHarness, target: string): boolean {
  const configuration = readConfigurationForStatus(target);
  if (!configuration) return false;
  if (harness === "kiro") {
    const hooks = configuration.hooks;
    if (configuration.version !== "v1" || !Array.isArray(hooks) || !hooks.every(isKiroHook)) return false;
    const kiroHooks = hooks as KiroHook[];
    return eventsFor(harness).every((event) => kiroHooks.some((hook) => isExpectedKiroHook(hook, event)));
  }
  const requiresVersion = harness === "copilot" || harness === "vscode";
  if (requiresVersion && configuration.version !== 1) return false;
  const hooksByEvent = configuration.hooks;
  if (!isRecord(hooksByEvent)) return false;
  if (isSharedHookHarness(harness) && hasSharedPascalRegistration(hooksByEvent)) return false;
  return eventsFor(harness).every((event) => {
    const hooks = hooksByEvent[event];
    return Array.isArray(hooks) && hooks.some((entry) => isExpectedCommandHook(entry, setupCaptureHarness(harness), event));
  });
}

function readConfigurationForStatus(target: string): Record<string, unknown> | undefined {
  try {
    return readConfiguration(target);
  } catch {
    return undefined;
  }
}

function isExpectedCommandHook(value: unknown, harness: CaptureHarness | "auto", event: string): boolean {
  return isRecord(value) && value.type === "command" && isCaptureCommand(value.command, harness, event);
}

function isAgentLcmHook(value: Record<string, unknown>, event: string, harness: Exclude<CaptureHarness, "kiro">): boolean {
  if (value.type !== "command" || typeof value.command !== "string") return false;
  const match = /^"(?:[^"\\/]*[\\/])*agent-lcm(?:\.exe)?" capture --harness (auto|codex|cursor|copilot|vscode) (sessionStart|userPromptSubmitted|postToolUse|sessionEnd|SessionStart|UserPromptSubmit|PostToolUse|Stop)$/u
    .exec(value.command);
  if (match?.[2] !== event) return false;
  return isSharedHookHarness(harness)
    ? match[1] === "auto" || match[1] === "copilot" || match[1] === "vscode"
    : match[1] === harness;
}

function hasSharedPascalRegistration(hooksByEvent: Record<string, unknown>): boolean {
  return ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"].some((event) => {
    const hooks = hooksByEvent[event];
    return Array.isArray(hooks) && hooks.some((hook) => {
      if (!isRecord(hook) || hook.type !== "command" || typeof hook.command !== "string") return false;
      return isAgentLcmHook(hook, event, "vscode");
    });
  });
}

function isExpectedKiroHook(value: unknown, event: string): boolean {
  return isKiroHook(value)
    && value.name === `agent-lcm-kiro-${event}`
    && value.trigger === event
    && isCaptureCommand(value.action.command, "kiro", event);
}

type KiroHook = { name: string; trigger: string; action: { type: "command"; command: string } };

function isKiroHook(value: unknown): value is KiroHook {
  return isRecord(value)
    && typeof value.name === "string"
    && typeof value.trigger === "string"
    && isRecord(value.action)
    && value.action.type === "command"
    && typeof value.action.command === "string";
}

function isCaptureCommand(value: unknown, harness: CaptureHarness | "auto", event: string): boolean {
  if (typeof value !== "string") return false;
  const suffix = ` capture --harness ${harness} ${event}`;
  if (!value.startsWith("\"") || !value.endsWith(suffix)) return false;
  const quoteEnd = value.length - suffix.length - 1;
  if (value[quoteEnd] !== "\"") return false;
  const command = value.slice(1, quoteEnd);
  try {
    assertSafeCommand(command);
    return true;
  } catch {
    return false;
  }
}

function invalidConfiguration(target: string): Error {
  return new Error(`Cannot update invalid setup configuration: ${target}`);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && Reflect.get(error, "code") === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
