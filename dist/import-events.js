import path from "node:path";
import { harnessSessionId } from "./events.js";
import { mapHarnessEvent } from "./harnesses.js";
import { sha256 } from "./redact.js";
export function mapImportedEvent(harness, nativeEvent, payload, source, position, at) {
    const event = mapHarnessEvent(harness, nativeEvent, payload, { now: () => new Date(at), env: {} });
    const nativeSessionId = event.session_id.replace(new RegExp(`^${harness}:`, "u"), "");
    const eventId = sha256([harness, nativeSessionId, path.resolve(source), String(position), sha256(JSON.stringify(event.payload))].join("\0"));
    return { ...event, session_id: harnessSessionId(harness, nativeSessionId), event_id: eventId };
}
