import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readJson } from "./helpers.ts";

test("the npm package contains the complete plugin and no development files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lcm-pack-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = spawnSync("npm", ["pack", "--json", "--pack-destination", root], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: path.join(root, "cache") },
    shell: process.platform === "win32",
  });
  assert.equal(result.status, 0, result.stderr);
  const [{ filename, files }] = JSON.parse(result.stdout) as [{ filename: string; files: Array<{ path: string }> }];
  const names = files.map((file) => file.path);

  for (const required of [
    ".agents/plugins/marketplace.json",
    ".codex-plugin/plugin.json",
    ".cursor-plugin/marketplace.json",
    ".cursor-plugin/plugin.json",
    ".mcp.json",
    "LICENSE",
    "README.md",
    "bin/agent-lcm",
    "hooks.json",
    "mcp.cursor.json",
    "mcp.json",
    "package.json",
    "plugin.json",
    "skills/lcm-recall/SKILL.md",
    "dist/cli.js",
    "dist/copilot-plugin.js",
    "dist/setup-adapters.js",
    "dist/setup-file-worker.js",
    "dist/setup-hook-status.js",
    "dist/setup-hooks.js",
  ]) assert.ok(names.includes(required), `missing ${required}`);
  assert.equal(names.some((name) => /^(?:\.github|docs|scripts|tests)\//u.test(name)), false);
  assert.equal(fs.existsSync(path.join(root, filename)), true);

  const packageJson = readJson("package.json");
  for (const script of ["preinstall", "install", "postinstall", "build", "prepack", "prepare"]) {
    assert.equal(packageJson.scripts?.[script], undefined);
  }
});

test("package and native plugin versions stay in sync", () => {
  const packageJson = readJson("package.json");
  const version = packageJson.version;
  assert.equal(packageJson.name, "@team-volt/agent-lcm");
  assert.equal(readJson("plugin.json").version, version);
  assert.equal(readJson(".codex-plugin/plugin.json").version, version);
  assert.equal(readJson(".cursor-plugin/plugin.json").version, version);
});

test("the publish workflow passes the release tag to the shell as data", () => {
  const workflow = fs.readFileSync(".github/workflows/publish.yml", "utf8");
  assert.doesNotMatch(workflow, /run:.*\$\{\{\s*github\.event\.release\.tag_name\s*\}\}/u);
  assert.match(workflow, /RELEASE_TAG: \$\{\{\s*github\.event\.release\.tag_name\s*\}\}/u);
  assert.match(workflow, /npm run release:check -- "\$RELEASE_TAG"/u);
});

test("the release check rejects a tag that does not match the package", () => {
  const version = readJson("package.json").version;
  const valid = spawnSync("node", ["--no-warnings", "scripts/release.ts", "check", `v${version}`], {
    cwd: path.resolve("."), encoding: "utf8",
  });
  assert.equal(valid.status, 0, valid.stderr);

  const invalid = spawnSync("node", ["--no-warnings", "scripts/release.ts", "check", "v9.9.9"], {
    cwd: path.resolve("."), encoding: "utf8",
  });
  assert.notEqual(invalid.status, 0);
});

test("the release script updates every versioned package file", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lcm-version-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = [
    "package.json",
    "package-lock.json",
    "plugin.json",
    ".codex-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
  ];
  for (const file of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.copyFileSync(file, path.join(root, file));
  }

  const result = spawnSync("node", ["--no-warnings", path.resolve("scripts/release.ts"), "set", "0.0.2"], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  for (const file of files) assert.equal(readJson(path.join(root, file)).version, "0.0.2", file);
  assert.equal(readJson(path.join(root, "package-lock.json")).packages[""].version, "0.0.2");
});

test("the Codex marketplace installs the repository-root plugin", () => {
  const marketplace = readJson(".agents/plugins/marketplace.json");
  assert.equal(marketplace.name, "agent-lcm");
  assert.deepEqual(marketplace.plugins[0], {
    name: "agent-lcm",
    source: { source: "local", path: "." },
    policy: { installation: "AVAILABLE", authentication: "ON_USE" },
    category: "Developer Tools",
  });
});

test("the Cursor marketplace installs the repository-root plugin", () => {
  const marketplace = readJson(".cursor-plugin/marketplace.json");
  assert.equal(marketplace.name, "agent-lcm");
  assert.deepEqual(marketplace.plugins, [{
    name: "agent-lcm",
    source: ".",
    description: "Shared local context memory for agent harnesses.",
  }]);
});

test("the packed CLI runs outside the checkout and sets up detected harnesses", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lcm-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = path.join(root, "cache");
  const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", root], {
    cwd: path.resolve("."), encoding: "utf8", env: { ...process.env, npm_config_cache: cache }, shell: process.platform === "win32",
  });
  assert.equal(pack.status, 0, pack.stderr);
  const [{ filename }] = JSON.parse(pack.stdout) as [{ filename: string }];
  const prefix = path.join(root, "prefix");
  const install = spawnSync("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", path.join(root, filename)], {
    cwd: root, encoding: "utf8", env: { ...process.env, npm_config_cache: cache }, shell: process.platform === "win32",
  });
  assert.equal(install.status, 0, install.stderr);
  const executable = process.platform === "win32" ? path.join(prefix, "agent-lcm.cmd") : path.join(prefix, "bin", "agent-lcm");
  const home = path.join(root, "home");
  const fakeBin = path.join(root, "fake-bin");
  const fakeLog = path.join(root, "codex-calls.jsonl");
  const fakeScript = path.join(root, "fake-codex.cjs");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(fakeScript, 'require("node:fs").appendFileSync(process.env.AGENT_LCM_FAKE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\n');
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(fakeBin, "codex.cmd"), `@"${process.execPath}" "${fakeScript}" %*\r\n`);
  } else {
    fs.writeFileSync(path.join(fakeBin, "codex"), `#!${process.execPath}\nrequire(${JSON.stringify(fakeScript)});\n`, { mode: 0o755 });
  }
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AGENT_LCM_HOME: path.join(home, ".agent-lcm"),
    AGENT_LCM_FAKE_LOG: fakeLog,
    PATH: `${fakeBin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const runInstalled = (args: string[], input?: string) => spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    env,
    input,
    shell: process.platform === "win32",
    timeout: 15_000,
  });
  t.after(() => runInstalled(["daemon", "stop", "--json"]));

  const version = runInstalled(["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), readJson("package.json").version);
  const versionCommand = runInstalled(["version"]);
  assert.equal(versionCommand.status, 0, versionCommand.stderr);
  assert.equal(versionCommand.stdout.trim(), readJson("package.json").version);
  const packageRoot = path.join(
    prefix,
    ...(process.platform === "win32" ? [] : ["lib"]),
    "node_modules",
    "@team-volt",
    "agent-lcm",
  );
  const mcpConfiguration = JSON.parse(fs.readFileSync(path.join(packageRoot, "mcp.json"), "utf8"))
    .mcpServers["agent-lcm"] as { command: string; args: string[] };
  const mcp = spawnSync(mcpConfiguration.command, mcpConfiguration.args.map((arg) => arg.replaceAll("${PLUGIN_ROOT}", packageRoot)), {
    cwd: packageRoot,
    encoding: "utf8",
    env,
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`,
    timeout: 15_000,
  });
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.equal(JSON.parse(mcp.stdout).result.serverInfo.version, readJson("package.json").version);
  const cursorMcpConfiguration = JSON.parse(fs.readFileSync(path.join(packageRoot, "mcp.cursor.json"), "utf8"))
    .mcpServers["agent-lcm"] as { command: string; args: string[] };
  const cursorMcp = spawnSync(cursorMcpConfiguration.command, cursorMcpConfiguration.args.map((arg) => arg.replaceAll("${CURSOR_PLUGIN_ROOT}", packageRoot)), {
    cwd: packageRoot,
    encoding: "utf8",
    env,
    input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`,
    timeout: 15_000,
  });
  assert.equal(cursorMcp.status, 0, cursorMcp.stderr);
  assert.equal(JSON.parse(cursorMcp.stdout).result.serverInfo.version, readJson("package.json").version);
  const importRoot = path.join(root, "empty-codex-sessions");
  fs.mkdirSync(importRoot);
  const imported = runInstalled(["import", "--harness", "codex", importRoot, "--dry-run", "--json"]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).events_imported, 0);
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const setup = runInstalled(["setup", "all", "--json"]);
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal((JSON.parse(setup.stdout) as unknown[]).length, 1);
  assert.equal(fs.existsSync(path.join(home, ".cursor")), false);
  assert.equal(fs.existsSync(path.join(home, ".copilot")), false);
  assert.equal(fs.existsSync(path.join(home, ".kiro")), false);
  const codexHooks = JSON.parse(fs.readFileSync(path.join(home, ".codex/hooks.json"), "utf8"));
  const capture = spawnSync(codexHooks.hooks.UserPromptSubmit[0].hooks[0].command, {
    cwd: root,
    encoding: "utf8",
    env,
    input: JSON.stringify({ session_id: "distribution-session", cwd: root, prompt: "capture from installed hook" }),
    shell: true,
    timeout: 15_000,
  });
  assert.equal(capture.status, 0, capture.stderr);
  const postCompact = spawnSync(codexHooks.hooks.PostCompact[0].hooks[0].command, {
    cwd: root,
    encoding: "utf8",
    env,
    input: JSON.stringify({ session_id: "distribution-session", cwd: root, hook_event_name: "PostCompact" }),
    shell: true,
    timeout: 15_000,
  });
  assert.equal(postCompact.status, 0, postCompact.stderr);
  assert.equal(fs.readdirSync(path.join(env.AGENT_LCM_HOME, "post-compact-recovery")).length, 1);
  const daemon = runInstalled(["daemon", "start", "--json"]);
  assert.equal(daemon.status, 0, daemon.stderr);
  assert.equal(JSON.parse(daemon.stdout).running, true);
  const stopped = runInstalled(["daemon", "stop", "--json"]);
  assert.equal(stopped.status, 0, stopped.stderr);
  const removed = runInstalled(["remove", "codex", "--json"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(JSON.parse(removed.stdout).hooks.changed, true);
  assert.deepEqual(fs.readFileSync(fakeLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)), [
    ["plugin", "list"],
    ["plugin", "marketplace", "add", fs.realpathSync(packageRoot)],
    ["plugin", "add", "agent-lcm@agent-lcm"],
    ["plugin", "list"],
    ["plugin", "remove", "agent-lcm@agent-lcm"],
  ]);
  assert.equal(JSON.parse(stopped.stdout).running, false);
});
