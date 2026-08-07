import { HARNESS_NAMES } from "./events.js";
export class PersistedEventError extends Error {
    constructor() {
        super("Persisted event does not match schema version 1.");
        this.name = "PersistedEventError";
    }
}
export function decodePersistedEvent(serialized) {
    const event = parsePersistedEvent(serialized);
    if (!event)
        throw new PersistedEventError();
    return event;
}
export function parsePersistedEvent(serialized) {
    let value;
    try {
        value = JSON.parse(serialized);
    }
    catch (error) {
        if (error instanceof SyntaxError)
            return undefined;
        throw error;
    }
    if (!isNormalizedEvent(value))
        return undefined;
    return {
        ...value,
        harness: isHarnessName(value.harness) ? value.harness : "codex",
        native_event: isString(value.native_event) ? value.native_event : value.hook_event,
    };
}
function isNormalizedEvent(value) {
    if (!isRecord(value))
        return false;
    return value.schema_version === 1
        && isString(value.event_id)
        && isString(value.timestamp)
        && isString(value.hook_event)
        && isString(value.session_id)
        && isString(value.cwd)
        && isOptionalString(value.project)
        && isOptionalString(value.repo_root)
        && isOptionalString(value.git_branch)
        && isOptionalString(value.tool_name)
        && isRecord(value.payload)
        && Array.isArray(value.redactions)
        && Array.isArray(value.truncations)
        && isString(value.raw_input_sha256)
        && isNonNegativeNumber(value.original_bytes)
        && isNonNegativeNumber(value.sanitized_bytes);
}
function isHarnessName(value) {
    return typeof value === "string" && HARNESS_NAMES.includes(value);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isString(value) {
    return typeof value === "string";
}
function isOptionalString(value) {
    return value === undefined || isString(value);
}
function isNonNegativeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
