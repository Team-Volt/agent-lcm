import assert from "node:assert/strict";
import test from "node:test";

import { daemonProtocolCompatible } from "../src/daemon-protocol.ts";

test("daemon compatibility uses protocol identity with a legacy rollout exception", () => {
  assert.equal(daemonProtocolCompatible({ version: "9.9.9", protocol_version: 2 }), true);
  assert.equal(daemonProtocolCompatible({ version: "0.0.3", protocol_version: 1 }), false);
  assert.equal(daemonProtocolCompatible({ version: "0.1.0" }), true);
  assert.equal(daemonProtocolCompatible({ version: "0.0.0" }), false);
  assert.equal(daemonProtocolCompatible({ version: "0.1.0", protocol_version: 3 }), false);
});
