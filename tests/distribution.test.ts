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
  });
  assert.equal(result.status, 0, result.stderr);
  const [{ filename, files }] = JSON.parse(result.stdout) as [{ filename: string; files: Array<{ path: string }> }];
  const names = files.map((file) => file.path);

  for (const required of [
    ".agents/plugins/marketplace.json",
    ".codex-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
    "LICENSE",
    "README.md",
    "bin/agent-lcm",
    "hooks.json",
    "mcp.json",
    "package.json",
    "plugin.json",
    "skills/lcm-recall/SKILL.md",
    "dist/cli.js",
  ]) assert.ok(names.includes(required), `missing ${required}`);
  assert.equal(names.some((name) => /^(?:\.github|docs|scripts|tests)\//u.test(name)), false);
  assert.equal(fs.existsSync(path.join(root, filename)), true);

  const packageJson = readJson("package.json");
  for (const script of ["preinstall", "install", "postinstall"]) assert.equal(packageJson.scripts?.[script], undefined);
});

test("package and native plugin versions stay in sync", () => {
  const version = readJson("package.json").version;
  assert.equal(readJson("plugin.json").version, version);
  assert.equal(readJson(".codex-plugin/plugin.json").version, version);
  assert.equal(readJson(".cursor-plugin/plugin.json").version, version);
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

test("the packed CLI runs outside the checkout and sets up every harness", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lcm-install-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = path.join(root, "cache");
  const pack = spawnSync("npm", ["pack", "--json", "--pack-destination", root], {
    cwd: path.resolve("."), encoding: "utf8", env: { ...process.env, npm_config_cache: cache },
  });
  assert.equal(pack.status, 0, pack.stderr);
  const [{ filename }] = JSON.parse(pack.stdout) as [{ filename: string }];
  const prefix = path.join(root, "prefix");
  const install = spawnSync("npm", ["install", "--global", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", path.join(root, filename)], {
    cwd: root, encoding: "utf8", env: { ...process.env, npm_config_cache: cache },
  });
  assert.equal(install.status, 0, install.stderr);
  const executable = process.platform === "win32" ? path.join(prefix, "agent-lcm.cmd") : path.join(prefix, "bin", "agent-lcm");
  const home = path.join(root, "home");
  const env = { ...process.env, HOME: home, USERPROFILE: home, AGENT_LCM_HOME: path.join(home, ".agent-lcm") };
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
  const mcp = runInstalled(["mcp"], `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`);
  assert.equal(mcp.status, 0, mcp.stderr);
  assert.equal(JSON.parse(mcp.stdout).result.serverInfo.version, readJson("package.json").version);
  const importRoot = path.join(root, "empty-codex-sessions");
  fs.mkdirSync(importRoot);
  const imported = runInstalled(["import", "--harness", "codex", importRoot, "--dry-run", "--json"]);
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).events_imported, 0);
  const setup = runInstalled(["setup", "all", "--json"]);
  assert.equal(setup.status, 0, setup.stderr);
  assert.equal((JSON.parse(setup.stdout) as unknown[]).length, 5);
  for (const relative of [
    ".codex/hooks/agent-lcm.json",
    ".cursor/hooks/agent-lcm.json",
    ".copilot/hooks/agent-lcm.json",
    ".kiro/hooks/agent-lcm.json",
  ]) assert.equal(fs.existsSync(path.join(home, relative)), true, `missing ${relative}`);
  const daemon = runInstalled(["daemon", "start", "--json"]);
  assert.equal(daemon.status, 0, daemon.stderr);
  assert.equal(JSON.parse(daemon.stdout).running, true);
  const stopped = runInstalled(["daemon", "stop", "--json"]);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).running, false);
});
