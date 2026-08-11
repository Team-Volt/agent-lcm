import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SETUP_LOCK_TIMEOUT_MS = 10_000;
const SETUP_LOCK_POLL_MS = 10;
const SETUP_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export class SetupFileLockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`agent-lcm: setup file lock timeout: ${lockPath}`);
    this.name = "SetupFileLockTimeoutError";
    this.lockPath = lockPath;
  }
}

export function mutateSetupConfiguration(
  target: string,
  transform: (configuration: Record<string, unknown> | undefined) => Record<string, unknown> | undefined,
): boolean {
  const directory = path.dirname(target);
  ensureSetupDirectory(directory);
  const directoryIdentity = fs.lstatSync(directory);
  if (!directoryIdentity.isDirectory()) throw new Error(`Setup directory changed while updating: ${directory}`);
  return withSetupFileLock(target, directoryIdentity, () => {
    assertDirectoryIdentity(directory, directoryIdentity);
    const current = readSetupFile(target);
    const existing = current ? parseSetupConfiguration(current, target) : undefined;
    const next = transform(existing);
    if (next === undefined) return false;
    if (existing && JSON.stringify(existing) === JSON.stringify(next)) return false;
    assertDirectoryIdentity(directory, directoryIdentity);
    if (current) backupSetupBytes(target, current);
    assertDirectoryIdentity(directory, directoryIdentity);
    writeSetupBytes(target, Buffer.from(`${JSON.stringify(next, null, 2)}\n`));
    assertDirectoryIdentity(directory, directoryIdentity);
    return true;
  });
}

export function readSetupConfiguration(target: string): Record<string, unknown> | undefined {
  const bytes = readSetupFile(target);
  if (!bytes) return undefined;
  return parseSetupConfiguration(bytes, target);
}

function parseSetupConfiguration(bytes: Buffer, target: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`Cannot update invalid setup configuration: ${target}`);
  }
  if (!isRecord(value)) throw new Error(`Cannot update invalid setup configuration: ${target}`);
  return value;
}

function writeSetupBytes(target: string, bytes: Buffer): void {
  const temporary = `${target}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
    if (process.platform !== "win32") fsyncPath(path.dirname(target));
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if (!hasCode(cleanupError, "ENOENT")) throw new AggregateError([error, cleanupError], "Setup publication and cleanup failed.");
    }
    throw error;
  }
}

function backupSetupBytes(target: string, bytes: Buffer): void {
  const extension = path.extname(target);
  const stem = extension ? target.slice(0, -extension.length) : target;
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
  for (let suffix = 0; ; suffix += 1) {
    const candidate = `${stem}-pre-agent-lcm-${timestamp}${suffix ? `-${suffix}` : ""}${extension}`;
    let descriptor: number;
    try {
      descriptor = fs.openSync(candidate, "wx", 0o600);
    } catch (error) {
      if (hasCode(error, "EEXIST")) continue;
      throw error;
    }
    try {
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      return;
    } catch (error) {
      fs.closeSync(descriptor);
      try {
        fs.unlinkSync(candidate);
      } catch (cleanupError) {
        if (!hasCode(cleanupError, "ENOENT")) throw new AggregateError([error, cleanupError], "Setup backup and cleanup failed.");
      }
      throw error;
    }
  }
}

function withSetupFileLock<T>(target: string, directoryIdentity: fs.Stats, callback: () => T): T {
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + SETUP_LOCK_TIMEOUT_MS;
  let acquired = false;
  // ponytail: a crashed setup leaves this empty directory; recover it manually
  // rather than guessing whether another setup process is still alive.
  try {
    while (!acquired) {
      assertDirectoryIdentity(path.dirname(target), directoryIdentity);
      try {
        fs.mkdirSync(lockPath, { mode: 0o700 });
        acquired = true;
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        const status = fs.lstatSync(lockPath);
        if (status.isSymbolicLink()) throw new Error(`Refusing setup lock symlink: ${lockPath}`);
        if (!status.isDirectory()) throw new Error(`Cannot use setup lock that is not a directory: ${lockPath}`);
        if (Date.now() >= deadline) throw new SetupFileLockTimeoutError(lockPath);
        Atomics.wait(SETUP_LOCK_WAIT, 0, 0, SETUP_LOCK_POLL_MS);
      }
    }
    assertDirectoryIdentity(path.dirname(target), directoryIdentity);
    return callback();
  } finally {
    if (acquired) fs.rmdirSync(lockPath);
  }
}

function readSetupFile(target: string): Buffer | undefined {
  let pathStatus: fs.Stats;
  try {
    pathStatus = fs.lstatSync(target);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  if (pathStatus.isSymbolicLink()) throw new Error(`Refusing setup configuration symlink: ${target}`);
  if (!pathStatus.isFile()) throw new Error(`Cannot update setup configuration that is not a regular file: ${target}`);
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (hasCode(error, "ELOOP")) throw new Error(`Refusing setup configuration symlink: ${target}`);
    throw error;
  }
  try {
    const opened = fs.fstatSync(descriptor);
    const current = fs.lstatSync(target);
    if (!opened.isFile() || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error(`Setup configuration path changed while opening: ${target}`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function ensureSetupDirectory(directory: string): void {
  assertSafeDirectoryPath(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSafeDirectoryPath(directory);
}

function noFollowFlag(): number {
  return process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
}

function assertDirectoryIdentity(directory: string, expected: fs.Stats): void {
  const actual = fs.lstatSync(directory);
  if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new Error(`Setup directory changed while updating: ${directory}`);
  }
}

function assertSafeDirectoryPath(directory: string): void {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  let current = root;
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let status: fs.Stats;
    try {
      status = fs.lstatSync(current);
    } catch (error) {
      if (hasCode(error, "ENOENT")) continue;
      throw error;
    }
    if (status.isSymbolicLink()) {
      if (isDarwinSystemAlias(current)) continue;
      throw new Error(`Refusing setup directory symlink: ${current}`);
    }
    if (!status.isDirectory()) throw new Error(`Cannot use setup path through a non-directory: ${current}`);
  }
}

function isDarwinSystemAlias(target: string): boolean {
  return process.platform === "darwin" && (target === "/etc" || target === "/tmp" || target === "/var");
}

function fsyncPath(target: string): void {
  const descriptor = fs.openSync(target, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && Reflect.get(error, "code") === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
