import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { NativeLifecycleCommandError, runHarnessLifecycle } from "../src/setup-adapters.ts";

const GUIDE_ROOT = "https://github.com/Team-Volt/agent-lcm/blob/main/docs/install";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Codex setup and remove send the exact argv", (t) => {
  // Given: a capable fake Codex CLI that records each argv vector.
  const fake = fakeCli(t, "codex");

  // When: Agent LCM sets up and removes Codex.
  const setup = runHarnessLifecycle("codex", "setup", { env: fake.env });
  const remove = runHarnessLifecycle("codex", "remove", { env: fake.env });

  // Then: only the documented argv arrays reached the CLI.
  assert.deepEqual(setup, {
    harness: "codex",
    action: "setup",
    status: "native-complete",
    nativeCli: "codex",
    guide: `${GUIDE_ROOT}/codex.md`,
  });
  assert.deepEqual(remove, {
    harness: "codex",
    action: "remove",
    status: "native-complete",
    nativeCli: "codex",
    guide: `${GUIDE_ROOT}/codex.md`,
  });
  assert.deepEqual(readCalls(fake.log), [
    ["plugin", "list"],
    ["plugin", "marketplace", "add", PACKAGE_ROOT],
    ["plugin", "add", "agent-lcm@agent-lcm"],
    ["plugin", "list"],
    ["plugin", "remove", "agent-lcm@agent-lcm"],
  ]);
});

test("Copilot and VS Code setup send the exact Copilot argv", (t) => {
  // Given: a capable fake Copilot CLI that records each argv vector.
  const fake = fakeCli(t, "copilot");

  // When: Agent LCM sets up Copilot and VS Code.
  const command = "/opt/agent-lcm/bin/agent-lcm";
  const copilot = runHarnessLifecycle("copilot", "setup", { env: fake.env, command });
  const vscode = runHarnessLifecycle("vscode", "setup", { env: fake.env, command });

  // Then: both use the shared Copilot store and keep their own guide.
  assert.deepEqual(copilot, {
    harness: "copilot",
    action: "setup",
    status: "native-complete",
    nativeCli: "copilot",
    guide: `${GUIDE_ROOT}/copilot.md`,
  });
  assert.deepEqual(vscode, {
    harness: "vscode",
    action: "setup",
    status: "native-complete",
    nativeCli: "copilot",
    guide: `${GUIDE_ROOT}/vscode.md`,
  });
  const calls = readCalls(fake.log);
  assert.deepEqual(calls.map((argv) => argv.slice(0, 2)), [
    ["plugin", "list"],
    ["plugin", "install"],
    ["plugin", "list"],
    ["plugin", "install"],
  ]);
  for (const argv of calls.filter((entry) => entry[1] === "install")) {
    assert.equal(argv.length, 3);
    assert.equal(path.basename(argv[2] ?? ""), "agent-lcm");
    assert.equal(fs.existsSync(argv[2] ?? ""), false);
  }
  for (const snapshot of readPluginSnapshots(fake.pluginLog)) {
    assert.equal(snapshot.plugin.hooks, "hooks.json");
    assert.equal(snapshot.plugin.mcpServers, ".mcp.json");
    assert.equal(snapshot.skill, true);
    assert.equal(JSON.stringify(snapshot.hooks).includes("${PLUGIN_ROOT}"), false);
    assert.equal(JSON.stringify(snapshot.mcp).includes("${PLUGIN_ROOT}"), false);
    assert.match(JSON.stringify(snapshot.hooks), new RegExp(command, "u"));
    assert.deepEqual(snapshot.mcp.mcpServers["agent-lcm"], {
      type: "stdio",
      command: "node",
      args: [command, "mcp"],
    });
  }
});

test("manual-required outcomes probe only documented harness version commands", (t) => {
  // Given: installed Cursor and Kiro CLIs, plus unavailable Codex and Copilot CLIs.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lcm-empty-bin-"));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  const cursorCli = fakeCli(t, "cursor-agent");
  const kiroCli = fakeCli(t, "kiro-cli");

  // When: native setup is requested for every manual or unavailable harness.
  const cursor = runHarnessLifecycle("cursor", "setup", { env: cursorCli.env });
  const missingCursor = runHarnessLifecycle("cursor", "remove", { env: { PATH: bin } });
  const kiro = runHarnessLifecycle("kiro", "remove", { env: kiroCli.env });
  const codex = runHarnessLifecycle("codex", "setup", { env: { PATH: bin } });

  // Then: each reports its canonical guide without a native success claim.
  assert.deepEqual(cursor, {
    harness: "cursor",
    action: "setup",
    status: "manual-required",
    nativeCli: "cursor-agent",
    guide: `${GUIDE_ROOT}/cursor.md`,
  });
  assert.deepEqual(kiro, {
    harness: "kiro",
    action: "remove",
    status: "manual-required",
    nativeCli: "kiro-cli",
    guide: `${GUIDE_ROOT}/kiro.md`,
  });
  assert.deepEqual(missingCursor, {
    harness: "cursor",
    action: "remove",
    status: "manual-required",
    nativeCli: null,
    guide: `${GUIDE_ROOT}/cursor.md`,
  });
  assert.deepEqual(codex, {
    harness: "codex",
    action: "setup",
    status: "manual-required",
    nativeCli: null,
    guide: `${GUIDE_ROOT}/codex.md`,
  });
  assert.deepEqual(readCalls(cursorCli.log), [["--version"]]);
  assert.deepEqual(readCalls(kiroCli.log), [["--version"]]);
});

test("a failing native probe is a command error, not an unavailable CLI", (t) => {
  const fake = fakeCli(t, "copilot", ["plugin", "list"]);

  assert.throws(() => runHarnessLifecycle("copilot", "setup", { env: fake.env }), (error: unknown) => {
    assert.ok(error instanceof NativeLifecycleCommandError);
    assert.equal(error.executable, "copilot");
    assert.deepEqual(error.argv, ["plugin", "list"]);
    assert.equal(error.status, 23);
    assert.equal(error.stderr, "suppressed");
    return true;
  });
  assert.deepEqual(readCalls(fake.log), [["plugin", "list"]]);
});

test("a failing installed manual CLI probe is a command error", (t) => {
  const fake = fakeCli(t, "kiro-cli", ["--version"]);

  assert.throws(() => runHarnessLifecycle("kiro", "setup", { env: fake.env }), (error: unknown) => {
    assert.ok(error instanceof NativeLifecycleCommandError);
    assert.equal(error.executable, "kiro-cli");
    assert.deepEqual(error.argv, ["--version"]);
    assert.equal(error.status, 23);
    assert.equal(error.stderr, "suppressed");
    return true;
  });
  assert.deepEqual(readCalls(fake.log), [["--version"]]);
});

test("a native probe permission error is not treated as a missing CLI", { skip: process.platform === "win32" }, (t) => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lcm-denied-cli-"));
  fs.writeFileSync(path.join(bin, "codex"), "denied\n", { mode: 0o600 });
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));

  assert.throws(() => runHarnessLifecycle("codex", "setup", { env: { PATH: bin } }), (error: unknown) => {
    assert.ok(error instanceof NativeLifecycleCommandError);
    assert.deepEqual(error.argv, ["plugin", "list"]);
    assert.equal(error.status, null);
    assert.equal(error.stderr, "suppressed");
    return true;
  });
});

test("a Windows shim lookup error cannot fall through to a later PATH entry", { skip: process.platform !== "win32" }, (t) => {
  const blocked = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lcm-blocked-cli-"));
  const fake = fakeCli(t, "codex");
  t.after(() => fs.rmSync(blocked, { recursive: true, force: true }));
  t.mock.method(fs, "statSync", () => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  });

  assert.throws(
    () => runHarnessLifecycle("codex", "setup", { env: { ...fake.env, PATH: `${blocked}${path.delimiter}${fake.env.PATH ?? ""}` } }),
    (error: unknown) => {
      assert.ok(error instanceof NativeLifecycleCommandError);
      assert.equal(error.status, null);
      assert.equal(error.stderr, "suppressed");
      return true;
    },
  );
  assert.equal(fs.existsSync(fake.log), false);
});

test("shared-retained removal does not spawn Copilot uninstall", (t) => {
  // Given: a fake Copilot CLI that would record any spawned process.
  const fake = fakeCli(t, "copilot");

  // When: either shared-store harness is removed alone.
  const vscode = runHarnessLifecycle("vscode", "remove", { env: fake.env });
  const copilot = runHarnessLifecycle("copilot", "remove", { env: fake.env });

  // Then: no probe or uninstall runs and both outcomes retain the shared store.
  assert.deepEqual(vscode, {
    harness: "vscode",
    action: "remove",
    status: "shared-retained",
    nativeCli: null,
    guide: `${GUIDE_ROOT}/vscode.md`,
  });
  assert.deepEqual(copilot, {
    harness: "copilot",
    action: "remove",
    status: "shared-retained",
    nativeCli: null,
    guide: `${GUIDE_ROOT}/copilot.md`,
  });
  assert.equal(fs.existsSync(fake.log), false);
});

test("mutating command failure is typed and cannot report completion", (t) => {
  // Given: a capable fake Codex CLI that fails its marketplace mutation.
  const fake = fakeCli(t, "codex", ["plugin", "marketplace", "add", PACKAGE_ROOT]);

  // When: Agent LCM attempts Codex setup.
  const run = () => runHarnessLifecycle("codex", "setup", { env: fake.env });

  // Then: the mutation failure includes its executable, argv, status, and bounded stderr.
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof NativeLifecycleCommandError);
    assert.equal(error.executable, "codex");
    assert.deepEqual(error.argv, ["plugin", "marketplace", "add", PACKAGE_ROOT]);
    assert.equal(error.status, 23);
    assert.equal(error.stderr, "suppressed");
    assert.equal(
      error.message,
      `Native lifecycle command failed: executable=codex argv=plugin marketplace add ${PACKAGE_ROOT} status=23 stderr=suppressed`,
    );
    return true;
  });
  assert.deepEqual(readCalls(fake.log), [
    ["plugin", "list"],
    ["plugin", "marketplace", "add", PACKAGE_ROOT],
  ]);
});

function fakeCli(
  t: test.TestContext,
  name: "codex" | "copilot" | "cursor-agent" | "kiro-cli",
  fails?: readonly string[],
): { readonly env: NodeJS.ProcessEnv; readonly log: string; readonly pluginLog: string } {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lcm-fake-cli-"));
  const log = path.join(bin, "calls.jsonl");
  const pluginLog = path.join(bin, "plugins.jsonl");
  const failure = fails ? JSON.stringify(fails) : "";
  const script = `#!/usr/bin/env node\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst args = process.argv.slice(2);\nfs.appendFileSync(process.env.AGENT_LCM_FAKE_LOG, JSON.stringify(args) + "\\n");\nif (args[0] === "plugin" && args[1] === "install" && args[2]) { const root = args[2]; fs.appendFileSync(process.env.AGENT_LCM_FAKE_PLUGIN_LOG, JSON.stringify({ plugin: JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8")), hooks: JSON.parse(fs.readFileSync(path.join(root, "hooks.json"), "utf8")), mcp: JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8")), skill: fs.existsSync(path.join(root, "skills/lcm-recall/SKILL.md")) }) + "\\n"); }\nif (${JSON.stringify(failure)} && JSON.stringify(args) === ${JSON.stringify(failure)}) { process.stderr.write("mutation failed\\n"); process.exit(23); }\n`;
  writeFakeCli(bin, name, script);
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  return {
    env: {
      AGENT_LCM_FAKE_LOG: log,
      AGENT_LCM_FAKE_PLUGIN_LOG: pluginLog,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    log,
    pluginLog,
  };
}

function writeFakeCli(bin: string, name: string, script: string): void {
  if (process.platform === "win32") {
    const source = path.join(bin, `${name}.cjs`);
    fs.writeFileSync(source, script.replace(/^#![^\n]*\n/u, ""));
    fs.writeFileSync(path.join(bin, `${name}.cmd`), `@"${process.execPath}" "${source}" %*\r\n`);
    return;
  }
  fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
}

type PluginSnapshot = {
  readonly plugin: Record<string, unknown>;
  readonly hooks: Record<string, unknown>;
  readonly mcp: { readonly mcpServers: Record<string, unknown> };
  readonly skill: boolean;
};

function readPluginSnapshots(log: string): PluginSnapshot[] {
  return fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as PluginSnapshot);
}

function readCalls(log: string): string[][] {
  const contents = fs.readFileSync(log, "utf8").trim();
  return contents.length === 0 ? [] : contents.split("\n").map(readCall);
}

function readCall(line: string): string[] {
  const value: unknown = JSON.parse(line);
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("Fake CLI log entry must be a string array");
  }
  return value;
}
