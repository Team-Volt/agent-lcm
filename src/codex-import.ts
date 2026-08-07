import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { codexRecordToEvent, type ImportState, rolloutSessionIdFromFile } from "./codex-record.ts";
import { type NormalizedEvent } from "./events.ts";
export type CodexRecord = { file: string; line: number; event: NormalizedEvent };
export type CodexReadReport = {
  files_scanned: number;
  records_read: number;
  records_skipped: number;
  errors: Array<{ file: string; line?: number; message: string }>;
};

export function defaultCodexSessionsPath(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
}

export async function readCodexSessions(
  source: string,
  onRecord: (record: CodexRecord) => void,
): Promise<CodexReadReport> {
  const report: CodexReadReport = { files_scanned: 0, records_read: 0, records_skipped: 0, errors: [] };
  const files = listJsonlFiles(path.resolve(source));
  if (files.length === 0) report.errors.push({ file: path.resolve(source), message: `No JSONL session files found at ${source}` });
  for (const file of files) {
    report.files_scanned += 1;
    await readCodexSessionFile(file, report, onRecord);
  }
  return report;
}

async function readCodexSessionFile(
  file: string,
  report: CodexReadReport,
  onRecord: (record: CodexRecord) => void,
): Promise<void> {
  const state: ImportState = {};
  const rolloutSessionId = rolloutSessionIdFromFile(file);
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (line.trim().length === 0) continue;
      report.records_read += 1;
      let event: NormalizedEvent | undefined;
      try {
        const parsed = JSON.parse(line);
        if (!isRecord(parsed)) throw new Error("record is not an object");
        event = codexRecordToEvent(parsed, file, state);
      } catch (error) {
        report.records_skipped += 1;
        report.errors.push({ file, line: lineNumber, message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (!event || (rolloutSessionId && event.session_id !== rolloutSessionId)) {
        report.records_skipped += 1;
        continue;
      }
      onRecord({ file, line: lineNumber, event });
    }
  } catch (error) {
    if (!input.errored) throw error;
    report.records_skipped += 1;
    report.errors.push({
      file,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    lines.close();
    input.destroy();
  }
}

export function listJsonlFiles(source: string): string[] {
  if (!fs.existsSync(source)) return [];
  const stat = fs.statSync(source);
  if (stat.isFile()) return source.endsWith(".jsonl") ? [source] : [];
  const result: string[] = [];
  const stack = [source];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(fullPath);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
