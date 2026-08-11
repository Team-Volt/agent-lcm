import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
  const victim = path.join(home, "victim.sqlite");
  fs.writeFileSync(victim, "");
  fs.chmodSync(victim, 0o644);
  fs.symlinkSync(victim, `${target}.lock.sqlite`);

  assert.throws(() => mutateSetupConfiguration(target, () => ({ hooks: {} })), /lock.*symlink/u);

  assert.equal(fs.lstatSync(`${target}.lock.sqlite`).isSymbolicLink(), true);
  assert.equal(fs.statSync(victim).mode & 0o777, 0o644);
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

test("a lock-path swap cannot change a symlink victim", { skip: process.platform === "win32" }, () => {
  const home = tempHome("agent-lcm-setup-lock-race-");
  const target = path.join(home, "hooks.json");
  const lock = `${target}.lock.sqlite`;
  const victim = path.join(home, "victim.sqlite");
  fs.writeFileSync(lock, "");
  fs.writeFileSync(victim, "");
  fs.chmodSync(victim, 0o644);
  const originalOpen = fs.openSync;
  let lockOpens = 0;
  const swappedOpen = ((candidate: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
    if (candidate.toString() === lock && (lockOpens += 1) === 2) {
      fs.unlinkSync(lock);
      fs.symlinkSync(victim, lock);
    }
    return originalOpen(candidate, flags, mode);
  }) as typeof fs.openSync;
  Object.defineProperty(fs, "openSync", { configurable: true, value: swappedOpen });
  try {
    assert.throws(() => mutateSetupConfiguration(target, () => ({ hooks: {} })), /lock (?:path changed|symlink)/u);
  } finally {
    Object.defineProperty(fs, "openSync", { configurable: true, value: originalOpen });
  }
  assert.equal(fs.statSync(victim).mode & 0o777, 0o644);
});

test("a lock swap after a path check cannot chmod the victim", { skip: process.platform === "win32" }, () => {
  const home = tempHome("agent-lcm-setup-lock-chmod-race-");
  const target = path.join(home, "hooks.json");
  const lock = `${target}.lock.sqlite`;
  const victim = path.join(home, "victim.sqlite");
  fs.writeFileSync(lock, "");
  fs.writeFileSync(victim, "");
  fs.chmodSync(victim, 0o644);
  const originalLstat = fs.lstatSync;
  let swapped = false;
  const swappedLstat = ((candidate: fs.PathLike) => {
    const status = originalLstat(candidate);
    if (!swapped && candidate.toString() === lock) {
      swapped = true;
      fs.unlinkSync(lock);
      fs.symlinkSync(victim, lock);
    }
    return status;
  }) as typeof fs.lstatSync;
  Object.defineProperty(fs, "lstatSync", { configurable: true, value: swappedLstat });
  try {
    mutateSetupConfiguration(target, () => ({ hooks: {} }));
  } finally {
    Object.defineProperty(fs, "lstatSync", { configurable: true, value: originalLstat });
  }
  assert.equal(fs.statSync(victim).mode & 0o777, 0o644);
});

test("a target-path swap cannot copy symlink-victim bytes", { skip: process.platform === "win32" }, () => {
  const home = tempHome("agent-lcm-setup-target-race-");
  const target = path.join(home, "hooks.json");
  const victim = path.join(home, "victim.json");
  fs.writeFileSync(target, '{"hooks":{}}\n');
  fs.writeFileSync(victim, '{"isolated-secret":true}\n');
  const originalRead = fs.readFileSync;
  let swapped = false;
  const swappedRead = ((candidate: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    if (!swapped && typeof candidate === "string" && candidate === target) {
      swapped = true;
      fs.unlinkSync(target);
      fs.symlinkSync(victim, target);
    }
    return Reflect.apply(originalRead, fs, [candidate, ...args]);
  }) as typeof fs.readFileSync;
  Object.defineProperty(fs, "readFileSync", { configurable: true, value: swappedRead });
  try {
    mutateSetupConfiguration(target, (configuration) => ({ ...configuration, added: true }));
  } finally {
    Object.defineProperty(fs, "readFileSync", { configurable: true, value: originalRead });
  }
  const backups = fs.readdirSync(home).filter((name) => name.startsWith("hooks-pre-agent-lcm-"));
  assert.equal(backups.length, 1);
  assert.doesNotMatch(fs.readFileSync(path.join(home, backups[0] ?? ""), "utf8"), /isolated-secret/u);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { hooks: {}, added: true });
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
  const originalRename = fs.renameSync;
  fs.renameSync = () => {
    throw new Error("injected publication failure");
  };

  // When: atomic publication fails at rename.
  try {
    assert.throws(
      () => mutateSetupConfiguration(target, (configuration) => ({ ...configuration, added: true })),
      /injected publication failure/u,
    );
  } finally {
    fs.renameSync = originalRename;
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
  await once(waiter.stdout, "data");

  // When: the holder releases after the waiter has started its mutation call.
  holder.stdin.end("x");
  const [holderExit, waiterExit] = await Promise.all([once(holder, "exit"), once(waiter, "exit")]);

  // Then: both transforms survive and neither process leaves a temporary file.
  assert.equal(holderExit[0], 0);
  assert.equal(waiterExit[0], 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, "utf8")), { base: true, holder: true, waiter: true });
  assert.deepEqual(fs.readdirSync(home).filter((name) => name.endsWith(".tmp")), []);
});

function setupArtifacts(directory: string): string[] {
  return fs.readdirSync(directory).filter((name) => name.includes("pre-agent-lcm") || name.endsWith(".tmp"));
}
