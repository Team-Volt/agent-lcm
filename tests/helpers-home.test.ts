import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertCliOk, isolatedCliEnv, readJsonl, runCli, tempHome } from "./helpers.ts";

test("runCli ignores process HOME cursor hooks unless the test sets a home override", (t) => {
  const liveHome = tempHome("agent-lcm-live-home-");
  const lcmHome = tempHome("agent-lcm-home-");
  t.after(() => {
    fs.rmSync(liveHome, { recursive: true, force: true });
    fs.rmSync(lcmHome, { recursive: true, force: true });
  });
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

    for (const override of [{ HOME: liveHome }, { USERPROFILE: liveHome }, { HOME: liveHome, USERPROFILE: liveHome }]) {
      const explicit = runCli(["doctor", "--json"], { env: { AGENT_LCM_HOME: lcmHome, ...override } });
      assertCliOk(explicit);
      assert.equal(JSON.parse(explicit.stdout).adapter_status.cursor.configured, true);
      assert.equal(fs.existsSync(path.join(liveHome, ".cursor", "hooks.json")), true);
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
  }
});

test("default CLI homes are unique and do not inherit stale harness configuration", () => {
  const first = isolatedCliEnv();
  let second: ReturnType<typeof isolatedCliEnv> | undefined;
  try {
    const firstHome = first.env.HOME!;
    fs.mkdirSync(path.join(firstHome, ".cursor"));
    fs.writeFileSync(path.join(firstHome, ".cursor", "hooks.json"), "stale configuration");
    second = isolatedCliEnv();
    assert.notEqual(second.env.HOME, firstHome);
    assert.equal(first.env.USERPROFILE, firstHome);
    assert.equal(second.env.USERPROFILE, second.env.HOME);
    assert.deepEqual(fs.readdirSync(second.env.HOME!), []);
    assert.equal(fs.existsSync(path.join(firstHome, ".cursor", "hooks.json")), true);
  } finally {
    first.cleanup();
    second?.cleanup();
  }
  assert.equal(fs.existsSync(first.env.HOME!), false);
  assert.equal(fs.existsSync(second!.env.HOME!), false);
});

test("runCli reuses its temporary home for daemon cleanup and removes it on success or failure", (t) => {
  const fixture = tempHome("agent-lcm-home-lifecycle-");
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const preload = path.join(fixture, "observe-home.cjs");
  const log = path.join(fixture, "homes.jsonl");
  fs.writeFileSync(preload, `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  args: process.argv.slice(2),
  home: process.env.HOME,
  profile: process.env.USERPROFILE,
  exists: fs.existsSync(process.env.HOME),
}) + "\\n");
`);
  const homes: string[] = [];
  for (const args of [["doctor", "--json"], ["unknown-command"]]) {
    fs.writeFileSync(log, "");
    const result = runCli(args, {
      env: { AGENT_LCM_HOME: path.join(fixture, "lcm"), NODE_OPTIONS: `--require ${JSON.stringify(preload)}` },
    });
    assert.equal(result.status, args[0] === "doctor" ? 0 : 1, result.stderr);
    const observations = readJsonl(log) as { args: string[]; home: string; profile: string; exists: boolean }[];
    const expectedArgs = args[0] === "doctor"
      ? [args, ["daemon", "run"], ["daemon", "stop"]]
      : [args, ["daemon", "stop"]];
    assert.deepEqual(observations.map((entry) => entry.args), expectedArgs);
    const home = observations[0]!.home;
    for (const entry of observations) {
      assert.equal(entry.home, home);
      assert.equal(entry.profile, home);
      assert.equal(entry.exists, true);
    }
    assert.equal(fs.existsSync(home), false);
    homes.push(home);
  }
  assert.notEqual(homes[0], homes[1]);
});
