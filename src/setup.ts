import type { CaptureHarness } from "./harnesses.ts";
import { runHarnessLifecycle } from "./setup-adapters.ts";
import { mutateSetupConfiguration, readSetupConfiguration } from "./setup-files.ts";
import { assertSafeSetupCommand, setupHooksConfigured } from "./setup-hook-status.ts";
import {
  mergeSetupHooks,
  removeSharedSetupHooks,
  validateSetupHooks,
} from "./setup-hooks.ts";
import { SETUP_HARNESSES, setupPath } from "./setup-targets.ts";

export type SetupOptions = { readonly home?: string; readonly command: string; readonly env?: NodeJS.ProcessEnv };
export type SetupReport = {
  readonly harness: CaptureHarness;
  readonly action: "setup";
  readonly status: "complete" | "manual-required";
  readonly nativeCli: "codex" | "copilot" | null;
  readonly hooks: { readonly path: string; readonly changed: boolean };
  readonly guide: string;
};
export type SetupStatusOptions = { readonly home?: string };
export type HarnessSetupStatus = { readonly configured: boolean; readonly path: string };

export function setupHarness(harness: CaptureHarness, options: SetupOptions): SetupReport {
  const target = setupPath(harness, options.home);
  const command = options.command.trim();
  assertSafeSetupCommand(command);
  const existing = readSetupConfiguration(target);
  validateSetupHooks(harness, existing, target);
  const native = runHarnessLifecycle(harness, "setup", options.env ? { env: options.env } : {});
  const changed = updateHooks(harness, native.status, target, command, existing !== undefined);
  return {
    harness,
    action: "setup",
    status: native.status === "native-complete" ? "complete" : "manual-required",
    nativeCli: native.nativeCli,
    hooks: { path: target, changed },
    guide: native.guide,
  };
}

export function setupStatus(options: SetupStatusOptions = {}): Record<CaptureHarness, HarnessSetupStatus> {
  return Object.fromEntries(SETUP_HARNESSES.map((harness) => {
    const target = setupPath(harness, options.home);
    return [harness, { configured: setupHooksConfigured(harness, readConfigurationForStatus(target)), path: target }];
  })) as Record<CaptureHarness, HarnessSetupStatus>;
}

function updateHooks(
  harness: CaptureHarness,
  nativeStatus: "native-complete" | "manual-required" | "shared-retained",
  target: string,
  command: string,
  targetExists: boolean,
): boolean {
  if (harness === "codex" || harness === "kiro") {
    return mutateSetupConfiguration(target, (existing) => mergeSetupHooks(existing, harness, command, target));
  }
  if ((harness === "copilot" || harness === "vscode") && nativeStatus === "native-complete" && targetExists) {
    return mutateSetupConfiguration(target, (existing) => removeSharedSetupHooks(existing ?? {}, harness, target));
  }
  return false;
}

function readConfigurationForStatus(target: string): Record<string, unknown> | undefined {
  try {
    return readSetupConfiguration(target);
  } catch {
    return undefined;
  }
}
