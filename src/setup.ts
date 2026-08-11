import path from "node:path";

import type { CaptureHarness } from "./harnesses.ts";
import { runHarnessLifecycle, type HarnessCli } from "./setup-adapters.ts";
import {
  ensureSetupDirectory,
  mutateSetupConfiguration,
  readSetupConfiguration,
  readSetupConfigurationSnapshot,
  SetupConfigurationChangedError,
} from "./setup-files.ts";
import { assertSafeSetupCommand, setupHooksConfigured } from "./setup-hook-status.ts";
import {
  mergeSetupHooks,
  removeSetupHooks,
  removeSharedSetupHooks,
  validateSetupHooks,
} from "./setup-hooks.ts";
import { SETUP_HARNESSES, setupPath } from "./setup-targets.ts";

export type SetupOptions = { readonly home?: string; readonly command: string; readonly env?: NodeJS.ProcessEnv };
export type SetupReport = {
  readonly harness: CaptureHarness;
  readonly action: "setup";
  readonly status: "complete" | "manual-required";
  readonly nativeCli: HarnessCli | null;
  readonly hooks: { readonly path: string; readonly changed: boolean };
  readonly guide: string;
};
export type RemoveOptions = { readonly home?: string; readonly env?: NodeJS.ProcessEnv };
export type RemoveReport = {
  readonly harness: CaptureHarness;
  readonly action: "remove";
  readonly status: "complete" | "manual-required" | "shared-retained";
  readonly nativeCli: HarnessCli | null;
  readonly hooks: { readonly path: string; readonly changed: boolean };
  readonly guide: string;
};
export type SetupStatusOptions = { readonly home?: string };
export type HarnessSetupStatus = { readonly hooksConfigured: boolean; readonly path: string };

export function setupHarness(harness: CaptureHarness, options: SetupOptions): SetupReport {
  const target = setupPath(harness, options.home);
  const command = options.command.trim();
  assertSafeSetupCommand(command);
  const snapshot = readSetupConfigurationSnapshot(target);
  const existing = snapshot.configuration;
  validateSetupHooks(harness, existing, target);
  ensureSetupDirectory(path.dirname(target));
  const native = runHarnessLifecycle(harness, "setup", options.env ? { env: options.env, command } : { command });
  const changed = finishHookUpdate("setup", harness, native.status, target, () => (
    updateHooks(harness, native.status, target, command, snapshot.hash)
  ));
  return {
    harness,
    action: "setup",
    status: native.status === "native-complete" ? "complete" : "manual-required",
    nativeCli: native.nativeCli,
    hooks: { path: target, changed },
    guide: native.guide,
  };
}

export function removeHarness(harness: CaptureHarness, options: RemoveOptions = {}): RemoveReport {
  const target = setupPath(harness, options.home);
  const snapshot = readSetupConfigurationSnapshot(target);
  const existing = snapshot.configuration;
  validateSetupHooks(harness, existing, target);
  const native = runHarnessLifecycle(harness, "remove", options.env ? { env: options.env } : {});
  const changed = finishHookUpdate("remove", harness, native.status, target, () => (
    removeHooks(harness, target, existing !== undefined, snapshot.hash)
  ));
  return {
    harness,
    action: "remove",
    status: native.status === "native-complete" ? "complete" : native.status,
    nativeCli: native.nativeCli,
    hooks: { path: target, changed },
    guide: native.guide,
  };
}

export function setupStatus(options: SetupStatusOptions = {}): Record<CaptureHarness, HarnessSetupStatus> {
  return Object.fromEntries(SETUP_HARNESSES.map((harness) => {
    const target = setupPath(harness, options.home);
    return [harness, { hooksConfigured: setupHooksConfigured(harness, readConfigurationForStatus(target)), path: target }];
  })) as Record<CaptureHarness, HarnessSetupStatus>;
}

function updateHooks(
  harness: CaptureHarness,
  nativeStatus: "native-complete" | "manual-required" | "shared-retained",
  target: string,
  command: string,
  expectedHash: string,
): boolean {
  if (harness !== "kiro" && nativeStatus !== "native-complete") return false;
  return mutateSetupConfiguration(target, (existing) => {
    if (harness === "kiro") return mergeSetupHooks(existing, harness, command, target);
    if (harness === "codex" && nativeStatus === "native-complete") {
      return existing === undefined ? undefined : removeSetupHooks(existing, harness, target);
    }
    if ((harness === "copilot" || harness === "vscode") && nativeStatus === "native-complete") {
      return existing === undefined ? undefined : removeSharedSetupHooks(existing, harness, target);
    }
    return existing;
  }, expectedHash);
}

function removeHooks(harness: CaptureHarness, target: string, targetExists: boolean, expectedHash: string): boolean {
  if (harness === "copilot" || harness === "vscode" || (!targetExists && harness !== "codex")) return false;
  return mutateSetupConfiguration(target, (existing) => existing === undefined
    ? undefined
    : removeSetupHooks(existing, harness, target), expectedHash);
}

function finishHookUpdate(
  action: "setup" | "remove",
  harness: CaptureHarness,
  nativeStatus: "native-complete" | "manual-required" | "shared-retained",
  target: string,
  update: () => boolean,
): boolean {
  try {
    return update();
  } catch (error) {
    if (error instanceof SetupConfigurationChangedError) {
      const result = nativeStatus === "native-complete"
        ? `Native ${harness} ${action} completed`
        : `${harness} ${action} stopped`;
      throw new Error(
        `${result}, but Agent LCM detected a concurrent change to ${target} and did not overwrite it. `
        + `Repair it if needed, then rerun agent-lcm ${action} ${harness}.`,
        { cause: error },
      );
    }
    if (nativeStatus !== "native-complete") throw error;
    throw new Error(
      `Native ${harness} ${action} completed, but Agent LCM could not safely update ${target}. `
      + `Inspect the hook file because the local update may have completed. `
      + `Repair it if needed, then rerun agent-lcm ${action} ${harness}.`,
      { cause: error },
    );
  }
}

function readConfigurationForStatus(target: string): Record<string, unknown> | undefined {
  try {
    return readSetupConfiguration(target);
  } catch {
    return undefined;
  }
}
