import path from "node:path";

import type { CaptureHarness } from "./harnesses.ts";
import { backupSetupConfiguration, readSetupConfiguration, writeSetupConfiguration } from "./setup-files.ts";
import { SETUP_HARNESSES, setupPath } from "./setup-targets.ts";

export type SetupOptions = { home?: string; command: string };
export type SetupReport = { harness: CaptureHarness; path: string; changed: boolean };
export type SetupStatusOptions = { home?: string };

export type HarnessSetupStatus = { configured: boolean; path: string };

export function setupHarness(harness: CaptureHarness, options: SetupOptions): SetupReport {
  const target = setupPath(harness, options.home);
  const command = options.command.trim();
  assertSafeCommand(command);
  const existing = readSetupConfiguration(target);
  const next = mergeConfiguration(existing, harness, command, target);
  if (existing && JSON.stringify(existing) === JSON.stringify(next)) return { harness, path: target, changed: false };
  if (existing) backupSetupConfiguration(target);
  writeSetupConfiguration(target, next);
  return { harness, path: target, changed: true };
}

export function setupStatus(options: SetupStatusOptions = {}): Record<CaptureHarness, HarnessSetupStatus> {
  return Object.fromEntries(SETUP_HARNESSES.map((harness) => {
    const target = setupPath(harness, options.home);
    return [harness, { configured: configured(harness, target), path: target }];
  })) as Record<CaptureHarness, HarnessSetupStatus>;
}

function mergeConfiguration(
  existing: Record<string, unknown> | undefined,
  harness: CaptureHarness,
  command: string,
  target: string,
): Record<string, unknown> {
  if (harness === "kiro") return mergeKiroConfiguration(existing, command, target);
  if (harness === "codex") return mergeCodexConfiguration(existing, command, target);
  return mergeFlatConfiguration(existing, harness, command, target);
}

function mergeCodexConfiguration(
  existing: Record<string, unknown> | undefined,
  command: string,
  target: string,
): Record<string, unknown> {
  const configuration = existing ? structuredClone(existing) : { hooks: {} };
  if (!isRecord(configuration.hooks)) throw invalidConfiguration(target);
  if (!Object.values(configuration.hooks).every(isCodexSelectors)) throw invalidConfiguration(target);

  for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    const expectedCommand = captureCommand(command, "codex", event);
    const selectors = configuration.hooks[event];
    if (selectors === undefined) {
      configuration.hooks[event] = [{ hooks: [{ type: "command", command: expectedCommand }] }];
      continue;
    }
    if (!isCodexSelectors(selectors)) throw invalidConfiguration(target);
    let found = false;
    for (const selector of selectors) {
      if (!Array.isArray(selector.hooks) || !selector.hooks.every(isRecord)) throw invalidConfiguration(target);
      for (const hook of selector.hooks) {
        if (!isAgentLcmHook(hook, event, "codex")) continue;
        hook.type = "command";
        hook.command = expectedCommand;
        found = true;
      }
    }
    if (!found) selectors.push({ hooks: [{ type: "command", command: expectedCommand }] });
  }
  return configuration;
}

function mergeFlatConfiguration(
  existing: Record<string, unknown> | undefined,
  harness: "cursor" | "vscode" | "copilot",
  command: string,
  target: string,
): Record<string, unknown> {
  const configuration = existing ? structuredClone(existing) : { version: 1, hooks: {} };
  if (configuration.version !== 1 || !isRecord(configuration.hooks)) throw invalidConfiguration(target);
  if (!Object.values(configuration.hooks).every((hooks) => Array.isArray(hooks) && hooks.every(isRecord))) {
    throw invalidConfiguration(target);
  }
  for (const [event, captureEvent] of setupEvents(harness)) {
    const expectedHooks = takeAgentLcmHooks(configuration.hooks, harness, event);
    if (expectedHooks.length === 0) expectedHooks.push({});
    for (const expected of expectedHooks) {
      if (harness !== "cursor") expected.type = "command";
      expected.command = captureCommand(command, setupCaptureHarness(harness), captureEvent);
    }
    const hooks = configuration.hooks[event] as Record<string, unknown>[] | undefined;
    if (hooks === undefined) configuration.hooks[event] = expectedHooks;
    else hooks.push(...expectedHooks);
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
    const owned = kiroHooks.filter((hook) => hook.name === expected.name
      && hook.trigger === event
      && isAgentLcmHook(hook.action, event, "kiro"));
    if (owned.length === 0) kiroHooks.push(expected);
    for (const hook of owned) {
      hook.action.type = "command";
      hook.action.command = expected.action.command;
    }
  }
  return configuration;
}

function eventsFor(harness: CaptureHarness): string[] {
  return isSharedHookHarness(harness)
    ? ["sessionStart", "userPromptSubmitted", "postToolUse", "sessionEnd"]
    : ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];
}

function setupEvents(harness: "cursor" | "vscode" | "copilot"): ReadonlyArray<readonly [string, string]> {
  return harness === "cursor"
    ? [["sessionStart", "SessionStart"], ["beforeSubmitPrompt", "UserPromptSubmit"], ["postToolUse", "PostToolUse"], ["stop", "Stop"]]
    : [["sessionStart", "sessionStart"], ["userPromptSubmitted", "userPromptSubmitted"], ["postToolUse", "postToolUse"], ["sessionEnd", "sessionEnd"]];
}

function isSharedHookHarness(harness: CaptureHarness): harness is "copilot" | "vscode" {
  return harness === "copilot" || harness === "vscode";
}

function setupCaptureHarness(harness: CaptureHarness): CaptureHarness | "auto" {
  return isSharedHookHarness(harness) ? "auto" : harness;
}

function takeAgentLcmHooks(
  hooksByEvent: Record<string, unknown>,
  harness: "cursor" | "vscode" | "copilot",
  event: string,
): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const candidates = isSharedHookHarness(harness) ? [event, sharedLegacyEvent(event)] : [event];
  for (const candidate of candidates) {
    const hooks = hooksByEvent[candidate];
    if (!Array.isArray(hooks)) continue;
    const kept = hooks.filter((hook) => {
      if (!isRecord(hook) || !isAgentLcmHook(hook, candidate, harness)) return true;
      found.push(hook);
      return false;
    });
    if (kept.length === 0) delete hooksByEvent[candidate];
    else hooksByEvent[candidate] = kept;
  }
  return found;
}

function sharedLegacyEvent(event: string): string {
  return ({
    sessionStart: "SessionStart",
    userPromptSubmitted: "UserPromptSubmit",
    postToolUse: "PostToolUse",
    sessionEnd: "Stop",
  } as Record<string, string>)[event] ?? event;
}

function kiroHook(command: string, event: string): KiroHook {
  return {
    name: `agent-lcm-kiro-${event}`,
    trigger: event,
    action: { type: "command", command: captureCommand(command, "kiro", event) },
  };
}

function captureCommand(command: string, harness: CaptureHarness | "auto", event: string): string {
  return `node "${command}" capture --harness ${harness} ${event}`;
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

function configured(harness: CaptureHarness, target: string): boolean {
  const configuration = readConfigurationForStatus(target);
  if (!configuration) return false;
  if (harness === "kiro") {
    const hooks = configuration.hooks;
    if (configuration.version !== "v1" || !Array.isArray(hooks) || !hooks.every(isKiroHook)) return false;
    const kiroHooks = hooks as KiroHook[];
    return eventsFor(harness).every((event) => kiroHooks.some((hook) => isExpectedKiroHook(hook, event)));
  }
  if (harness !== "codex" && configuration.version !== 1) return false;
  const hooksByEvent = configuration.hooks;
  if (!isRecord(hooksByEvent)) return false;
  if (harness === "codex") return eventsFor(harness).every((event) => {
    const selectors = hooksByEvent[event];
    return Array.isArray(selectors) && selectors.some((selector) => isRecord(selector)
      && Array.isArray(selector.hooks)
      && selector.hooks.some((hook) => isExpectedCommandHook(hook, harness, event)));
  });
  if (isSharedHookHarness(harness) && hasSharedPascalRegistration(hooksByEvent)) return false;
  return setupEvents(harness).every(([event, captureEvent]) => {
    const hooks = hooksByEvent[event];
    return Array.isArray(hooks) && hooks.some((entry) => isExpectedCommandHook(entry, setupCaptureHarness(harness), captureEvent));
  });
}

function readConfigurationForStatus(target: string): Record<string, unknown> | undefined {
  try {
    return readSetupConfiguration(target);
  } catch {
    return undefined;
  }
}

function isExpectedCommandHook(value: unknown, harness: CaptureHarness | "auto", event: string): boolean {
  return isRecord(value) && (value.type === undefined || value.type === "command") && isCaptureCommand(value.command, harness, event);
}

function isCodexSelectors(value: unknown): value is Array<Record<string, unknown> & { hooks: Record<string, unknown>[] }> {
  return Array.isArray(value) && value.every((selector) => isRecord(selector)
    && Array.isArray(selector.hooks)
    && selector.hooks.every(isRecord));
}

function isAgentLcmHook(value: Record<string, unknown>, event: string, harness: CaptureHarness): boolean {
  if ((value.type !== undefined && value.type !== "command") || typeof value.command !== "string") return false;
  const match = /^(?:node )?"(?:[^"\\/]*[\\/])*agent-lcm(?:\.(?:cmd|exe))?" capture --harness (auto|codex|cursor|copilot|vscode|kiro) (sessionStart|userPromptSubmitted|postToolUse|sessionEnd|SessionStart|UserPromptSubmit|PostToolUse|Stop)$/u
    .exec(value.command);
  const captureEvent = harness === "cursor"
    ? setupEvents("cursor").find(([hookEvent]) => hookEvent === event)?.[1]
    : event;
  if (!match || match[2] !== captureEvent) return false;
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
  const prefix = 'node "';
  const suffix = ` capture --harness ${harness} ${event}`;
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) return false;
  const quoteEnd = value.length - suffix.length - 1;
  if (value[quoteEnd] !== "\"") return false;
  const command = value.slice(prefix.length, quoteEnd);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
