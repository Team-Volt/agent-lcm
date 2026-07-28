import fs from "node:fs";
import path from "node:path";

import { parsePersistedEvent } from "./event-codec.ts";
import type { NormalizedEvent } from "./events.ts";

export type RawLogReadResult = {
  readonly events: NormalizedEvent[];
  readonly malformedLineCount: number;
};

export type RawLogState = {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
};

export function appendRawEvents(rawLogPath: string, events: readonly NormalizedEvent[]): void {
  if (events.length === 0) return;
  fs.mkdirSync(path.dirname(rawLogPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(rawLogPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });
}

export function readRawLog(rawLogPath: string): RawLogReadResult {
  if (!fs.existsSync(rawLogPath)) return { events: [], malformedLineCount: 0 };
  const events: NormalizedEvent[] = [];
  let malformedLineCount = 0;
  for (const line of fs.readFileSync(rawLogPath, "utf8").split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const event = parsePersistedEvent(line);
    if (event) events.push(event);
    else malformedLineCount += 1;
  }
  return { events, malformedLineCount };
}

export function readRawEvents(rawLogPath: string): NormalizedEvent[] {
  return readRawLog(rawLogPath).events;
}

export function readRawEventIds(rawLogPath: string): Set<string> {
  return new Set(readRawEvents(rawLogPath).map((event) => event.event_id));
}

export function rawLogStat(rawLogPath: string): fs.Stats | undefined {
  return fs.existsSync(rawLogPath) ? fs.statSync(rawLogPath) : undefined;
}

export function rawLogState(rawLogPath: string): RawLogState {
  const stat = rawLogStat(rawLogPath);
  return stat
    ? { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
    : { size: 0, mtimeMs: 0, ctimeMs: 0 };
}
