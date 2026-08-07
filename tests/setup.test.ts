import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { setupHarness } from "../src/setup.ts";
import { tempHome } from "./helpers.ts";

test("Kiro setup is repeatable and leaves sibling hooks unchanged", () => {
  const kiroHome = tempHome("agent-lcm-kiro-");
  const unrelatedKiroHook = path.join(kiroHome, "hooks", "other.json");
  fs.mkdirSync(path.dirname(unrelatedKiroHook), { recursive: true });
  fs.writeFileSync(unrelatedKiroHook, '{"version":"v1","hooks":{"SessionStart":[{"command":"other"}]}}\n');
  const original = fs.readFileSync(unrelatedKiroHook);

  const first = setupHarness("kiro", { home: kiroHome, command: "/opt/agent-lcm/bin/agent-lcm" });
  const second = setupHarness("kiro", { home: kiroHome, command: "/opt/agent-lcm/bin/agent-lcm" });

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(first.path, path.join(kiroHome, "hooks", "agent-lcm.json"));
  assert.deepEqual(fs.readFileSync(unrelatedKiroHook), original);
});

test("setup leaves invalid owned configuration untouched", () => {
  const kiroHome = tempHome("agent-lcm-kiro-invalid-");
  const setupPath = path.join(kiroHome, "hooks", "agent-lcm.json");
  fs.mkdirSync(path.dirname(setupPath), { recursive: true });
  fs.writeFileSync(setupPath, "{not json");
  const original = fs.readFileSync(setupPath);

  assert.throws(
    () => setupHarness("kiro", { home: kiroHome, command: "/opt/agent-lcm/bin/agent-lcm" }),
    new RegExp(setupPath.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&"), "u"),
  );
  assert.deepEqual(fs.readFileSync(setupPath), original);
});
