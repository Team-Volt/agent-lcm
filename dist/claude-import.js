import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { mapImportedEvent } from "./import-events.js";
export async function readClaudeSession(file) {
    const events = [];
    const errors = [];
    const pendingTools = new Map();
    const input = fs.createReadStream(file, { encoding: "utf8" });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
        for await (const line of lines) {
            lineNumber += 1;
            if (line.trim().length === 0)
                continue;
            try {
                const value = JSON.parse(line);
                if (!isRecord(value))
                    throw new Error("record is not an object");
                events.push(...recordEvents(value, { file, lineNumber, pendingTools }));
            }
            catch (error) {
                errors.push({ source: file, error: `line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}` });
            }
        }
    }
    finally {
        lines.close();
        input.destroy();
    }
    return { events, errors };
}
function recordEvents(record, context) {
    if (record.isSidechain === true)
        return [];
    const type = stringValue(record.type);
    const message = isRecord(record.message) ? record.message : undefined;
    if (!message)
        return [];
    if (type === "user")
        return userEvents(record, message, context);
    if (type === "assistant")
        return assistantEvents(record, message, context);
    return [];
}
function userEvents(record, message, context) {
    if (record.isMeta === true || stringValue(message.role) !== "user")
        return [];
    const content = message.content;
    const blocks = Array.isArray(content) ? content.filter(isRecord) : [];
    const results = blocks.flatMap((block, blockIndex) => {
        if (block.type !== "tool_result")
            return [];
        const toolUseId = stringValue(block.tool_use_id);
        const pending = toolUseId ? context.pendingTools.get(toolUseId) : undefined;
        if (!toolUseId || !pending)
            return [];
        context.pendingTools.delete(toolUseId);
        return [mapImportedEvent("claude", "PostToolUse", {
                ...metadata(record, context.file),
                tool_name: pending.name,
                tool_use_id: toolUseId,
                tool_input: pending.input,
                tool_response: block.content,
                is_error: block.is_error === true,
            }, context.file, `${context.lineNumber}:tool-result:${blockIndex}`, recordTimestamp(record))];
    });
    if (blocks.some((block) => block.type === "tool_result"))
        return results;
    const prompt = typeof content === "string" ? content.trim() : textBlocks(blocks);
    if (!prompt)
        return results;
    return [...results, mapImportedEvent("claude", "UserPromptSubmit", {
            ...metadata(record, context.file),
            prompt,
        }, context.file, context.lineNumber, recordTimestamp(record))];
}
function assistantEvents(record, message, context) {
    if (stringValue(message.role) !== "assistant")
        return [];
    const content = message.content;
    const blocks = Array.isArray(content) ? content.filter(isRecord) : [];
    for (const block of blocks) {
        if (block.type !== "tool_use")
            continue;
        const id = stringValue(block.id);
        const name = stringValue(block.name);
        if (id && name)
            context.pendingTools.set(id, { name, input: block.input });
    }
    const text = typeof content === "string" ? content.trim() : textBlocks(blocks);
    if (!text)
        return [];
    return [mapImportedEvent("claude", "Stop", {
            ...metadata(record, context.file),
            last_assistant_message: text,
        }, context.file, context.lineNumber, recordTimestamp(record))];
}
function metadata(record, file) {
    return {
        session_id: stringValue(record.sessionId) ?? stringValue(record.session_id) ?? path.basename(file, path.extname(file)),
        cwd: stringValue(record.cwd) ?? "",
        imported_from: path.resolve(file),
    };
}
function textBlocks(blocks) {
    const text = blocks.flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text.trim()] : []).filter(Boolean).join("\n");
    return text || undefined;
}
function recordTimestamp(record) {
    const value = stringValue(record.timestamp) ?? "1970-01-01T00:00:00.000Z";
    if (Number.isNaN(new Date(value).getTime()))
        throw new Error(`invalid timestamp: ${value}`);
    return value;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringValue(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
