import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { defaultCodexSessionsPath, readCodexSessions } from "./codex-import.js";
import { daemonRequest, ensureDaemon } from "./daemon-client.js";
import { harnessSessionId } from "./events.js";
import { mapHarnessEvent } from "./harnesses.js";
import { sha256 } from "./redact.js";
const BATCH_SIZE = 5000;
const DAEMON_REQUEST_OVERHEAD_BYTES = 1024;
export async function importSessions(options) {
    if ((options.all === true) === (options.harness !== undefined))
        throw new Error("Pass exactly one of --all or --harness.");
    const report = {
        sessions_scanned: 0,
        sessions_imported: 0,
        events_imported: 0,
        events_skipped_duplicate: 0,
        records_rejected: 0,
        failures: [],
        needs_export: options.all ? ["vscode", "cursor"] : [],
    };
    const selections = sourcesFor(options);
    if (!options.dryRun)
        await ensureDaemon(options.config);
    const pending = [];
    const touchedSessions = new Set();
    const maxBatchBytes = options.config.limits.maxInputBytes - DAEMON_REQUEST_OVERHEAD_BYTES;
    let pendingBytes = 2;
    const flush = async () => {
        if (pending.length === 0 || options.dryRun)
            return;
        const ingested = await daemonRequest(options.config, "ingest", { events: pending });
        report.events_imported += ingested.imported;
        report.events_skipped_duplicate += ingested.skippedDuplicate;
        pending.length = 0;
        pendingBytes = 2;
    };
    for (const selection of selections) {
        const files = filesFor(selection.harness, selection.paths);
        if (files.length === 0) {
            if (!selection.optional)
                addFailure(report, selection.paths[0] ?? selection.harness, `No ${selection.harness} session files found.`);
            continue;
        }
        for (const file of files) {
            report.sessions_scanned += 1;
            let events;
            try {
                events = await parseSession(selection.harness, file, report);
            }
            catch (error) {
                report.records_rejected += 1;
                addFailure(report, file, error instanceof Error ? error.message : String(error));
                continue;
            }
            if (events.length > 0)
                report.sessions_imported += 1;
            for (const item of events) {
                if (options.dryRun)
                    continue;
                const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
                if (itemBytes + 2 > maxBatchBytes)
                    throw new Error("Imported event exceeds the daemon request limit.");
                if (pending.length > 0 && (pending.length >= BATCH_SIZE || pendingBytes + 1 + itemBytes > maxBatchBytes)) {
                    await flush();
                }
                pendingBytes += (pending.length > 0 ? 1 : 0) + itemBytes;
                pending.push(item);
                touchedSessions.add(item.session_id);
            }
        }
    }
    await flush();
    if (!options.dryRun)
        await rebuildImportedSessions(options.config, touchedSessions, maxBatchBytes);
    return report;
}
async function rebuildImportedSessions(config, sessions, maxBatchBytes) {
    let batch = [];
    let batchBytes = 2;
    const flush = async () => {
        if (batch.length === 0)
            return;
        await daemonRequest(config, "ingest", { events: [], rebuildSessions: batch });
        batch = [];
        batchBytes = 2;
    };
    for (const sessionId of sessions) {
        const itemBytes = Buffer.byteLength(JSON.stringify(sessionId), "utf8");
        if (itemBytes + 2 > maxBatchBytes)
            throw new Error("Imported session ID exceeds the daemon request limit.");
        if (batch.length > 0 && batchBytes + 1 + itemBytes > maxBatchBytes)
            await flush();
        batchBytes += (batch.length > 0 ? 1 : 0) + itemBytes;
        batch.push(sessionId);
    }
    await flush();
}
function sourcesFor(options) {
    if (options.harness)
        return [{ harness: options.harness, paths: options.paths?.map((value) => path.resolve(value)) ?? [defaultPath(options.harness)], optional: options.harness === "vscode" || options.harness === "cursor" }];
    const roots = options.paths?.map((value) => path.resolve(value)) ?? [os.homedir()];
    return [
        { harness: "codex", paths: roots.flatMap((root) => [path.join(root, "codex", "sessions"), path.join(root, ".codex", "sessions")]), optional: true },
        { harness: "copilot", paths: roots.flatMap((root) => [path.join(root, "copilot", "session-state"), path.join(root, ".copilot", "session-state")]), optional: true },
        { harness: "kiro", paths: roots.flatMap((root) => [path.join(root, "kiro", "sessions", "cli"), path.join(root, ".kiro", "sessions", "cli")]), optional: true },
    ];
}
function defaultPath(harness) {
    if (harness === "codex")
        return defaultCodexSessionsPath();
    if (harness === "copilot")
        return path.join(os.homedir(), ".copilot", "session-state");
    if (harness === "kiro")
        return path.join(os.homedir(), ".kiro", "sessions", "cli");
    return "";
}
function filesFor(harness, paths) {
    const files = paths.flatMap(walkFiles);
    return files.filter((file) => {
        const name = path.basename(file);
        if (harness === "codex")
            return name.endsWith(".jsonl");
        if (harness === "copilot")
            return name === "events.jsonl";
        if (harness === "kiro")
            return name.endsWith(".jsonl") || name === "session.json";
        if (harness === "vscode")
            return name.endsWith(".json");
        return name.endsWith(".md");
    }).sort((left, right) => left.localeCompare(right));
}
function walkFiles(source) {
    if (!fs.existsSync(source))
        return [];
    const stat = fs.statSync(source);
    if (stat.isFile())
        return [source];
    const result = [];
    const stack = [source];
    while (stack.length > 0) {
        const current = stack.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const child = path.join(current, entry.name);
            if (entry.isDirectory())
                stack.push(child);
            else if (entry.isFile())
                result.push(child);
        }
    }
    return result;
}
async function parseSession(harness, file, report) {
    if (harness === "codex")
        return parseCodex(file, report);
    if (harness === "cursor")
        return parseCursor(file);
    if (file.endsWith(".jsonl"))
        return parseJsonl(harness, file, report);
    return parseJson(harness, file);
}
async function parseCodex(file, report) {
    const events = [];
    const parsed = await readCodexSessions(file, (record) => {
        events.push(record.event);
    });
    report.records_rejected += parsed.errors.length;
    for (const error of parsed.errors) {
        addFailure(report, error.file, error.message);
    }
    return events;
}
async function parseJsonl(harness, file, report) {
    const events = [];
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
                report.records_rejected += 1;
                addFailure(report, file, error instanceof Error ? error.message : String(error));
            }
        }
    }
    finally {
        lines.close();
        input.destroy();
    }
    return events;
}
function parseJson(harness, file) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const records = harness === "vscode" ? vscodeRecords(parsed) : [parsed];
    const events = [];
    for (const [index, record] of records.entries()) {
        const event = mapRecord(harness, preparedRecord(harness, record), file, index + 1);
        if (event)
            events.push(event);
    }
    return events;
}
function parseCursor(file) {
    const text = fs.readFileSync(file, "utf8");
    const title = /^#\s+.*?:\s*(.+)$/mu.exec(text)?.[1]?.trim() || path.basename(file, path.extname(file));
    const chunks = [...text.matchAll(/^##\s+(User|Assistant)\s*\n+([\s\S]*?)(?=^##\s+|(?![\s\S]))/gmu)];
    const events = [];
    for (const [index, chunk] of chunks.entries()) {
        const role = chunk[1].toLowerCase();
        const content = chunk[2].trim();
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
function vscodeRecords(value) {
    if (isRecord(value) && Array.isArray(value.messages))
        return value.messages.map((message) => ({ ...message, session_id: stringValue(value.id) ?? stringValue(value.sessionId), cwd: stringValue(value.cwd) ?? "" }));
    if (isRecord(value) && Array.isArray(value.resourceSpans))
        return otlpRecords(value);
    return [value];
}
function otlpRecords(value) {
    const records = [];
    for (const resource of value.resourceSpans) {
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
        if (isRecord(attribute) && typeof attribute.key === "string" && isRecord(attribute.value))
            attributes[attribute.key] = Object.values(attribute.value)[0];
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
    return value.map((item) => contentText(item)).filter((item) => item !== undefined).join("\n");
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
function mapImportedEvent(harness, nativeEvent, payload, source, position, at) {
    const event = mapHarnessEvent(harness, nativeEvent, payload, { now: () => new Date(at), env: {} });
    return stableEvent(harness, event, source, position);
}
function stableEvent(harness, event, source, position) {
    const nativeSessionId = event.session_id.replace(new RegExp(`^${harness}:`, "u"), "");
    const eventId = sha256([harness, nativeSessionId, path.resolve(source), String(position), sha256(JSON.stringify(event.payload))].join("\0"));
    return { ...event, session_id: harnessSessionId(harness, nativeSessionId), event_id: eventId };
}
function timestamp(value) {
    const candidate = stringValue(value.timestamp) ?? stringValue(value.created_at) ?? "1970-01-01T00:00:00.000Z";
    if (Number.isNaN(new Date(candidate).getTime()))
        throw new Error(`invalid timestamp: ${candidate}`);
    return candidate;
}
function addFailure(report, source, error) {
    report.failures.push({ source, error });
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringValue(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
