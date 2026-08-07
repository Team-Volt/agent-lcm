import { createHash } from "node:crypto";
export function contentText(value) {
    if (!Array.isArray(value))
        return "";
    return value
        .map((entry) => {
        if (!isRecord(entry))
            return "";
        return stringValue(entry.text) || "";
    })
        .filter(Boolean)
        .join("\n\n")
        .trim();
}
export function contentSourceText(value) {
    if (!Array.isArray(value))
        return "";
    return value.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.text !== "string")
            return [];
        return [entry.text];
    }).join("\n\n");
}
export function isSyntheticContextText(text) {
    const trimmed = text.trimStart();
    return trimmed.startsWith("<environment_context>") ||
        trimmed.startsWith("<developer") ||
        trimmed.startsWith("<apps_instructions>") ||
        trimmed.startsWith("<skills_instructions>") ||
        trimmed.startsWith("<plugins_instructions>");
}
export function isCrossShapeMessageDuplicate(state, source, role, text) {
    const fingerprint = createHash("sha256")
        .update(JSON.stringify([role, state.sessionId || "", state.turnId || "", text]))
        .digest("hex");
    const fingerprints = state.unmatchedMessageFingerprints ?? new Map();
    state.unmatchedMessageFingerprints = fingerprints;
    const counts = fingerprints.get(fingerprint) ?? { event_msg: 0, response_item: 0 };
    const opposite = source === "event_msg" ? "response_item" : "event_msg";
    if (counts[opposite] > 0) {
        fingerprints.set(fingerprint, { ...counts, [opposite]: counts[opposite] - 1 });
        return true;
    }
    fingerprints.set(fingerprint, { ...counts, [source]: counts[source] + 1 });
    return false;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function stringValue(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
