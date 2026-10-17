import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertCliOk, runCli, tempHome } from "./helpers.ts";

test("runCli ignores process HOME cursor hooks unless the test sets HOME", () => {
  const liveHome = tempHome("agent-lcm-live-home-");
  const lcmHome = tempHome("agent-lcm-home-");
  const command = `node "${path.join(liveHome, "bin", "agent-lcm")}" capture --harness cursor`;
  fs.mkdirSync(path.join(liveHome, ".cursor"), { recursive: true });
  fs.writeFileSync(path.join(liveHome, ".cursor", "hooks.json"), JSON.stringify({
    version: 1,
    hooks: {
      sessionStart: [{ type: "command", command: `${command} SessionStart` }],
      beforeSubmitPrompt: [{ type: "command", command: `${command} UserPromptSubmit` }],
      postToolUse: [{ type: "command", command: `${command} PostToolUse` }],
      stop: [{ type: "command", command: `${command} Stop` }],
    },
  }));

  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = liveHome;
  process.env.USERPROFILE = liveHome;
  try {
    const isolated = runCli(["doctor", "--json"], { env: { AGENT_LCM_HOME: lcmHome } });
    assertCliOk(isolated);
    assert.equal(JSON.parse(isolated.stdout).adapter_status.cursor.configured, false);

    const explicit = runCli(["doctor", "--json"], { env: { AGENT_LCM_HOME: lcmHome, HOME: liveHome, USERPROFILE: liveHome } });
    assertCliOk(explicit);
    assert.equal(JSON.parse(explicit.stdout).adapter_status.cursor.configured, true);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
  }
});
