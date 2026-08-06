import type { NormalizedEvent } from "./events.ts";

export class PersistedEventError extends Error {
  constructor() {
    super("Persisted event does not match schema version 1.");
    this.name = "PersistedEventError";
  }
}

export function decodePersistedEvent(serialized: string): NormalizedEvent {
  const event = parsePersistedEvent(serialized);
  if (!event) throw new PersistedEventError();
  return event;
}

export function parsePersistedEvent(serialized: string): NormalizedEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  return isNormalizedEvent(value) ? value : undefined;
}

function isNormalizedEvent(value: unknown): value is NormalizedEvent {
  if (!isRecord(value)) return false;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
