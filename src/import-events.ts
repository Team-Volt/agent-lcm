import path from "node:path";

import { harnessSessionId, type NormalizedEvent } from "./events.ts";
import { mapHarnessEvent } from "./harnesses.ts";
import type { ImportHarness } from "./import.ts";
import { sha256 } from "./redact.ts";

export function mapImportedEvent(
  harness: ImportHarness,
  nativeEvent: string,
  payload: Record<string, unknown>,
  source: string,
  position: string | number,
  at: string,
): NormalizedEvent {
  const event = mapHarnessEvent(harness, nativeEvent, payload, { now: () => new Date(at), env: {} });
  const nativeSessionId = event.session_id.replace(new RegExp(`^${harness}:`, "u"), "");
  const eventId = sha256([harness, nativeSessionId, path.resolve(source), String(position), sha256(JSON.stringify(event.payload))].join("\0"));
  return { ...event, session_id: harnessSessionId(harness, nativeSessionId), event_id: eventId };
}
