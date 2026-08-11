import { spawnSync } from "node:child_process";

import type { CaptureHarness } from "./harnesses.ts";

export type HarnessLifecycleAction = "setup" | "remove";
export type HarnessCli = "codex" | "copilot" | "cursor-agent" | "kiro-cli";

export type HarnessLifecycleOutcome = {
  readonly harness: CaptureHarness;
  readonly action: HarnessLifecycleAction;
  readonly status: "native-complete" | "manual-required" | "shared-retained";
  readonly nativeCli: HarnessCli | null;
  readonly guide: string;
};

export class NativeLifecycleCommandError extends Error {
  readonly name = "NativeLifecycleCommandError";
  readonly executable: "codex" | "copilot";
  readonly argv: readonly string[];
  readonly status: number | null;
  readonly stderr: string;

  constructor(
    executable: "codex" | "copilot",
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
  readonly setupArgv: readonly (readonly string[])[];
};

type ManualLifecycleAdapter = {
  readonly kind: "manual";
  readonly executable: "cursor-agent" | "kiro-cli";
  readonly probeArgv: readonly string[];
  readonly guide: string;
};

export type HarnessLifecycleAdapter = CodexLifecycleAdapter | CopilotLifecycleAdapter | ManualLifecycleAdapter;

const GUIDE_ROOT = "https://github.com/Team-Volt/agent-lcm/blob/main/docs/install";
const MAX_STDERR_CHARS = 4_096;

export const HARNESS_LIFECYCLE_ADAPTERS = {
  codex: {
    kind: "codex",
    executable: "codex",
    guide: `${GUIDE_ROOT}/codex.md`,
    probeArgv: ["plugin", "list"],
    setupArgv: [
      ["plugin", "marketplace", "add", "Team-Volt/agent-lcm"],
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
    setupArgv: [["plugin", "install", "Team-Volt/agent-lcm"]],
  },
  copilot: {
    kind: "copilot",
    executable: "copilot",
    guide: `${GUIDE_ROOT}/copilot.md`,
    probeArgv: ["plugin", "list"],
    setupArgv: [["plugin", "install", "Team-Volt/agent-lcm"]],
  },
  kiro: { kind: "manual", executable: "kiro-cli", probeArgv: ["--version"], guide: `${GUIDE_ROOT}/kiro.md` },
} satisfies Record<CaptureHarness, HarnessLifecycleAdapter>;

export function runHarnessLifecycle(
  harness: CaptureHarness,
  action: HarnessLifecycleAction,
  options: { readonly env?: NodeJS.ProcessEnv } = {},
): HarnessLifecycleOutcome {
  const adapter = HARNESS_LIFECYCLE_ADAPTERS[harness];
  switch (adapter.kind) {
    case "manual":
      return manualOutcome(harness, action, adapter, options.env);
    case "copilot":
      if (action === "remove") return outcome(harness, action, "shared-retained", null, adapter.guide);
      return runNative(harness, action, adapter, options.env);
    case "codex":
      return runNative(harness, action, adapter, options.env);
    default:
      return assertNever(adapter);
  }
}

function runNative(
  harness: CaptureHarness,
  action: HarnessLifecycleAction,
  adapter: CodexLifecycleAdapter | CopilotLifecycleAdapter,
  env: NodeJS.ProcessEnv | undefined,
): HarnessLifecycleOutcome {
  const probe = spawnSync(adapter.executable, adapter.probeArgv, { encoding: "utf8", env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  if (isEnoent(probe.error) || probe.status !== 0) {
    return outcome(harness, action, "manual-required", null, adapter.guide);
  }

  const commands = action === "setup"
    ? adapter.setupArgv
    : adapter.kind === "codex" ? [adapter.removeArgv] : [];
  for (const argv of commands) runNativeCommand(adapter.executable, argv, env);
  return outcome(harness, action, "native-complete", adapter.executable, adapter.guide);
}

function manualOutcome(
  harness: CaptureHarness,
  action: HarnessLifecycleAction,
  adapter: ManualLifecycleAdapter,
  env: NodeJS.ProcessEnv | undefined,
): HarnessLifecycleOutcome {
  const probe = spawnSync(adapter.executable, adapter.probeArgv, { encoding: "utf8", env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const nativeCli = isEnoent(probe.error) || probe.status !== 0 ? null : adapter.executable;
  return outcome(harness, action, "manual-required", nativeCli, adapter.guide);
}

function runNativeCommand(executable: "codex" | "copilot", argv: readonly string[], env: NodeJS.ProcessEnv | undefined): void {
  const result = spawnSync(executable, argv, { encoding: "utf8", env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status === 0) return;
  throw new NativeLifecycleCommandError(executable, argv, result.status, boundedStderr(result.stderr));
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

function boundedStderr(stderr: string | Buffer | null | undefined): string {
  const value = typeof stderr === "string" ? stderr : stderr?.toString("utf8") ?? "";
  return value.slice(0, MAX_STDERR_CHARS).trimEnd();
}

function isEnoent(error: Error | undefined): boolean {
  return error !== undefined && "code" in error && error.code === "ENOENT";
}

function assertNever(value: never): never {
  throw new Error(`Unexpected lifecycle adapter: ${JSON.stringify(value)}`);
}
