import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { mutateSetupConfiguration } from "../src/setup-files.ts";
import { setupHarness } from "../src/setup.ts";
import { tempHome } from "./helpers.ts";

test("setup refuses a target symlink without changing the victim", { skip: process.platform === "win32" }, () => {
  // Given: a setup target points at an unrelated valid configuration.
  const home = tempHome("agent-lcm-setup-symlink-");
  const target = path.join(home, "hooks.json");
  const victim = path.join(home, "victim.json");
  const original = Buffer.from('{"hooks":{}}\n');
  fs.writeFileSync(victim, original);
  fs.symlinkSync(victim, target);

  // When: setup tries to mutate the target.
  assert.throws(
    () => setupHarness("codex", { home, command: "/opt/agent-lcm/bin/agent-lcm" }),
    /Refus.*symlink/u,
  );

  // Then: neither the link nor its victim is changed and no setup artifact appears.
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  assert.deepEqual(fs.readFileSync(victim), original);
  assert.deepEqual(setupArtifacts(home), []);
});

test("setup refuses a symlinked lock without changing the victim", { skip: process.platform === "win32" }, () => {
  const home = tempHome("agent-lcm-setup-lock-symlink-");
  const target = path.join(home, "hooks.json");
  const victim = path.join(home, "victim");
  fs.mkdirSync(victim);
  fs.symlinkSync(victim, `${target}.lock`);

  assert.throws(() => mutateSetupConfiguration(target, () => ({ hooks: {} })), /lock.*symlink/u);

  assert.equal(fs.lstatSync(`${target}.lock`).isSymbolicLink(), true);
  assert.deepEqual(fs.readdirSync(victim), []);
  assert.equal(fs.existsSync(target), false);
});

test("setup refuses a symlinked parent directory", { skip: process.platform === "win32" }, () => {
  const home = tempHome("agent-lcm-setup-parent-symlink-");
  const victim = path.join(home, "victim");
  const linked = path.join(home, "linked");
  fs.mkdirSync(victim);
  fs.symlinkSync(victim, linked);

  assert.throws(() => mutateSetupConfiguration(path.join(linked, "hooks.json"), () => ({ hooks: {} })), /directory symlink/u);

  assert.deepEqual(fs.readdirSync(victim), []);
});

test("a parent swap during lock acquisition cannot redirect setup", { skip: process.platform === "win32" }, () => {
  const home = tempHome("agent-lcm-setup-parent-race-");
  const safe = path.join(home, "safe");
  const originalSafe = path.join(home, "safe-original");
  const outside = path.join(home, "outside");
  const target = path.join(safe, "hooks.json");
  fs.mkdirSync(safe);
  fs.mkdirSync(outside);
  const originalSpawnSync = childProcess.spawnSync;
  let swapped = false;
  const swappedSpawnSync = ((command: string, args?: readonly string[], options?: childProcess.SpawnSyncOptions) => {
    if (!swapped && args?.includes("lock")) {
      swapped = true;
      fs.renameSync(safe, originalSafe);
      fs.symlinkSync(outside, safe);
    }
    return originalSpawnSync(command, args, options);
  }) as typeof childProcess.spawnSync;
  Object.defineProperty(childProcess, "spawnSync", { configurable: true, value: swappedSpawnSync });
  try {
    assert.throws(() => mutateSetupConfiguration(target, () => ({ hooks: {} })), /directory changed/u);
  } finally {
    Object.defineProperty(childProcess, "spawnSync", { configurable: true, value: originalSpawnSync });
  }
  assert.equal(fs.existsSync(path.join(outside, "hooks.json")), false);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("a parent swap during final publication cannot overwrite an outside target", { skip: process.platform === "win32" }, () => {
  const home = tempHome("agent-lcm-setup-publish-parent-race-");
  const safe = path.join(home, "safe");
  const moved = path.join(home, "safe-moved");
  const outside = path.join(home, "outside");
  const target = path.join(safe, "hooks.json");
  const victim = path.join(outside, "hooks.json");
  const original = Buffer.from('{"outside":true}\n');
  fs.mkdirSync(safe);
  fs.mkdirSync(outside);
  fs.writeFileSync(victim, original);
  const originalSpawnSync = childProcess.spawnSync;
  let swapped = false;
  const swappedSpawnSync = ((command: string, args?: readonly string[], options?: childProcess.SpawnSyncOptions) => {
    if (!swapped && args?.includes("write")) {
      swapped = true;
      fs.renameSync(safe, moved);
      fs.symlinkSync(outside, safe);
    }
    return originalSpawnSync(command, args, options);
  }) as typeof childProcess.spawnSync;
  Object.defineProperty(childProcess, "spawnSync", { configurable: true, value: swappedSpawnSync });
  try {
    assert.throws(() => mutateSetupConfiguration(target, () => ({ hooks: {} })), /directory changed/u);
  } finally {
    Object.defineProperty(childProcess, "spawnSync", { configurable: true, value: originalSpawnSync });
  }
  assert.equal(swapped, true);
  assert.deepEqual(fs.readFileSync(victim), original);
});

test("a lock swap after a path check cannot chmod the victim", { skip: process.platform === "win32" }, () => {
  const home = tempHome("agent-lcm-setup-lock-chmod-race-");
  const target = path.join(home, "hooks.json");
  const lock = `${target}.lock`;
  const victim = path.join(home, "victim.sqlite");
  fs.writeFileSync(lock, "");
  fs.writeFileSync(victim, "");
  fs.chmodSync(victim, 0o644);
  const preload = path.join(home, "swap-lock.cjs");
  fs.writeFileSync(preload, `const fs = require("node:fs");\nconst original = fs.lstatSync;\nfs.lstatSync = function(candidate, options) { const status = original(candidate, options); if (candidate === "hooks.json.lock") { fs.unlinkSync(candidate); fs.symlinkSync(${JSON.stringify(victim)}, candidate); } return status; };\n`);
  const originalNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require=${preload}`;
  try {
    assert.throws(() => mutateSetupConfiguration(target, () => ({ hooks: {} })), /not a directory/u);
  } finally {
    if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = originalNodeOptions;
  }
  assert.equal(fs.statSync(victim).mode & 0o777, 0o644);
});

test("a target swap after opening cannot copy symlink-victim bytes", { skip: process.platform === "win32" }, () => {
  const home = tempHome("agent-lcm-setup-target-race-");
  const target = path.join(home, "hooks.json");
  const victim = path.join(home, "victim.json");
  fs.writeFileSync(target, '{"hooks":{}}\n');
  fs.writeFileSync(victim, '{"isolated-secret":true}\n');
  const preload = path.join(home, "swap-target.cjs");
  fs.writeFileSync(preload, `const fs = require("node:fs");\nconst original = fs.openSync;\nfs.openSync = function(candidate, flags, mode) { const descriptor = original(candidate, flags, mode); if (candidate === "hooks.json") { fs.unlinkSync(candidate); fs.symlinkSync(${JSON.stringify(victim)}, candidate); } return descriptor; };\n`);
  const originalNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require=${preload}`;
  try {
    assert.throws(
      () => mutateSetupConfiguration(target, (configuration) => ({ ...configuration, added: true })),
      /path changed/u,
    );
  } finally {
    if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = originalNodeOptions;
  }
  const backups = fs.readdirSync(home).filter((name) => name.startsWith("hooks-pre-agent-lcm-"));
  assert.deepEqual(backups, []);
  assert.equal(fs.lstatSync(target).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(victim, "utf8")), { "isolated-secret": true });
});

test("invalid setup bytes remain unchanged without backup or temporary files", () => {
  // Given: an existing target contains invalid JSON bytes.
  const home = tempHome("agent-lcm-setup-invalid-");
  const target = path.join(home, "hooks.json");
  const original = Buffer.from("{not json\n");
  fs.writeFileSync(target, original);

  // When: a serialized mutation tries to read it.
  assert.throws(() => mutateSetupConfiguration(target, () => ({ hooks: {} })), /invalid setup configuration/u);

  // Then: the source bytes remain exact and no publication artifact exists.
  assert.deepEqual(fs.readFileSync(target), original);
  assert.deepEqual(setupArtifacts(home), []);
});

test("no-op setup mutations do not rewrite or back up the target", () => {
  // Given: a valid setup target with a fixed modification time.
  const home = tempHome("agent-lcm-setup-noop-");
  const target = path.join(home, "hooks.json");
  const original = Buffer.from('{"hooks":{}}\n');
  fs.writeFileSync(target, original);
  const fixed = new Date("2026-01-01T00:00:00.000Z");
  fs.utimesSync(target, fixed, fixed);

  // When: the transform returns an equivalent configuration.
  const changed = mutateSetupConfiguration(target, (configuration) => configuration ?? { hooks: {} });

  // Then: no write or backup occurs.
  assert.equal(changed, false);
  assert.deepEqual(fs.readFileSync(target), original);
  assert.equal(fs.statSync(target).mtimeMs, fixed.getTime());
  assert.deepEqual(setupArtifacts(home), []);
});

test("publication failure preserves the target, cleans temporary files, and keeps parent mode", { skip: process.platform === "win32" }, () => {
  // Given: an existing setup file in a deliberately non-private existing directory.
  const home = tempHome("agent-lcm-setup-publish-");
  const directory = path.join(home, "existing");
  const target = path.join(directory, "hooks.json");
  const original = Buffer.from('{"hooks":{}}\n');
  fs.mkdirSync(directory, { mode: 0o755 });
  fs.chmodSync(directory, 0o755);
  fs.writeFileSync(target, original);
  const preload = path.join(home, "fail-rename.cjs");
  fs.writeFileSync(preload, `const fs = require("node:fs");\nconst original = fs.renameSync;\nfs.renameSync = function(source, target) { if (String(source).endsWith(".tmp") && target === "hooks.json") throw new Error("injected publication failure"); return original(source, target); };\n`);
  const originalNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require=${preload}`;

  // When: atomic publication fails at rename.
  try {
    assert.throws(
      () => mutateSetupConfiguration(target, (configuration) => ({ ...configuration, added: true })),
      /injected publication failure/u,
    );
  } finally {
    if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = originalNodeOptions;
  }

  // Then: the old target survives, temporary files are gone, and the directory mode is unchanged.
  assert.deepEqual(fs.readFileSync(target), original);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")), []);
});

test("new setup directories and exact-byte backups use private modes", { skip: process.platform === "win32" }, () => {
  // Given: a missing setup directory and then a valid target with non-canonical bytes.
  const home = tempHome("agent-lcm-setup-modes-");
  const directory = path.join(home, "new", "hooks");
  const target = path.join(directory, "hooks.json");
  mutateSetupConfiguration(target, () => ({ hooks: {} }));
  const original = Buffer.from('{ "hooks": {}, "keep": true }\n');
  fs.writeFileSync(target, original);

  // When: a changed transform publishes a new configuration.
  mutateSetupConfiguration(target, (configuration) => ({ ...configuration, added: true }));

  // Then: the new directory is private and the backup retains exact bytes at a private mode.
  const backup = fs.readdirSync(directory).find((name) => name.startsWith("hooks-pre-agent-lcm-"));
  assert.notEqual(backup, undefined);
  if (backup === undefined) throw new Error("expected setup backup");
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(directory, backup)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readFileSync(path.join(directory, backup)), original);
});

test("serializes concurrent setup mutations", async () => {
  // Given: one child holds the target lock while a second child reaches the mutation boundary.
  const home = tempHome("agent-lcm-setup-concurrent-");
  const target = path.join(home, "hooks.json");
  fs.writeFileSync(target, '{"base":true}\n');
  const moduleUrl = new URL("../src/setup-files.ts", import.meta.url).href;
  const holder = spawn(process.execPath, ["--no-warnings", "--input-type=module", "--eval", `
    const fs = (await import("node:fs")).default;
    const { mutateSetupConfiguration } = await import(process.env.SETUP_FILES_URL);
    mutateSetupConfiguration(process.env.SETUP_TARGET, (configuration) => {
      process.stdout.write("locked\\n");
      fs.readSync(0, Buffer.alloc(1), 0, 1, null);
      return { ...configuration, holder: true };
    });
  `], {
    env: { ...process.env, SETUP_FILES_URL: moduleUrl, SETUP_TARGET: target },
    stdio: ["pipe", "pipe", "pipe"],
  });
  await once(holder.stdout, "data");
  const waiter = spawn(process.execPath, ["--no-warnings", "--input-type=module", "--eval", `
    const { mutateSetupConfiguration } = await import(process.env.SETUP_FILES_URL);
    process.stdout.write("waiting\\n");
    mutateSetupConfiguration(process.env.SETUP_TARGET, (configuration) => ({ ...configuration, waiter: true }));
  `], {
    env: { ...process.env, SETUP_FILES_URL: moduleUrl, SETUP_TARGET: target },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const holderErrors: Buffer[] = [];
  const waiterErrors: Buffer[] = [];
  holder.stderr.on("data", (chunk: Buffer) => holderErrors.push(chunk));
  waiter.stderr.on("data", (chunk: Buffer) => waiterErrors.push(chunk));
  await once(waiter.stdout, "data");

  // When: the holder releases after the waiter has started its mutation call.
  holder.stdin.end("x");
  const [holderExit, waiterExit] = await Promise.all([once(holder, "exit"), once(waiter, "exit")]);

  // Then: both transforms survive and neither process leaves a temporary file.
  assert.equal(holderExit[0], 0, Buffer.concat(holderErrors).toString() || "holder failed");
  assert.equal(waiterExit[0], 0, Buffer.concat(waiterErrors).toString() || "waiter failed");
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { base: true, holder: true, waiter: true });
  assert.deepEqual(fs.readdirSync(home).filter((name) => name.endsWith(".tmp")), []);
});

function setupArtifacts(directory: string): string[] {
  return fs.readdirSync(directory).filter((name) => name.includes("pre-agent-lcm") || name.endsWith(".tmp"));
}
