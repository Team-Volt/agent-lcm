import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { defaultCodexSessionsPath, readCodexSessions } from "./codex-import.ts";
import type { LcmConfig } from "./config.ts";
import { daemonRequest, ensureDaemon } from "./daemon-client.ts";
import { harnessSessionId, type HarnessName, type NormalizedEvent } from "./events.ts";
import { mapHarnessEvent, type CaptureHarness } from "./harnesses.ts";
import { publishInboxEvent, type DrainInboxReport } from "./inbox.ts";
import { sha256 } from "./redact.ts";

export type ImportHarness = "codex" | "cursor" | "vscode" | "copilot" | "kiro";

export type ImportOptions = {
  harness?: ImportHarness;
  all?: boolean;
  paths?: string[];
  config: LcmConfig;
  dryRun?: boolean;
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

const BATCH_SIZE = 5000;

export async function importSessions(options: ImportOptions): Promise<ImportReport> {
  if ((options.all === true) === (options.harness !== undefined)) throw new Error("Pass exactly one of --all or --harness.");
  const report: ImportReport = {
    sessions_scanned: 0,
    sessions_imported: 0,
    events_imported: 0,
    events_skipped_duplicate: 0,
    records_rejected: 0,
    failures: [],
    needs_export: options.all ? ["vscode", "cursor"] : [],
  };
  const selections = sourcesFor(options);
  if (!options.dryRun) await ensureDaemon(options.config);
  const pending: NormalizedEvent[] = [];

  const flush = async (): Promise<void> => {
    if (pending.length === 0 || options.dryRun) return;
    const batch = pending.splice(0, pending.length);
    for (const [index, event] of batch.entries()) {
      publishInboxEvent(options.config, event);
      if ((index + 1) % 100 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const drained = await daemonRequest<DrainInboxReport>(options.config, "drain", { eventIds: batch.map((event) => event.event_id) });
    report.events_imported += drained.ingested;
    report.events_skipped_duplicate += drained.duplicates;
  };

  for (const selection of selections) {
    const files = filesFor(selection.harness, selection.paths);
    if (files.length === 0) {
      if (!selection.optional) addFailure(report, selection.paths[0] ?? selection.harness, `No ${selection.harness} session files found.`);
      continue;
    }
    for (const file of files) {
      report.sessions_scanned += 1;
      try {
        const events = await parseSession(selection.harness, file, report);
        if (events.length > 0) report.sessions_imported += 1;
        for (const item of events) {
          if (!options.dryRun) pending.push(item);
          if (pending.length >= BATCH_SIZE) await flush();
        }
      } catch (error) {
        report.records_rejected += 1;
        addFailure(report, file, error instanceof Error ? error.message : String(error));
      }
    }
  }
  await flush();
  return report;
}

function sourcesFor(options: ImportOptions): Array<{ harness: ImportHarness; paths: string[]; optional: boolean }> {
  if (options.harness) return [{ harness: options.harness, paths: options.paths?.map((value) => path.resolve(value)) ?? [defaultPath(options.harness)], optional: options.harness === "vscode" || options.harness === "cursor" }];
  const roots = options.paths?.map((value) => path.resolve(value)) ?? [os.homedir()];
  return [
    { harness: "codex", paths: roots.flatMap((root) => [path.join(root, "codex", "sessions"), path.join(root, ".codex", "sessions")]), optional: true },
    { harness: "copilot", paths: roots.flatMap((root) => [path.join(root, "copilot", "session-state"), path.join(root, ".copilot", "session-state")]), optional: true },
    { harness: "kiro", paths: roots.flatMap((root) => [path.join(root, "kiro", "sessions", "cli"), path.join(root, ".kiro", "sessions", "cli")]), optional: true },
  ];
}

function defaultPath(harness: ImportHarness): string {
  if (harness === "codex") return defaultCodexSessionsPath();
  if (harness === "copilot") return path.join(os.homedir(), ".copilot", "session-state");
  if (harness === "kiro") return path.join(os.homedir(), ".kiro", "sessions", "cli");
  return "";
}

function filesFor(harness: ImportHarness, paths: string[]): string[] {
  const files = paths.flatMap(walkFiles);
  return files.filter((file) => {
    const name = path.basename(file);
    if (harness === "codex") return name.endsWith(".jsonl");
    if (harness === "copilot") return name === "events.jsonl";
    if (harness === "kiro") return name.endsWith(".jsonl") || name === "session.json";
    if (harness === "vscode") return name.endsWith(".json");
    return name.endsWith(".md");
  }).sort((left, right) => left.localeCompare(right));
}

function walkFiles(source: string): string[] {
  if (!fs.existsSync(source)) return [];
  const stat = fs.statSync(source);
  if (stat.isFile()) return [source];
  const result: string[] = [];
  const stack = [source];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(child);
      else if (entry.isFile()) result.push(child);
    }
  }
  return result;
}

async function parseSession(harness: ImportHarness, file: string, report: ImportReport): Promise<NormalizedEvent[]> {
  if (harness === "codex") return parseCodex(file, report);
  if (harness === "cursor") return parseCursor(file);
  if (file.endsWith(".jsonl")) return parseJsonl(harness, file, report);
  return parseJson(harness, file);
}

async function parseCodex(file: string, report: ImportReport): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  const parsed = await readCodexSessions(file, (record) => {
    events.push(record.event);
  });
  report.records_rejected += parsed.errors.length;
  for (const error of parsed.errors) {
    addFailure(report, error.file, error.message);
  }
  return events;
}

async function parseJsonl(harness: ImportHarness, file: string, report: ImportReport): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let position = 0;
  try {
    for await (const line of lines) {
      position += 1;
      if (line.trim().length === 0) continue;
      try {
        const record = JSON.parse(line) as unknown;
        const event = mapRecord(harness, preparedRecord(harness, record), file, position);
        if (event) events.push(event);
      } catch (error) {
        report.records_rejected += 1;
        addFailure(report, file, error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return events;
}

function parseJson(harness: ImportHarness, file: string): NormalizedEvent[] {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  const records = harness === "vscode" ? vscodeRecords(parsed) : [parsed];
  const events: NormalizedEvent[] = [];
  for (const [index, record] of records.entries()) {
    const event = mapRecord(harness, preparedRecord(harness, record), file, index + 1);
    if (event) events.push(event);
  }
  return events;
}

function parseCursor(file: string): NormalizedEvent[] {
  const text = fs.readFileSync(file, "utf8");
  const title = /^#\s+.*?:\s*(.+)$/mu.exec(text)?.[1]?.trim() || path.basename(file, path.extname(file));
  const chunks = [...text.matchAll(/^##\s+(User|Assistant)\s*\n+([\s\S]*?)(?=^##\s+|(?![\s\S]))/gmu)];
  const events: NormalizedEvent[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const role = chunk[1]!.toLowerCase();
    const content = chunk[2]!.trim();
    if (!content) {
      continue;
    }
    const event = mapImportedEvent("cursor", role === "user" ? "UserPromptSubmit" : "Stop", {
      session_id: title,
      cwd: "",
      ...(role === "user" ? { prompt: content } : { last_assistant_message: content }),
      imported_from: path.resolve(file),
    }, file, index + 1, "1970-01-01T00:00:00.000Z");
    events.push(event);
  }
  return events;
}

function vscodeRecords(value: unknown): unknown[] {
  if (isRecord(value) && Array.isArray(value.messages)) return value.messages.map((message) => ({ ...message as Record<string, unknown>, session_id: stringValue(value.id) ?? stringValue(value.sessionId), cwd: stringValue(value.cwd) ?? "" }));
  if (isRecord(value) && Array.isArray(value.resourceSpans)) return otlpRecords(value);
  return [value];
}

function otlpRecords(value: Record<string, unknown>): unknown[] {
  const records: unknown[] = [];
  for (const resource of value.resourceSpans as unknown[]) {
    if (!isRecord(resource) || !Array.isArray(resource.scopeSpans)) continue;
    const resourceAttributes = isRecord(resource.resource) ? attributeValues(resource.resource.attributes) : {};
    for (const scope of resource.scopeSpans) {
      if (!isRecord(scope) || !Array.isArray(scope.spans)) continue;
      for (const span of scope.spans) {
        if (!isRecord(span)) continue;
        const attributes = { ...resourceAttributes, ...attributeValues(span.attributes) };
        const operation = stringValue(attributes["gen_ai.operation.name"]) ?? stringValue(span.name)?.split(" ")[0];
        const type = operation === "invoke_agent" ? "SessionStart" : operation === "chat" ? "Stop" : operation === "execute_tool" ? "PostToolUse" : undefined;
        if (!type) continue;
        records.push({
          ...attributes,
          type,
          session_id: stringValue(attributes["gen_ai.conversation.id"]) ?? stringValue(attributes["session.id"]),
          tool_name: attributes["gen_ai.tool.name"],
          tool_use_id: attributes["gen_ai.tool.call.id"],
          last_assistant_message: attributes["gen_ai.output.messages"],
          timestamp: nanoTimestamp(span.startTimeUnixNano),
        });
      }
    }
  }
  return records;
}

function nanoTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d+$/u.test(value)) return undefined;
  return new Date(Number(BigInt(value) / 1_000_000n)).toISOString();
}

function attributeValues(value: unknown): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  if (!Array.isArray(value)) return attributes;
  for (const attribute of value) {
    if (isRecord(attribute) && typeof attribute.key === "string" && isRecord(attribute.value)) attributes[attribute.key] = Object.values(attribute.value)[0];
  }
  return attributes;
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value)) return stringValue(value.text);
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => contentText(item)).filter((item): item is string => item !== undefined).join("\n");
}

function preparedRecord(harness: ImportHarness, value: unknown): unknown {
  if (harness !== "kiro" || !isRecord(value)) return value;
  const params = isRecord(value.params) ? value.params : undefined;
  if (value.method === "session/prompt" && params) return { ...params, type: "UserPromptSubmit", prompt: contentText(params.content) };
  if (value.method !== "session/notification" || !params || !isRecord(params.update)) return value;
  const update = params.update;
  const session_id = stringValue(params.sessionId) ?? stringValue(params.session_id);
  const type = stringValue(update.sessionUpdate) ?? stringValue(update.type);
  if (type === "AgentMessageChunk") return { ...update, session_id, type: "Stop", last_assistant_message: contentText(update.content) };
  if (type === "ToolCall" || type === "ToolCallUpdate") return {
    ...update,
    session_id,
    type: "PostToolUse",
    tool_name: stringValue(update.title) ?? stringValue(update.name),
    tool_use_id: stringValue(update.toolCallId) ?? stringValue(update.tool_use_id),
    tool_input: update.rawInput ?? update.parameters,
    tool_response: update.content ?? update.result,
  };
  if (type === "TurnEnd") return { ...update, session_id, type: "Stop" };
  return value;
}

function mapRecord(harness: ImportHarness, value: unknown, file: string, position: number): NormalizedEvent | undefined {
  if (!isRecord(value)) throw new Error("record is not an object");
  const sessionId = stringValue(value.session_id) ?? stringValue(value.sessionId) ?? stringValue(value.conversation_id) ?? path.basename(file, path.extname(file));
  const role = stringValue(value.role)?.toLowerCase();
  const nativeEvent = knownEvent(
    harness,
    stringValue(value.hook_event_name) ?? stringValue(value.eventName) ?? stringValue(value.event) ?? stringValue(value.event_type) ?? stringValue(value.type),
    role,
  );
  if (!nativeEvent) return undefined;
  const content = stringValue(value.text) ?? stringValue(value.message) ?? stringValue(value.prompt) ?? stringValue(value.content);
  const payload = {
    ...value,
    session_id: sessionId,
    cwd: stringValue(value.cwd) ?? "",
    imported_from: path.resolve(file),
    ...(content && role === "user" && value.prompt === undefined ? { prompt: content } : {}),
    ...(content && role === "assistant" && value.last_assistant_message === undefined ? { last_assistant_message: content } : {}),
  };
  return mapImportedEvent(harness, nativeEvent, payload, file, position, timestamp(value));
}

function knownEvent(harness: ImportHarness, candidate: string | undefined, role: string | undefined): string | undefined {
  const supported = harness === "copilot"
    ? ["sessionStart", "userPromptSubmitted", "postToolUse", "sessionEnd"]
    : ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];
  if (candidate && supported.includes(candidate)) return candidate;
  if (role === "user") return harness === "copilot" ? "userPromptSubmitted" : "UserPromptSubmit";
  if (role === "assistant") return harness === "copilot" ? "sessionEnd" : "Stop";
  return undefined;
}

function mapImportedEvent(
  harness: ImportHarness,
  nativeEvent: string,
  payload: Record<string, unknown>,
  source: string,
  position: number,
  at: string,
): NormalizedEvent {
  const event = mapHarnessEvent(harness as CaptureHarness, nativeEvent, payload, { now: () => new Date(at), env: {} });
  return stableEvent(harness, event, source, position);
}

function stableEvent(harness: ImportHarness, event: NormalizedEvent, source: string, position: number): NormalizedEvent {
  const nativeSessionId = event.session_id.replace(new RegExp(`^${harness}:`, "u"), "");
  const eventId = sha256([harness, nativeSessionId, path.resolve(source), String(position), sha256(JSON.stringify(event.payload))].join("\0"));
  return { ...event, session_id: harnessSessionId(harness as HarnessName, nativeSessionId), event_id: eventId };
}

function timestamp(value: Record<string, unknown>): string {
  const candidate = stringValue(value.timestamp) ?? stringValue(value.created_at) ?? "1970-01-01T00:00:00.000Z";
  if (Number.isNaN(new Date(candidate).getTime())) throw new Error(`invalid timestamp: ${candidate}`);
  return candidate;
}

function addFailure(report: ImportReport, source: string, error: string): void {
  report.failures.push({ source, error });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
