import path from "node:path";

import type { CaptureHarness } from "./harnesses.ts";
import { openCodeSetupStatus, removeOpenCode, setupOpenCode } from "./setup-opencode.ts";
import { runHarnessLifecycle, type HarnessCli } from "./setup-adapters.ts";
import { ensureSetupDirectory, mutateSetupConfiguration, readSetupConfiguration, readSetupConfigurationSnapshot, SetupConfigurationChangedError } from "./setup-files.ts";
import { assertSafeSetupCommand, setupHooksConfigured } from "./setup-hook-status.ts";
import { mergeSetupHooks, removeSetupHooks, removeSharedSetupHooks, validateSetupHooks } from "./setup-hooks.ts";
import { claudeConfigPath, SETUP_HARNESSES, setupPath, type SetupHarness } from "./setup-targets.ts";

type HookHarness = Exclude<CaptureHarness, "claude">;

export type SetupOptions = { readonly home?: string; readonly command: string; readonly env?: NodeJS.ProcessEnv };
export type SetupReport = { readonly harness: SetupHarness; readonly action: "setup"; readonly status: "complete" | "manual-required"; readonly nativeCli: HarnessCli | null; readonly hooks: { readonly path: string; readonly changed: boolean }; readonly mcp?: { readonly path: string; readonly changed: boolean }; readonly guide: string };
export type RemoveOptions = { readonly home?: string; readonly env?: NodeJS.ProcessEnv };
export type RemoveReport = { readonly harness: SetupHarness; readonly action: "remove"; readonly status: "complete" | "manual-required" | "shared-retained"; readonly nativeCli: HarnessCli | null; readonly hooks: { readonly path: string; readonly changed: boolean }; readonly mcp?: { readonly path: string; readonly changed: boolean }; readonly guide: string };
export type SetupStatusOptions = { readonly home?: string };
export type HarnessSetupStatus = { readonly hooksConfigured: boolean; readonly path: string; readonly mcpConfigured?: boolean };

export function setupHarness(harness: SetupHarness, options: SetupOptions): SetupReport {
  if (harness === "opencode") return setupOpenCode(options);
  if (harness === "claude") return claudeReport("setup", options.home, options.env);
  const target = setupPath(harness, options.home);
  const command = options.command.trim();
  assertSafeSetupCommand(command);
  const snapshot = readSetupConfigurationSnapshot(target);
  validateSetupHooks(harness, snapshot.configuration, target);
  ensureSetupDirectory(path.dirname(target));
  const native = runHarnessLifecycle(harness, "setup", options.env ? { env: options.env, command } : { command });
  const changed = finishHookUpdate("setup", harness, native.status, target, () => updateHooks(harness, native.status, target, command, snapshot.hash));
  return { harness, action: "setup", status: native.status === "native-complete" ? "complete" : "manual-required", nativeCli: native.nativeCli, hooks: { path: target, changed }, guide: native.guide };
}

export function removeHarness(harness: SetupHarness, options: RemoveOptions = {}): RemoveReport {
  if (harness === "opencode") return removeOpenCode(options);
  if (harness === "claude") return claudeReport("remove", options.home, options.env);
  const target = setupPath(harness, options.home);
  const snapshot = readSetupConfigurationSnapshot(target);
  validateSetupHooks(harness, snapshot.configuration, target);
  const native = runHarnessLifecycle(harness, "remove", options.env ? { env: options.env } : {});
  const changed = finishHookUpdate("remove", harness, native.status, target, () => removeHooks(harness, target, snapshot.configuration !== undefined, snapshot.hash));
  return { harness, action: "remove", status: native.status === "native-complete" ? "complete" : native.status, nativeCli: native.nativeCli, hooks: { path: target, changed }, guide: native.guide };
}

export function setupStatus(options: SetupStatusOptions = {}): Record<SetupHarness, HarnessSetupStatus> {
  const statuses: Record<SetupHarness, HarnessSetupStatus> = {
    codex: { hooksConfigured: false, path: "" },
    cursor: { hooksConfigured: false, path: "" },
    vscode: { hooksConfigured: false, path: "" },
    copilot: { hooksConfigured: false, path: "" },
    kiro: { hooksConfigured: false, path: "" },
    claude: { hooksConfigured: false, path: "" },
    opencode: { hooksConfigured: false, path: "" },
  };
  for (const harness of SETUP_HARNESSES) {
    if (harness === "claude") statuses[harness] = { hooksConfigured: false, path: claudeConfigPath(options.home) };
    else if (harness === "opencode") statuses[harness] = openCodeSetupStatus(options);
    else {
      const target = setupPath(harness, options.home);
      statuses[harness] = { hooksConfigured: setupHooksConfigured(harness, readConfigurationForStatus(target)), path: target };
    }
  }
  return statuses;
}

function claudeReport(action: "setup", home: string | undefined, env: NodeJS.ProcessEnv | undefined): SetupReport;
function claudeReport(action: "remove", home: string | undefined, env: NodeJS.ProcessEnv | undefined): RemoveReport;
function claudeReport(action: "setup" | "remove", home: string | undefined, env: NodeJS.ProcessEnv | undefined): SetupReport | RemoveReport {
  const native = runHarnessLifecycle("claude", action, env ? { env } : {});
  return { harness: "claude", action, status: native.status === "native-complete" ? "complete" : "manual-required", nativeCli: native.nativeCli, hooks: { path: claudeConfigPath(home), changed: false }, guide: native.guide };
}

function updateHooks(harness: HookHarness, nativeStatus: "native-complete" | "manual-required" | "shared-retained", target: string, command: string, expectedHash: string): boolean {
  if (harness !== "kiro" && nativeStatus !== "native-complete") return false;
  return mutateSetupConfiguration(target, (existing) => {
    if (harness === "kiro") return mergeSetupHooks(existing, harness, command, target);
    if (harness === "codex" && nativeStatus === "native-complete") return existing === undefined ? undefined : removeSetupHooks(existing, harness, target);
    if ((harness === "copilot" || harness === "vscode") && nativeStatus === "native-complete") return existing === undefined ? undefined : removeSharedSetupHooks(existing, harness, target);
    return existing;
  }, expectedHash);
}

function removeHooks(harness: HookHarness, target: string, targetExists: boolean, expectedHash: string): boolean {
  if (harness === "copilot" || harness === "vscode" || (!targetExists && harness !== "codex")) return false;
  return mutateSetupConfiguration(target, (existing) => existing === undefined ? undefined : removeSetupHooks(existing, harness, target), expectedHash);
}

function finishHookUpdate(action: "setup" | "remove", harness: CaptureHarness, nativeStatus: "native-complete" | "manual-required" | "shared-retained", target: string, update: () => boolean): boolean {
  try {
    return update();
  } catch (error) {
    if (error instanceof SetupConfigurationChangedError) {
      const result = nativeStatus === "native-complete" ? `Native ${harness} ${action} completed` : `${harness} ${action} stopped`;
      throw new Error(`${result}, but Agent LCM detected a concurrent change to ${target} and did not overwrite it. Repair it if needed, then rerun agent-lcm ${action} ${harness}.`, { cause: error });
    }
    if (nativeStatus !== "native-complete") throw error;
    throw new Error(`Native ${harness} ${action} completed, but Agent LCM could not safely update ${target}. Inspect the hook file because the local update may have completed. Repair it if needed, then rerun agent-lcm ${action} ${harness}.`, { cause: error });
  }
}

function readConfigurationForStatus(target: string): Record<string, unknown> | undefined {
  try {
    return readSetupConfiguration(target);
  } catch {
    return undefined;
  }
}
