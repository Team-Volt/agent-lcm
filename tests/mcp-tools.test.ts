import assert from "node:assert/strict";
import test from "node:test";

import { callTool } from "../src/mcp-tools.ts";
import { createStorage } from "../src/storage.ts";
import { tempHome } from "./helpers.ts";

test("callTool uses its injected storage", () => {
  const storage = createStorage({ home: tempHome() });
  try {
    const result = callTool(storage, {
      name: "lcm_record_note",
      arguments: { sessionId: "codex:injected-tool", cwd: "/tmp/injected-tool", text: "injected owner" },
    }) as { structuredContent: { event: { session_id: string } } };
    assert.equal(result.structuredContent.event.session_id, "codex:injected-tool");
    assert.equal(storage.health().event_count, 1);
  } finally {
    storage.close();
  }
});
