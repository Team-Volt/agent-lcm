import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { readClaudeSession } from "./claude-import.js";
import { readCodexSessions } from "./codex-import.js";
import { mapImportedEvent } from "./import-events.js";
export async function readImportedSession(harness, file) {
    if (harness === "codex")
        return readCodex(file);
    if (harness === "claude")
        return readClaudeSession(file);
    if (harness === "cursor")
        return { events: readCursor(file), errors: [] };
    if (file.endsWith(".jsonl"))
        return readJsonl(harness, file);
    return { events: readJson(harness, file), errors: [] };
}
async function readCodex(file) {
    const events = [];
    const parsed = await readCodexSessions(file, (record) => events.push(record.event));
    return {
        events,
        errors: parsed.errors.map((error) => ({ source: error.file, error: error.message })),
    };
}
async function readJsonl(harness, file) {
    const events = [];
    const errors = [];
    const input = fs.createReadStream(file, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let position = 0;
    try {
        for await (const line of lines) {
            position += 1;
            if (line.trim().length === 0)
                continue;
            try {
                const record = JSON.parse(line);
                const event = mapRecord(harness, preparedRecord(harness, record), file, position);
                if (event)
                    events.push(event);
            }
            catch (error) {
                errors.push({ source: file, error: error instanceof Error ? error.message : String(error) });
            }
        }
    }
    finally {
        lines.close();
        input.destroy();
    }
    return { events, errors };
}
function readJson(harness, file) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const records = harness === "vscode" ? vscodeRecords(parsed) : [parsed];
    return records.flatMap((record, index) => {
        const event = mapRecord(harness, preparedRecord(harness, record), file, index + 1);
        return event ? [event] : [];
    });
}
function readCursor(file) {
    const text = fs.readFileSync(file, "utf8");
    const title = /^#\s+.*?:\s*(.+)$/mu.exec(text)?.[1]?.trim() || path.basename(file, path.extname(file));
    const chunks = [...text.matchAll(/^##\s+(User|Assistant)\s*\n+([\s\S]*?)(?=^##\s+|(?![\s\S]))/gmu)];
    return chunks.flatMap((chunk, index) => {
        const role = chunk[1]?.toLowerCase();
        const content = chunk[2]?.trim();
        if (!role || !content)
            return [];
        return [mapImportedEvent("cursor", role === "user" ? "UserPromptSubmit" : "Stop", {
                session_id: title,
                cwd: "",
                ...(role === "user" ? { prompt: content } : { last_assistant_message: content }),
                imported_from: path.resolve(file),
            }, file, index + 1, "1970-01-01T00:00:00.000Z")];
    });
}
function vscodeRecords(value) {
    if (isRecord(value) && Array.isArray(value.messages)) {
        const sessionId = stringValue(value.id) ?? stringValue(value.sessionId);
        const cwd = stringValue(value.cwd) ?? "";
        return value.messages.map((message) => isRecord(message) ? { ...message, session_id: sessionId, cwd } : message);
    }
    if (isRecord(value) && Array.isArray(value.resourceSpans))
        return otlpRecords(value.resourceSpans);
    return [value];
}
function otlpRecords(resourceSpans) {
    const records = [];
    for (const resource of resourceSpans) {
        if (!isRecord(resource) || !Array.isArray(resource.scopeSpans))
            continue;
        const resourceAttributes = isRecord(resource.resource) ? attributeValues(resource.resource.attributes) : {};
        for (const scope of resource.scopeSpans) {
            if (!isRecord(scope) || !Array.isArray(scope.spans))
                continue;
            for (const span of scope.spans) {
                if (!isRecord(span))
                    continue;
                const attributes = { ...resourceAttributes, ...attributeValues(span.attributes) };
                const operation = stringValue(attributes["gen_ai.operation.name"]) ?? stringValue(span.name)?.split(" ")[0];
                const type = operation === "invoke_agent" ? "SessionStart" : operation === "chat" ? "Stop" : operation === "execute_tool" ? "PostToolUse" : undefined;
                if (!type)
                    continue;
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
function nanoTimestamp(value) {
    if (typeof value !== "string" || !/^\d+$/u.test(value))
        return undefined;
    return new Date(Number(BigInt(value) / 1000000n)).toISOString();
}
function attributeValues(value) {
    const attributes = {};
    if (!Array.isArray(value))
        return attributes;
    for (const attribute of value) {
        if (isRecord(attribute) && typeof attribute.key === "string" && isRecord(attribute.value)) {
            attributes[attribute.key] = Object.values(attribute.value)[0];
        }
    }
    return attributes;
}
function contentText(value) {
    if (typeof value === "string")
        return value;
    if (isRecord(value))
        return stringValue(value.text);
    if (!Array.isArray(value))
        return undefined;
    return value.map(contentText).filter((item) => item !== undefined).join("\n");
}
function preparedRecord(harness, value) {
    if (harness !== "kiro" || !isRecord(value))
        return value;
    const params = isRecord(value.params) ? value.params : undefined;
    if (value.method === "session/prompt" && params)
        return { ...params, type: "UserPromptSubmit", prompt: contentText(params.content) };
    if (value.method !== "session/notification" || !params || !isRecord(params.update))
        return value;
    const update = params.update;
    const session_id = stringValue(params.sessionId) ?? stringValue(params.session_id);
    const type = stringValue(update.sessionUpdate) ?? stringValue(update.type);
    if (type === "AgentMessageChunk")
        return { ...update, session_id, type: "Stop", last_assistant_message: contentText(update.content) };
    if (type === "ToolCall" || type === "ToolCallUpdate")
        return {
            ...update,
            session_id,
            type: "PostToolUse",
            tool_name: stringValue(update.title) ?? stringValue(update.name),
            tool_use_id: stringValue(update.toolCallId) ?? stringValue(update.tool_use_id),
            tool_input: update.rawInput ?? update.parameters,
            tool_response: update.content ?? update.result,
        };
    if (type === "TurnEnd")
        return { ...update, session_id, type: "Stop" };
    return value;
}
function mapRecord(harness, value, file, position) {
    if (!isRecord(value))
        throw new Error("record is not an object");
    const sessionId = stringValue(value.session_id) ?? stringValue(value.sessionId) ?? stringValue(value.conversation_id) ?? path.basename(file, path.extname(file));
    const role = stringValue(value.role)?.toLowerCase();
    const nativeEvent = knownEvent(harness, stringValue(value.hook_event_name) ?? stringValue(value.eventName) ?? stringValue(value.event) ?? stringValue(value.event_type) ?? stringValue(value.type), role);
    if (!nativeEvent)
        return undefined;
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
function knownEvent(harness, candidate, role) {
    const supported = harness === "copilot"
        ? ["sessionStart", "userPromptSubmitted", "postToolUse", "sessionEnd"]
        : ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];
    if (candidate && supported.includes(candidate))
        return candidate;
    if (role === "user")
        return harness === "copilot" ? "userPromptSubmitted" : "UserPromptSubmit";
    if (role === "assistant")
        return harness === "copilot" ? "sessionEnd" : "Stop";
    return undefined;
}
function timestamp(value) {
    const candidate = stringValue(value.timestamp) ?? stringValue(value.created_at) ?? "1970-01-01T00:00:00.000Z";
    if (Number.isNaN(new Date(candidate).getTime()))
        throw new Error(`invalid timestamp: ${candidate}`);
    return candidate;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringValue(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
