import type { LcmConfig } from "./config.ts";

export type ImportHarness = "codex" | "cursor" | "vscode" | "copilot" | "kiro" | "claude";

export type ImportOptions = {
  harness?: ImportHarness;
  all?: boolean;
  paths?: string[];
  config: LcmConfig;
  dryRun?: boolean;
  onProgress?: (progress: ImportProgress) => void;
};

export type ImportProgress =
  | {
    phase: "scan";
    totalSessions: number;
    harnesses: Array<{ harness: ImportHarness; sessions: number }>;
  }
  | {
    phase: "harness_start" | "session" | "harness_complete";
    harness: ImportHarness;
    sessionsCompleted: number;
    sessionsTotal: number;
    sessionsCompletedTotal: number;
    totalSessions: number;
  };

export type ImportReport = {
  sessions_scanned: number;
  sessions_imported: number;
  events_imported: number;
  events_skipped_duplicate: number;
  records_rejected: number;
  failures: Array<{ source: string; error: string }>;
  needs_export: Array<"vscode" | "cursor">;
};
