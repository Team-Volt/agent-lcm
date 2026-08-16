import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { readClaudeSession } from "./claude-import.ts";
import { readCodexSessions } from "./codex-import.ts";
import type { NormalizedEvent } from "./events.ts";
import { mapImportedEvent } from "./import-events.ts";
import type { ImportHarness } from "./import-types.ts";

export type ImportReadError = {
  readonly source: string;
  readonly error: string;
};

export type ImportReadResult = {
  readonly events: readonly NormalizedEvent[];
  readonly errors: readonly ImportReadError[];
};

export async function readImportedSession(harness: ImportHarness, file: string): Promise<ImportReadResult> {
  if (harness === "codex") return readCodex(file);
  if (harness === "claude") return readClaudeSession(file);
  if (harness === "cursor") return { events: readCursor(file), errors: [] };
  if (file.endsWith(".jsonl")) return readJsonl(harness, file);
  return { events: readJson(harness, file), errors: [] };
}

async function readCodex(file: string): Promise<ImportReadResult> {
  const events: NormalizedEvent[] = [];
  const parsed = await readCodexSessions(file, (record) => events.push(record.event));
  return {
    events,
    errors: parsed.errors.map((error) => ({ source: error.file, error: error.message })),
  };
}

async function readJsonl(harness: ImportHarness, file: string): Promise<ImportReadResult> {
  const events: NormalizedEvent[] = [];
  const errors: ImportReadError[] = [];
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let position = 0;
  try {
    for await (const line of lines) {
      position += 1;
      if (line.trim().length === 0) continue;
      try {
        const record: unknown = JSON.parse(line);
        const event = mapRecord(harness, preparedRecord(harness, record), file, position);
        if (event) events.push(event);
      } catch (error) {
        errors.push({ source: file, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return { events, errors };
}

function readJson(harness: ImportHarness, file: string): NormalizedEvent[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  const records = harness === "vscode" ? vscodeRecords(parsed) : [parsed];
  return records.flatMap((record, index) => {
    const event = mapRecord(harness, preparedRecord(harness, record), file, index + 1);
    return event ? [event] : [];
  });
}

function readCursor(file: string): NormalizedEvent[] {
  const text = fs.readFileSync(file, "utf8");
  const title = /^#\s+.*?:\s*(.+)$/mu.exec(text)?.[1]?.trim() || path.basename(file, path.extname(file));
  const chunks = [...text.matchAll(/^##\s+(User|Assistant)\s*\n+([\s\S]*?)(?=^##\s+|(?![\s\S]))/gmu)];
  return chunks.flatMap((chunk, index) => {
    const role = chunk[1]?.toLowerCase();
    const content = chunk[2]?.trim();
    if (!role || !content) return [];
    return [mapImportedEvent("cursor", role === "user" ? "UserPromptSubmit" : "Stop", {
      session_id: title,
      cwd: "",
      ...(role === "user" ? { prompt: content } : { last_assistant_message: content }),
      imported_from: path.resolve(file),
    }, file, index + 1, "1970-01-01T00:00:00.000Z")];
  });
}

function vscodeRecords(value: unknown): unknown[] {
  if (isRecord(value) && Array.isArray(value.messages)) {
    const sessionId = stringValue(value.id) ?? stringValue(value.sessionId);
    const cwd = stringValue(value.cwd) ?? "";
    return value.messages.map((message) => isRecord(message) ? { ...message, session_id: sessionId, cwd } : message);
  }
  if (isRecord(value) && Array.isArray(value.resourceSpans)) return otlpRecords(value.resourceSpans);
  return [value];
}

function otlpRecords(resourceSpans: readonly unknown[]): unknown[] {
  const records: unknown[] = [];
  for (const resource of resourceSpans) {
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
    if (isRecord(attribute) && typeof attribute.key === "string" && isRecord(attribute.value)) {
      attributes[attribute.key] = Object.values(attribute.value)[0];
    }
  }
  return attributes;
}

function contentText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value)) return stringValue(value.text);
  if (!Array.isArray(value)) return undefined;
  return value.map(contentText).filter((item): item is string => item !== undefined).join("\n");
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
  const nativeEvent = knownEvent(harness, stringValue(value.hook_event_name) ?? stringValue(value.eventName) ?? stringValue(value.event) ?? stringValue(value.event_type) ?? stringValue(value.type), role);
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

function timestamp(value: Record<string, unknown>): string {
  const candidate = stringValue(value.timestamp) ?? stringValue(value.created_at) ?? "1970-01-01T00:00:00.000Z";
  if (Number.isNaN(new Date(candidate).getTime())) throw new Error(`invalid timestamp: ${candidate}`);
  return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
