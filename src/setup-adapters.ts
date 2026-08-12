import { spawnSync } from "node:child_process";
import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { withCopilotPluginSource } from "./copilot-plugin.ts";
import { ClaudeLifecycleOutputError, runClaudeLifecycle } from "./claude-lifecycle.ts";
import type { CaptureHarness } from "./harnesses.ts";

export type HarnessLifecycleAction = "setup" | "remove";
export type HarnessCli = "codex" | "copilot" | "cursor-agent" | "kiro-cli" | "claude";

export type HarnessLifecycleOutcome = {
  readonly harness: CaptureHarness;
  readonly action: HarnessLifecycleAction;
  readonly status: "native-complete" | "manual-required" | "shared-retained";
  readonly nativeCli: HarnessCli | null;
  readonly guide: string;
};

export class NativeLifecycleCommandError extends Error {
  readonly name = "NativeLifecycleCommandError";
  readonly executable: HarnessCli;
  readonly argv: readonly string[];
  readonly status: number | null;
  readonly stderr: string;

  constructor(
    executable: HarnessCli,
    argv: readonly string[],
    status: number | null,
    stderr: string,
  ) {
    super(`Native lifecycle command failed: executable=${executable} argv=${argv.join(" ")} status=${String(status)} stderr=${stderr}`);
    this.executable = executable;
    this.argv = argv;
    this.status = status;
    this.stderr = stderr;
  }
}

type CodexLifecycleAdapter = {
  readonly kind: "codex";
  readonly executable: "codex";
  readonly guide: string;
  readonly probeArgv: readonly string[];
  readonly setupArgv: readonly (readonly string[])[];
  readonly removeArgv: readonly string[];
};

type CopilotLifecycleAdapter = {
  readonly kind: "copilot";
  readonly executable: "copilot";
  readonly guide: string;
  readonly probeArgv: readonly string[];
};

type ClaudeLifecycleAdapter = {
  readonly kind: "claude";
  readonly executable: "claude";
  readonly guide: string;
};

type ManualLifecycleAdapter = {
  readonly kind: "manual";
  readonly executable: "cursor-agent" | "kiro-cli";
  readonly probeArgv: readonly string[];
  readonly guide: string;
};

export type HarnessLifecycleAdapter = CodexLifecycleAdapter | CopilotLifecycleAdapter | ClaudeLifecycleAdapter | ManualLifecycleAdapter;

const GUIDE_ROOT = "https://github.com/Team-Volt/agent-lcm/blob/main/docs/install";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUPPRESSED_STDERR = "suppressed";

export const HARNESS_LIFECYCLE_ADAPTERS = {
  codex: {
    kind: "codex",
    executable: "codex",
    guide: `${GUIDE_ROOT}/codex.md`,
    probeArgv: ["plugin", "list"],
    setupArgv: [
      ["plugin", "marketplace", "add", PACKAGE_ROOT],
      ["plugin", "add", "agent-lcm@agent-lcm"],
    ],
    removeArgv: ["plugin", "remove", "agent-lcm@agent-lcm"],
  },
  cursor: { kind: "manual", executable: "cursor-agent", probeArgv: ["--version"], guide: `${GUIDE_ROOT}/cursor.md` },
  vscode: {
    kind: "copilot",
    executable: "copilot",
    guide: `${GUIDE_ROOT}/vscode.md`,
    probeArgv: ["plugin", "list"],
  },
  copilot: {
    kind: "copilot",
    executable: "copilot",
    guide: `${GUIDE_ROOT}/copilot.md`,
    probeArgv: ["plugin", "list"],
  },
  kiro: { kind: "manual", executable: "kiro-cli", probeArgv: ["--version"], guide: `${GUIDE_ROOT}/kiro.md` },
  claude: { kind: "claude", executable: "claude", guide: `${GUIDE_ROOT}/claude.md` },
} satisfies Record<CaptureHarness, HarnessLifecycleAdapter>;

export function runHarnessLifecycle(
  harness: CaptureHarness,
  action: HarnessLifecycleAction,
  options: { readonly env?: NodeJS.ProcessEnv; readonly command?: string } = {},
): HarnessLifecycleOutcome {
  const adapter = HARNESS_LIFECYCLE_ADAPTERS[harness];
  switch (adapter.kind) {
    case "manual":
      return manualOutcome(harness, action, adapter, options.env);
    case "copilot":
      if (action === "remove") return outcome(harness, action, "shared-retained", null, adapter.guide);
      return runNative(harness, action, adapter, options.env, options.command);
    case "codex":
      return runNative(harness, action, adapter, options.env);
    case "claude":
      try {
        return runClaude("claude", action, adapter, options.env);
      } catch (error) {
        if (error instanceof ClaudeCliUnavailableError) {
          return outcome(harness, action, "manual-required", null, adapter.guide);
        }
        throw error;
      }
    default:
      return assertNever(adapter);
  }
}

function runClaude(harness: "claude", action: HarnessLifecycleAction, adapter: ClaudeLifecycleAdapter, env: NodeJS.ProcessEnv | undefined): HarnessLifecycleOutcome {
  try {
    runClaudeLifecycle(action, PACKAGE_ROOT, (argv) => runClaudeCommand(adapter.executable, argv, env));
  } catch (error) {
    if (error instanceof ClaudeLifecycleOutputError) {
      throw new NativeLifecycleCommandError(adapter.executable, error.argv, 0, SUPPRESSED_STDERR);
    }
    throw error;
  }
  return outcome(harness, action, "native-complete", adapter.executable, adapter.guide);
}

function runClaudeCommand(
  executable: "claude",
  argv: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
): string {
  const result = spawnLifecycleCommand(executable, argv, env);
  if (isEnoent(result.error)) throw new ClaudeCliUnavailableError();
  if (result.error !== undefined || result.status !== 0) {
    throw new NativeLifecycleCommandError(executable, argv, result.status, SUPPRESSED_STDERR);
  }
  return result.stdout;
}

class ClaudeCliUnavailableError extends Error {
  readonly name = "ClaudeCliUnavailableError";
}


function runNative(
  harness: CaptureHarness,
  action: HarnessLifecycleAction,
  adapter: CodexLifecycleAdapter | CopilotLifecycleAdapter,
  env: NodeJS.ProcessEnv | undefined,
  command?: string,
): HarnessLifecycleOutcome {
  const probe = spawnLifecycleCommand(adapter.executable, adapter.probeArgv, env);
  if (isEnoent(probe.error)) {
    return outcome(harness, action, "manual-required", null, adapter.guide);
  }
  if (probe.error !== undefined || probe.status !== 0) {
    throw new NativeLifecycleCommandError(adapter.executable, adapter.probeArgv, probe.status, SUPPRESSED_STDERR);
  }

  if (action === "setup" && adapter.kind === "copilot") {
    withCopilotPluginSource(command ?? path.join(PACKAGE_ROOT, "bin", "agent-lcm"), (source) => {
      runNativeCommand(adapter.executable, ["plugin", "install", source], env);
    });
  } else if (adapter.kind === "codex") {
    const commands = action === "setup" ? adapter.setupArgv : [adapter.removeArgv];
    for (const argv of commands) runNativeCommand(adapter.executable, argv, env);
  } else {
    throw new Error("Copilot removal must retain the shared plugin.");
  }
  return outcome(harness, action, "native-complete", adapter.executable, adapter.guide);
}

function manualOutcome(
  harness: CaptureHarness,
  action: HarnessLifecycleAction,
  adapter: ManualLifecycleAdapter,
  env: NodeJS.ProcessEnv | undefined,
): HarnessLifecycleOutcome {
  const probe = spawnLifecycleCommand(adapter.executable, adapter.probeArgv, env);
  if (isEnoent(probe.error)) return outcome(harness, action, "manual-required", null, adapter.guide);
  if (probe.error !== undefined || probe.status !== 0) {
    throw new NativeLifecycleCommandError(adapter.executable, adapter.probeArgv, probe.status, SUPPRESSED_STDERR);
  }
  return outcome(harness, action, "manual-required", adapter.executable, adapter.guide);
}

function runNativeCommand(executable: "codex" | "copilot" | "claude", argv: readonly string[], env: NodeJS.ProcessEnv | undefined): void {
  const result = spawnLifecycleCommand(executable, argv, env);
  if (result.status === 0) return;
  throw new NativeLifecycleCommandError(executable, argv, result.status, SUPPRESSED_STDERR);
}

function spawnLifecycleCommand(executable: HarnessCli, argv: readonly string[], env: NodeJS.ProcessEnv | undefined) {
  const options: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8", env, shell: false, stdio: ["ignore", "pipe", "pipe"] };
  const direct = spawnSync(executable, argv, options);
  if (process.platform !== "win32" || !needsWindowsShim(direct.error)) return direct;

  const shim = resolveWindowsShim(executable, argv, env);
  if (shim === null) return direct;
  assertSafeWindowsCommand([shim, ...argv], executable, argv);
  const result = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", shim, ...argv], options);
  if (isEnoent(result.error)) {
    throw new NativeLifecycleCommandError(executable, argv, result.status, SUPPRESSED_STDERR);
  }
  return result;
}

function resolveWindowsShim(executable: HarnessCli, argv: readonly string[], env: NodeJS.ProcessEnv | undefined): string | null {
  const commandEnv = env ?? process.env;
  const searchPath = Object.entries(commandEnv).find(([key]) => key.toUpperCase() === "PATH")?.[1];
  if (searchPath === undefined) return null;
  for (const entry of searchPath.split(path.delimiter)) {
    const directory = entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;
    if (directory.length === 0) continue;
    for (const extension of [".cmd", ".bat"] as const) {
      const candidate = path.join(directory, `${executable}${extension}`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch (error) {
        if (isMissingPathError(error)) continue;
        throw new NativeLifecycleCommandError(executable, argv, null, SUPPRESSED_STDERR);
      }
    }
  }
  return null;
}

function assertSafeWindowsCommand(values: readonly string[], executable: HarnessCli, argv: readonly string[]): void {
  if (values.some((value) => /["&|<>^%!\r\n]/u.test(value))) {
    throw new NativeLifecycleCommandError(executable, argv, null, SUPPRESSED_STDERR);
  }
}

function outcome(
  harness: CaptureHarness,
  action: HarnessLifecycleAction,
  status: HarnessLifecycleOutcome["status"],
  nativeCli: HarnessLifecycleOutcome["nativeCli"],
  guide: string,
): HarnessLifecycleOutcome {
  return { harness, action, status, nativeCli, guide };
}

function isEnoent(error: Error | undefined): boolean {
  return error !== undefined && "code" in error && error.code === "ENOENT";
}

function needsWindowsShim(error: Error | undefined): boolean {
  return error !== undefined && "code" in error && (error.code === "ENOENT" || error.code === "EINVAL");
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}

function assertNever(value: never): never {
  throw new Error(`Unexpected lifecycle adapter: ${JSON.stringify(value)}`);
}
