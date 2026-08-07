import { DEFAULT_LIMITS } from "./config.js";
import { loadConfig } from "./config.js";
import { daemonRequest, ensureDaemon } from "./daemon-client.js";
import { harnessSessionId } from "./events.js";
import { hasPostCompactPending } from "./hook.js";
import { TOOLS } from "./mcp-catalog.js";
import { packageVersion } from "./release.js";
const SERVER_NAME = "agent-lcm";
const SERVER_VERSION = packageVersion();
const SUPPORTED_PROTOCOL_VERSION = "2025-11-25";
const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "utf8");
const MAX_MESSAGE_BYTES = DEFAULT_LIMITS.maxInputBytes;
export function startMcpServer() {
    let buffer = Buffer.alloc(0);
    let requestChain = Promise.resolve();
    process.stdin.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")]);
        if (buffer.length > MAX_MESSAGE_BYTES) {
            sendError(null, -32700, "Parse error", startsWithHeader(buffer) ? "header" : "line");
            buffer = Buffer.alloc(0);
            return;
        }
        buffer = processInputBuffer(buffer, (raw, framing) => {
            requestChain = requestChain
                .then(() => handleRawMessage(raw, framing))
                .catch((error) => sendError(null, -32603, error instanceof Error ? error.message : String(error), framing));
        });
    });
}
function processInputBuffer(input, handle) {
    let buffer = input;
    while (buffer.length > 0) {
        if (startsWithHeader(buffer)) {
            const parsed = takeHeaderMessage(buffer);
            if (parsed.kind === "incomplete")
                return buffer;
            buffer = parsed.remaining;
            handle(parsed.body, "header");
            continue;
        }
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex === -1)
            return buffer;
        const line = buffer.subarray(0, newlineIndex).toString("utf8").trim();
        buffer = buffer.subarray(newlineIndex + 1);
        if (line.length === 0)
            continue;
        handle(line, "line");
    }
    return buffer;
}
function startsWithHeader(buffer) {
    return buffer.subarray(0, "Content-Length:".length).toString("utf8").toLowerCase() === "content-length:";
}
function takeHeaderMessage(buffer) {
    const headerEnd = buffer.indexOf(HEADER_SEPARATOR);
    if (headerEnd === -1)
        return { kind: "incomplete" };
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const lengthMatch = /^Content-Length:\s*(\d+)$/imu.exec(header);
    if (!lengthMatch) {
        sendError(null, -32700, "Parse error", "header");
        return { kind: "complete", body: "", remaining: buffer.subarray(headerEnd + HEADER_SEPARATOR.length) };
    }
    const bodyLength = Number(lengthMatch[1]);
    if (!Number.isSafeInteger(bodyLength) || bodyLength > MAX_MESSAGE_BYTES) {
        sendError(null, -32700, "Parse error", "header");
        return { kind: "complete", body: "", remaining: Buffer.alloc(0) };
    }
    const bodyStart = headerEnd + HEADER_SEPARATOR.length;
    const bodyEnd = bodyStart + bodyLength;
    if (buffer.length < bodyEnd)
        return { kind: "incomplete" };
    return {
        kind: "complete",
        body: buffer.subarray(bodyStart, bodyEnd).toString("utf8"),
        remaining: buffer.subarray(bodyEnd),
    };
}
async function handleRawMessage(raw, framing) {
    if (raw.trim().length === 0)
        return;
    try {
        const message = JSON.parse(raw);
        if (!isJsonRpcRequest(message)) {
            sendError(null, -32600, "Invalid Request", framing);
            return;
        }
        await handleMessage(message, framing);
    }
    catch (error) {
        if (error instanceof SyntaxError) {
            sendError(null, -32700, "Parse error", framing);
            return;
        }
        throw error;
    }
}
async function handleMessage(message, framing) {
    const { id, method, params } = message;
    if (method === "initialize") {
        if (!isInitializeParams(params)) {
            sendError(id, -32602, "Invalid params", framing);
            return;
        }
        sendResult(id, {
            protocolVersion: params.protocolVersion === SUPPORTED_PROTOCOL_VERSION
                ? params.protocolVersion
                : SUPPORTED_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
            instructions: [
                "Use Agent LCM for sanitized local evidence from prior agent sessions.",
                "Preferred standard workflow: lcm_grep -> lcm_describe -> lcm_expand.",
                "Use lcm_expand_query for focused recursive evidence. For recovery after compaction, interruption, or handoff, call lcm_pack_context once and consume structuredContent.markdown from that result.",
                "For multi-session reviews, call lcm_list_sessions once with includeSummaries; for exact long-session detail, use lcm_describe before bounded graph or paged event reads.",
            ].join(" "),
        }, framing);
        return;
    }
    if (method === "ping") {
        sendResult(id, {}, framing);
        return;
    }
    if (method === "tools/list") {
        sendResult(id, { tools: TOOLS }, framing);
        return;
    }
    if (method === "tools/call") {
        if (!isToolsCallParams(params)) {
            sendError(id, -32602, "Invalid params", framing);
            return;
        }
        try {
            const config = loadConfig();
            await ensureDaemon(config);
            sendResult(id, await daemonRequest(config, "tool", withClientContext(params, config.home)), framing);
        }
        catch (error) {
            sendError(id, -32602, error instanceof Error ? error.message : String(error), framing);
        }
        return;
    }
    if (id !== undefined)
        sendError(id, -32601, `Method not found: ${method ?? ""}`, framing);
}
function send(message, framing = "line") {
    const body = JSON.stringify(message);
    if (framing === "header") {
        process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
        return;
    }
    process.stdout.write(`${body}\n`);
}
function sendResult(id, result, framing = "line") {
    if (id === undefined)
        return;
    send({ jsonrpc: "2.0", id, result }, framing);
}
function sendError(id, code, message, framing = "line") {
    if (id === undefined)
        return;
    send({ jsonrpc: "2.0", id, error: { code, message } }, framing);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isInitializeParams(value) {
    if (!isRecord(value) || typeof value.protocolVersion !== "string" || value.protocolVersion.trim().length === 0) {
        return false;
    }
    if ("capabilities" in value && !isRecord(value.capabilities))
        return false;
    return !("clientInfo" in value && !isRecord(value.clientInfo));
}
function isToolsCallParams(value) {
    if (!isRecord(value) || typeof value.name !== "string" || value.name.trim().length === 0)
        return false;
    return !("arguments" in value && !isRecord(value.arguments));
}
function withClientContext(params, home) {
    const currentThreadId = process.env.CODEX_THREAD_ID?.trim();
    if (!currentThreadId || params.name !== "lcm_pack_context")
        return params;
    const argumentsValue = isRecord(params.arguments) ? params.arguments : {};
    const sessionId = harnessSessionId("codex", currentThreadId);
    const recoveryScope = hasPostCompactPending(home, sessionId)
        ? { sessionIds: [sessionId], harnesses: ["codex"] }
        : {};
    return { ...params, arguments: { ...argumentsValue, currentThreadId, ...recoveryScope } };
}
function isJsonRpcRequest(value) {
    if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string")
        return false;
    if ("id" in value && value.id !== null && typeof value.id !== "string" && typeof value.id !== "number") {
        return false;
    }
    return !("params" in value && !isRecord(value.params) && !Array.isArray(value.params));
}
