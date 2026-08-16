import path from "node:path";

import { loadConfig, pluginRoot } from "./config.ts";
import { runLongContextBenchmark, runRetrievalQualityBenchmark } from "./benchmark.ts";
import { buildDoctorReport } from "./doctor.ts";
import { daemonRequest, daemonStatus, ensureDaemon, stopDaemon } from "./daemon-client.ts";
import { startDaemon } from "./daemon.ts";
import { importSessions, type ImportHarness, type ImportOptions, type ImportProgress, type ImportReport } from "./import.ts";
import { runCapture, runHook } from "./hook.ts";
import type { CaptureHarness } from "./harnesses.ts";
import { readStatus } from "./installer.ts";
import { startMcpServer } from "./mcp.ts";
import { packageVersion } from "./release.ts";
import { removeHarness, setupHarness, setupStatus, type RemoveReport, type SetupReport } from "./setup.ts";
import { detectedHarnesses } from "./setup-targets.ts";

type DaemonCliParams =
  | { command: "health" | "stats" }
  | { command: "maintain" }
  | { command: "cleanup"; apply: boolean }
  | {
    command: "sessions";
    since?: string;
    until?: string;
    cwd?: string;
    repoRoot?: string;
    parentSessionId?: string;
    rootsOnly: boolean;
    includeSummaries: boolean;
    limit?: number;
    cursor?: string;
  }
  | {
    command: "usage";
    since?: string;
    until?: string;
    cwd?: string;
    repoRoot?: string;
    parentSessionId?: string;
    rootsOnly: boolean;
  }
  | {
    command: "context-plan";
    sessionId?: string;
    cwd?: string;
    repoRoot?: string;
    modelContextWindow?: number;
    autoCompactTokenLimit?: number;
    recentEventLimit?: number;
  }
  ;

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${packageVersion()}\n`);
    return;
  }
  if (command === "--help" || command === "-h" || command === undefined) {
    printHelp();
    return;
  }
  if (command === "mcp") {
    startMcpServer();
    return;
  }
  if (command === "hook") {
    await runHook(rest);
    return;
  }
  if (command === "capture") {
    await runCapture(rest);
    return;
  }
  if (command === "setup") {
    if (rest[0] === "status") {
      printObjectOrText(setupStatus({ home: optionValue(rest, "--home") }));
      return;
    }
    const commandPath = path.resolve(process.argv[1] ?? path.join(pluginRoot(), "bin", "agent-lcm"));
    if (rest[0] === "all" || rest[0] === "--all") {
      if (optionValue(rest, "--home")) throw new Error("--home cannot be used with setup all.");
      printSetupReports(
        detectedHarnesses().map((harness) => setupHarness(harness, { command: commandPath })),
        rest.includes("--json"),
      );
      return;
    }
    const harness = captureHarness(rest[0]);
    const home = optionValue(rest, "--home");
    printSetupReports(setupHarness(harness, {
      home,
      command: commandPath,
      ...(home ? { env: lifecycleEnvironment(harness, home) } : {}),
    }), rest.includes("--json"));
    return;
  }
  if (command === "remove") {
    const harness = captureHarness(rest[0], "remove");
    const home = optionValue(rest, "--home");
    printSetupReports(removeHarness(harness, {
      home,
      ...(home ? { env: lifecycleEnvironment(harness, home) } : {}),
    }), rest.includes("--json"));
    return;
  }
  if (command === "daemon") {
    const config = loadConfig();
    if (rest[0] === "run") {
      await startDaemon(config);
      return;
    }
    if (rest[0] === "start" || rest[0] === "restart") {
      if (rest[0] === "restart") await stopDaemon(config);
      await ensureDaemon(config);
      printObjectOrText(await daemonStatus(config));
      return;
    }
    if (rest[0] === "status") {
      printObjectOrText(await daemonStatus(config));
      return;
    }
    if (rest[0] === "stop") {
      await stopDaemon(config);
      printObjectOrText(await daemonStatus(config));
      return;
    }
    throw new Error("Usage: agent-lcm daemon run|start|restart|status|stop");
  }
  if (command === "status") {
    printObjectOrText(readStatus({ codexHome: optionValue(rest, "--codex-home"), root: pluginRoot() }));
    return;
  }
  if (command === "doctor") {
    const config = loadConfig();
    await ensureDaemon(config);
    printObjectOrText(buildDoctorReport({
      status: readStatus({ codexHome: optionValue(rest, "--codex-home"), root: pluginRoot() }),
      health: await daemonCli(config, { command: "health" }),
      daemon: await daemonStatus(config),
    }));
    return;
  }
  if (command === "import-codex-sessions") {
    if (rest.includes("--batch-size")) throw new Error("--batch-size is not supported; imports use durable batches.");
    const dryRun = rest.includes("--dry-run");
    const from = optionValue(rest, "--from");
    const report = await importWithProgress({ harness: "codex", ...(from ? { paths: [from] } : {}), config: loadConfig(), dryRun });
    printObjectOrText(report);
    return;
  }
  if (command === "import") {
    const all = rest.includes("--all");
    if (all && rest.includes("--harness")) throw new Error("Pass exactly one of --all or --harness.");
    const harness = all ? undefined : importHarness(optionValue(rest, "--harness"));
    const source = rest.find((item, index) => index > 0 && !item.startsWith("--") && rest[index - 1] !== "--harness");
    const report = await importWithProgress({
      ...(all ? { all: true } : { harness }),
      ...(source ? { paths: [source] } : {}),
      config: loadConfig(),
      dryRun: rest.includes("--dry-run"),
    });
    printObjectOrText(report);
    return;
  }
  if (command === "benchmark") {
    const benchmarkName = rest[0];
    if (benchmarkName === "long-context") {
      printObjectOrText(runLongContextBenchmark({
        events: numberOptionValue(rest, "--events"),
        budgetTokens: numberOptionValue(rest, "--budget-tokens"),
        home: optionValue(rest, "--home"),
      }));
      return;
    }
    if (benchmarkName === "retrieval-quality") {
      printObjectOrText(runRetrievalQualityBenchmark({
        home: optionValue(rest, "--home"),
      }));
      return;
    }
    throw new Error("Usage: agent-lcm benchmark long-context|retrieval-quality [options] [--json]");
  }
  if (command === "health") {
    printObjectOrText(await daemonCli(loadConfig(), { command: "health" }));
    return;
  }
  if (command === "stats") {
    printObjectOrText(await daemonCli(loadConfig(), { command: "stats" }));
    return;
  }
  if (command === "cleanup") {
    const apply = rest.includes("--apply");
    printObjectOrText(await daemonCli(loadConfig(), { command: "cleanup", apply }));
    return;
  }
  if (command === "maintain") {
    if (!rest.includes("--once")) throw new Error("Usage: agent-lcm maintain --once [--json]");
    printObjectOrText(await daemonCli(loadConfig(), { command: "maintain" }));
    return;
  }
  if (command === "sessions") {
    printObjectOrText(await daemonCli(loadConfig(), {
      command: "sessions",
      since: optionValue(rest, "--since"),
      until: optionValue(rest, "--until"),
      cwd: optionValue(rest, "--cwd"),
      repoRoot: optionValue(rest, "--repo-root"),
      parentSessionId: optionValue(rest, "--parent-session-id"),
      rootsOnly: rest.includes("--roots-only"),
      includeSummaries: rest.includes("--include-summaries"),
      limit: numberOptionValue(rest, "--limit"),
      cursor: optionValue(rest, "--cursor"),
    }));
    return;
  }
  if (command === "usage") {
    printObjectOrText(await daemonCli(loadConfig(), {
      command: "usage",
      since: optionValue(rest, "--since"),
      until: optionValue(rest, "--until"),
      cwd: optionValue(rest, "--cwd"),
      repoRoot: optionValue(rest, "--repo-root"),
      parentSessionId: optionValue(rest, "--parent-session-id"),
      rootsOnly: rest.includes("--roots-only"),
    }));
    return;
  }
  if (command === "context-plan") {
    printObjectOrText(await daemonCli(loadConfig(), {
      command: "context-plan",
      sessionId: optionValue(rest, "--session-id"),
      cwd: optionValue(rest, "--cwd"),
      repoRoot: optionValue(rest, "--repo-root"),
      modelContextWindow: numberOptionValue(rest, "--model-context-window"),
      autoCompactTokenLimit: numberOptionValue(rest, "--auto-compact-token-limit"),
      recentEventLimit: numberOptionValue(rest, "--recent-event-limit"),
    }));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

async function daemonCli<T = unknown>(config: ReturnType<typeof loadConfig>, params: DaemonCliParams): Promise<T> {
  await ensureDaemon(config);
  return daemonRequest<T>(config, "cli", params);
}

function writeImportProgress(report: ImportReport): void {
  process.stderr.write(`agent-lcm import: imported=${report.events_imported} duplicates=${report.events_skipped_duplicate} rejected=${report.records_rejected}\n`);
}

async function importWithProgress(options: ImportOptions): Promise<ImportReport> {
  const harnessStarted = new Map<string, number>();
  const report = await importSessions({
    ...options,
    onProgress: (progress) => renderImportProgress(progress, harnessStarted),
  });
  writeImportProgress(report);
  return report;
}

function renderImportProgress(progress: ImportProgress, harnessStarted: Map<string, number>): void {
  if (progress.phase === "scan") {
    process.stderr.write(
      `agent-lcm import: ${progress.totalSessions} ${plural(progress.totalSessions, "session")} across ${progress.harnesses.length} ${plural(progress.harnesses.length, "harness")}\n`,
    );
    return;
  }
  if (progress.phase === "harness_start") harnessStarted.set(progress.harness, Date.now());
  if (!process.stderr.isTTY && progress.phase === "session") return;
  const elapsedMs = Date.now() - (harnessStarted.get(progress.harness) ?? Date.now());
  const etaMs = progress.sessionsCompleted > 0
    ? elapsedMs / progress.sessionsCompleted * (progress.sessionsTotal - progress.sessionsCompleted)
    : undefined;
  const line = `[${progress.harness}] ${progressBar(progress.sessionsCompleted, progress.sessionsTotal)} sessions ${progress.sessionsCompleted}/${progress.sessionsTotal} elapsed=${duration(elapsedMs)}${etaMs === undefined ? "" : ` eta=${duration(etaMs)}`}`;
  if (process.stderr.isTTY) {
    process.stderr.write(`\r\u001b[2K${line}${progress.phase === "harness_complete" ? "\n" : ""}`);
  } else if (progress.phase === "harness_complete") {
    process.stderr.write(`${line}\n`);
  }
}

function progressBar(completed: number, total: number): string {
  const width = 20;
  const filled = total === 0 ? 0 : Math.round(width * completed / total);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function duration(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

function plural(count: number, noun: string): string {
  if (count === 1) return noun;
  return noun === "harness" ? "harnesses" : `${noun}s`;
}

function printHelp(): void {
  process.stdout.write(`agent-lcm

Commands:
  agent-lcm version
  agent-lcm daemon run|start|restart|status|stop
  agent-lcm mcp
  agent-lcm hook <event>
  agent-lcm capture --harness codex|cursor|vscode|copilot|kiro|claude|auto [event]
  agent-lcm setup all
  agent-lcm setup <codex|cursor|vscode|copilot|kiro|claude> [--home PATH]
  agent-lcm setup status
  agent-lcm remove <codex|cursor|vscode|copilot|kiro|claude> [--home PATH]
  agent-lcm status [--codex-home PATH] [--json]
  agent-lcm doctor [--codex-home PATH] [--json]  Diagnose install, storage, and capture state
  agent-lcm health [--json]
  agent-lcm stats [--json]
  agent-lcm cleanup [--apply] [--json]   Preview or apply safe derived-index compaction; raw events are preserved
  agent-lcm maintain --once [--json]     Run raw segment migration, compression, and retention
  agent-lcm sessions [--since ISO] [--until ISO] [--cwd PATH] [--repo-root PATH] [--parent-session-id ID] [--roots-only] [--include-summaries] [--limit N] [--cursor N] [--json]
  agent-lcm usage [--since ISO] [--until ISO] [--cwd PATH] [--repo-root PATH] [--parent-session-id ID] [--roots-only] [--json]
  agent-lcm context-plan [--session-id ID] [--cwd PATH] [--repo-root PATH] [--model-context-window N] [--auto-compact-token-limit N] [--recent-event-limit N] [--json]
  agent-lcm benchmark long-context [--events N] [--budget-tokens N] [--home PATH] [--json]
  agent-lcm benchmark retrieval-quality [--home PATH] [--json]
  agent-lcm import --all|--harness codex|cursor|vscode|copilot|kiro|claude [path] [--dry-run] [--json]
  agent-lcm import-codex-sessions [--from PATH] [--dry-run] [--progress] [--json]
`);
}

function captureHarness(value: string | undefined, action: "setup" | "remove" = "setup"): CaptureHarness {
  if (value === "codex" || value === "cursor" || value === "vscode" || value === "copilot" || value === "kiro" || value === "claude") return value;
  throw new Error(`Usage: agent-lcm ${action} <codex|cursor|vscode|copilot|kiro|claude> [--home PATH]`);
}

function importHarness(value: string | undefined): ImportHarness {
  if (value === "codex" || value === "cursor" || value === "vscode" || value === "copilot" || value === "kiro" || value === "claude") return value;
  throw new Error("Usage: agent-lcm import --all|--harness codex|cursor|vscode|copilot|kiro|claude [path]");
}

function optionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function numberOptionValue(args: string[], flag: string): number | undefined {
  const value = optionValue(args, flag);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive number.`);
  return parsed;
}

function printObjectOrText(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printSetupReports(value: SetupReport | RemoveReport | SetupReport[], json: boolean): void {
  if (json) {
    printObjectOrText(value);
  } else {
    const reports = Array.isArray(value) ? value : [value];
    if (reports.length === 0) {
      process.stdout.write("No supported harnesses were detected. Configure one with agent-lcm setup <harness>.\n");
      return;
    }
    for (const report of reports) {
      process.stdout.write(`${report.harness} ${report.action}: ${report.status}\n`);
      process.stdout.write(`Hooks ${report.hooks.changed ? "changed" : "unchanged"}: ${report.hooks.path}\n`);
      if (report.status === "manual-required") {
        process.stdout.write(report.nativeCli === null
          ? "Native CLI unavailable.\n"
          : `${report.nativeCli} is installed, but it has no supported noninteractive plugin ${report.action} command.\n`);
      }
      if (report.status !== "complete") process.stdout.write(`Manual steps: ${report.guide}\n`);
    }
  }
  const reports = Array.isArray(value) ? value : [value];
  if (reports.some((report) => report.status !== "complete")) process.exitCode = 2;
}

function lifecycleEnvironment(harness: CaptureHarness, home: string): NodeJS.ProcessEnv {
  if (harness === "claude") return { ...process.env, CLAUDE_CONFIG_DIR: home };
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: home,
    COPILOT_HOME: home,
    AGENT_LCM_HOME: path.join(home, "agent-lcm"),
  };
}
