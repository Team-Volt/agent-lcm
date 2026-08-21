import fs from "node:fs";
import path from "node:path";
import { DEFAULT_LIMITS, loadConfig } from "./config.js";
import { ensureDaemon } from "./daemon-client.js";
import { normalizeHookEvent } from "./events.js";
import { resolveGitMetadata } from "./git.js";
import { mapHarnessEvent } from "./harnesses.js";
import { publishInboxEvent } from "./inbox.js";
import { sha256 } from "./redact.js";
export async function runHook(args) {
    const hookEvent = args[0];
    if (!hookEvent)
        throw new Error("Usage: agent-lcm hook <event>");
    const config = loadConfig();
    const rawInput = await readStdinWithLimit(config.limits.maxOverflowInputBytes);
    const payloadCwd = extractStringField(rawInput, "cwd") ?? process.env.PWD ?? process.cwd();
    const transcriptPath = hookEvent === "SubagentStop" ? extractStringField(rawInput, "agent_transcript_path") : undefined;
    const toolHook = hookEvent === "PreToolUse" || hookEvent === "PostToolUse";
    const repo = toolHook ? {} : resolveGitMetadata(payloadCwd);
    const event = normalizeHookEvent({
        hookEvent,
        rawInput,
        env: process.env,
        repo,
    });
    if (event.truncations.length > 0 || Buffer.byteLength(rawInput, "utf8") > config.limits.maxInputBytes) {
        const fullEvent = normalizeHookEvent({
            hookEvent,
            rawInput,
            env: process.env,
            repo,
            limits: {
                maxStringBytes: config.limits.maxOverflowInputBytes,
                maxPayloadBytes: config.limits.maxOverflowInputBytes,
            },
        });
        const content = JSON.stringify(fullEvent.payload);
        const hash = sha256(content);
        fs.mkdirSync(config.overflowDir, { recursive: true, mode: 0o700 });
        const overflowPath = path.join(config.overflowDir, `${hash}.json`);
        if (!fs.existsSync(overflowPath))
            fs.writeFileSync(overflowPath, content, { mode: 0o600 });
        event.payload.overflow_ref = {
            sha256: hash,
            byte_count: Buffer.byteLength(rawInput, "utf8"),
            sanitized_byte_count: Buffer.byteLength(content, "utf8"),
            path: overflowPath,
        };
    }
    publishInboxEvent(config, event);
    if (transcriptPath && !fs.existsSync(transcriptPath)) {
        process.stderr.write(`agent-lcm: failed to import subagent transcript: no file exists at ${transcriptPath}\n`);
    }
    const output = postCompactRecoveryOutput({
        home: config.home,
        hookEvent: event.hook_event,
        sessionId: event.session_id,
        payload: event.payload,
    });
    if (output.length > 0)
        process.stdout.write(output);
}
export async function runCapture(args) {
    const { harness, nativeEvent } = captureArguments(args);
    const config = loadConfig();
    const rawInput = await readStdinWithLimit(config.limits.maxOverflowInputBytes);
    const payloadCwd = extractStringField(rawInput, "cwd") ?? process.env.PWD ?? process.cwd();
    const isToolEvent = nativeEvent === "PostToolUse" || nativeEvent === "postToolUse";
    const repo = isToolEvent ? {} : resolveGitMetadata(payloadCwd);
    let event = mapHarnessEvent(harness, nativeEvent, rawInput, { env: process.env, repo });
    if (event.truncations.length > 0 || Buffer.byteLength(rawInput, "utf8") > config.limits.maxInputBytes) {
        const fullEvent = mapHarnessEvent(harness, nativeEvent, rawInput, {
            env: process.env,
            repo,
            limits: {
                maxStringBytes: config.limits.maxOverflowInputBytes,
                maxPayloadBytes: config.limits.maxOverflowInputBytes,
            },
        });
        const content = JSON.stringify(fullEvent.payload);
        const hash = sha256(content);
        fs.mkdirSync(config.overflowDir, { recursive: true, mode: 0o700 });
        const overflowPath = path.join(config.overflowDir, `${hash}.json`);
        if (!fs.existsSync(overflowPath))
            fs.writeFileSync(overflowPath, content, { mode: 0o600 });
        event = {
            ...event,
            payload: {
                ...event.payload,
                overflow_ref: {
                    sha256: hash,
                    byte_count: Buffer.byteLength(rawInput, "utf8"),
                    sanitized_byte_count: Buffer.byteLength(content, "utf8"),
                    path: overflowPath,
                },
            },
        };
    }
    publishInboxEvent(config, event);
    try {
        await ensureDaemon(config);
    }
    catch {
        process.stderr.write("agent-lcm: event queued; daemon start failed.\n");
    }
}
function captureArguments(args) {
    const index = args.indexOf("--harness");
    if (index < 0 || !args[index + 1])
        throw new Error("Usage: agent-lcm capture --harness <harness> [event]");
    const requested = args[index + 1];
    if (requested !== "auto" && requested !== "codex" && requested !== "cursor" && requested !== "vscode" && requested !== "copilot" && requested !== "kiro" && requested !== "claude" && requested !== "opencode") {
        throw new Error(`Unknown capture harness: ${requested}`);
    }
    const remaining = args.filter((_, position) => position !== index && position !== index + 1);
    if (remaining.some((value) => value.startsWith("--")))
        throw new Error("Usage: agent-lcm capture --harness <harness> [event]");
    return { harness: requested, nativeEvent: remaining[0] };
}
function postCompactRecoveryOutput(args) {
    if (args.hookEvent === "PostCompact") {
        markPostCompactPending(args.home, args.sessionId);
        return "";
    }
    if (args.hookEvent === "PostToolUse" && hasPostCompactPending(args.home, args.sessionId)) {
        const toolName = args.payload.tool_name;
        const isPackTool = toolName === "lcm_pack_context" || toolName === "mcp__agent_lcm__lcm_pack_context";
        if (isPackTool && hasPackedContextResult(args.payload)) {
            claimPostCompactPending(args.home, args.sessionId);
            return "";
        }
        return formatAdditionalContextOutput(args.hookEvent, buildPostCompactLcmDirective());
    }
    if (args.hookEvent === "Stop" && hasPostCompactPending(args.home, args.sessionId)) {
        return `${JSON.stringify({ decision: "block", reason: "Post-compaction LCM recovery required: call `lcm_pack_context`, then continue." })}\n`;
    }
    if (args.hookEvent !== "UserPromptSubmit" &&
        (args.hookEvent !== "SessionStart" || (args.payload.source !== "compact" && args.payload.source !== "resume")))
        return "";
    if (!hasPostCompactPending(args.home, args.sessionId))
        return "";
    return formatAdditionalContextOutput(args.hookEvent, buildPostCompactLcmDirective());
}
function hasPackedContextResult(payload) {
    if (!Object.hasOwn(payload, "tool_response"))
        return false;
    const response = payload.tool_response;
    if (!isRecord(response))
        return false;
    if (Object.hasOwn(response, "isError") && response.isError !== false)
        return false;
    const structuredContent = Object.hasOwn(response, "structuredContent")
        ? response.structuredContent
        : undefined;
    return isRecord(structuredContent)
        && Object.hasOwn(structuredContent, "markdown")
        && typeof structuredContent.markdown === "string";
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function markPostCompactPending(home, sessionId) {
    const recoveryDir = postCompactRecoveryDir(home);
    const markerPath = postCompactRecoveryPath(home, sessionId);
    fs.mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(recoveryDir, 0o700);
    fs.writeFileSync(markerPath, JSON.stringify({ pending: true }), { mode: 0o600 });
    fs.chmodSync(markerPath, 0o600);
}
function claimPostCompactPending(home, sessionId) {
    const markerPath = postCompactRecoveryPath(home, sessionId);
    if (!fs.existsSync(markerPath))
        return false;
    fs.unlinkSync(markerPath);
    return true;
}
export function hasPostCompactPending(home, sessionId) {
    return fs.existsSync(postCompactRecoveryPath(home, sessionId));
}
function postCompactRecoveryPath(home, sessionId) {
    return path.join(postCompactRecoveryDir(home), `${sha256(sessionId).slice(0, 24)}.json`);
}
function postCompactRecoveryDir(home) {
    return path.join(home, "post-compact-recovery");
}
function formatAdditionalContextOutput(hookEventName, additionalContext) {
    return `${JSON.stringify({
        hookSpecificOutput: {
            hookEventName,
            additionalContext,
        },
    })}\n`;
}
function buildPostCompactLcmDirective() {
    return [
        "## MANDATORY: POST-COMPACTION LCM RECOVERY",
        "",
        "Context compaction just ran. Before continuing any task that may depend on earlier turns, call Agent LCM now.",
        "",
        "Call `lcm_pack_context` once for broad recovery of the current task/session.",
        "Consume `structuredContent.markdown` from that same result; do not call it again to retrieve the Markdown.",
        "Use `lcm_expand_query` when you need focused source evidence for a specific prior decision, bug, test result, or implementation detail.",
        "Perform recovery silently. Unless the user asks, do not announce, describe, summarize, or allude to compaction, recovery, LCM, or checking prior task state; make the next user-visible message only about the task.",
        "After recovery, continue unfinished work unless a concrete blocker remains.",
        "Do not stop or wait for the user merely because compaction occurred.",
        "",
        "Do not rely on memory alone for pre-compaction details that are retrievable through LCM.",
    ].join("\n");
}
async function readStdinWithLimit(limit = DEFAULT_LIMITS.maxOverflowInputBytes) {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        bytes += Buffer.byteLength(text, "utf8");
        if (bytes > limit) {
            throw new Error(`Hook input exceeds the ${limit} byte limit.`);
        }
        chunks.push(text);
    }
    return chunks.join("");
}
function extractStringField(rawInput, key) {
    try {
        const payload = JSON.parse(rawInput);
        const value = payload[key];
        return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
    }
    catch {
        return undefined;
    }
}
