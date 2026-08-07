import { createHash } from "node:crypto";
import { DEFAULT_LIMITS } from "./config.js";
import { redactSecretAssignments, shouldRedactSecretKey } from "./redact-assignments.js";
const TOKEN_PATTERNS = [
    {
        regex: /\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]*:)(?!\[REDACTED:secret\])([^@\s/]+)(@)/giu,
        replacement: (_match, prefix, _password, suffix) => `${prefix}[REDACTED:secret]${suffix}`,
    },
    {
        regex: /Authorization:\s*Bearer\s+(?!\[REDACTED:token\])[^\s"']+/giu,
        replacement: "Authorization: Bearer [REDACTED:token]",
    },
    {
        regex: /\bBearer\s+(?!\[REDACTED:token\])[^\s"']+/gu,
        replacement: "Bearer [REDACTED:token]",
    },
    {
        regex: /\b(sk-[A-Za-z0-9]+)[-_][A-Za-z0-9_-]{6,}\b/gu,
        replacement: (_match, prefix) => `${prefix}_[REDACTED:token]`,
    },
    {
        regex: /\bghp_[A-Za-z0-9_]{20,}\b/gu,
        replacement: "ghp_[REDACTED:token]",
    },
    {
        regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
        replacement: "github_pat_[REDACTED:token]",
    },
    {
        regex: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/gu,
        replacement: "xox[REDACTED:token]",
    },
    {
        regex: /\bAKIA[0-9A-Z]{16}\b/gu,
        replacement: "AKIA[REDACTED:token]",
    },
];
export function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
function byteLength(value) {
    return Buffer.byteLength(value, "utf8");
}
export function sanitizeForStorage(value, options = {}) {
    const limits = { ...DEFAULT_LIMITS, ...options };
    const redactions = [];
    const truncations = [];
    const originalBytes = safeJsonByteLength(value);
    const sanitized = sanitizeValue(value, "$", limits, redactions, truncations);
    const payloadBytes = safeJsonByteLength(sanitized);
    if (payloadBytes > limits.maxPayloadBytes) {
        const json = JSON.stringify(sanitized);
        const preview = truncateUtf8(json, limits.maxPayloadBytes);
        truncations.push({
            path: "$",
            kind: "payload",
            original_bytes: payloadBytes,
            sha256: sha256(json),
        });
        const payload = {
            lcm_truncated: true,
            kind: "payload",
            original_bytes: payloadBytes,
            sha256: sha256(json),
            preview,
        };
        return {
            value: payload,
            redactions,
            truncations,
            originalBytes,
            sanitizedBytes: safeJsonByteLength(payload),
        };
    }
    return {
        value: sanitized,
        redactions,
        truncations,
        originalBytes,
        sanitizedBytes: payloadBytes,
    };
}
function sanitizeValue(value, path, limits, redactions, truncations) {
    if (value === null || value === undefined)
        return value;
    if (typeof value === "string") {
        return truncateString(redactString(value, path, redactions), path, limits, truncations);
    }
    if (typeof value === "number" || typeof value === "boolean")
        return value;
    if (typeof value === "bigint")
        return value.toString();
    if (typeof value === "function" || typeof value === "symbol")
        return `[${typeof value}]`;
    if (Array.isArray(value)) {
        return value.map((item, index) => sanitizeValue(item, `${path}[${index}]`, limits, redactions, truncations));
    }
    if (typeof value === "object") {
        const output = {};
        for (const [key, child] of Object.entries(value)) {
            const childPath = `${path}.${key}`;
            let sanitizedChild;
            if (shouldRedactSecretKey(key, child)) {
                sanitizedChild = "[REDACTED:secret]";
                redactions.push({ path: childPath, reason: "secret-key" });
            }
            else {
                sanitizedChild = sanitizeValue(child, childPath, limits, redactions, truncations);
            }
            Object.defineProperty(output, key, {
                value: sanitizedChild,
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }
        return output;
    }
    return String(value);
}
function redactString(value, path, redactions) {
    let output = redactSecretAssignments(value, path, redactions);
    for (const pattern of TOKEN_PATTERNS) {
        output = output.replace(pattern.regex, (...args) => {
            redactions.push({ path, reason: "token-pattern" });
            if (typeof pattern.replacement === "function") {
                return pattern.replacement(args[0], ...args.slice(1));
            }
            return pattern.replacement;
        });
    }
    return output;
}
function truncateString(value, path, limits, truncations) {
    const bytes = byteLength(value);
    if (bytes <= limits.maxStringBytes)
        return value;
    truncations.push({
        path,
        kind: "string",
        original_bytes: bytes,
        sha256: sha256(value),
    });
    return {
        lcm_truncated: true,
        kind: "string",
        original_bytes: bytes,
        sha256: sha256(value),
        preview: truncateUtf8(value, limits.maxStringBytes),
    };
}
function truncateUtf8(value, maxBytes) {
    let output = "";
    let bytes = 0;
    for (const char of value) {
        const charBytes = byteLength(char);
        if (bytes + charBytes > maxBytes)
            break;
        output += char;
        bytes += charBytes;
    }
    return output;
}
function safeJsonByteLength(value) {
    try {
        return byteLength(JSON.stringify(value) ?? "");
    }
    catch {
        return byteLength(String(value));
    }
}
