import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  transform: (configuration: Record<string, unknown> | undefined) => Record<string, unknown>,
): boolean {
  ensureSetupDirectory(path.dirname(target));
  return withSetupFileLock(target, () => {
    const current = readSetupFile(target);
    const existing = current ? parseSetupConfiguration(current, target) : undefined;
    const next = transform(existing);
    if (existing && JSON.stringify(existing) === JSON.stringify(next)) return false;
    if (current) backupSetupBytes(target, current);
    writeSetupBytes(target, Buffer.from(`${JSON.stringify(next, null, 2)}\n`));
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

export function writeSetupConfiguration(target: string, configuration: Record<string, unknown>): void {
  ensureSetupDirectory(path.dirname(target));
  writeSetupBytes(target, Buffer.from(`${JSON.stringify(configuration, null, 2)}\n`));
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

export function backupSetupConfiguration(target: string): void {
  backupSetupBytes(target, fs.readFileSync(target));
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

function withSetupFileLock<T>(target: string, callback: () => T): T {
  const lockPath = `${target}.lock.sqlite`;
  const deadline = Date.now() + SETUP_LOCK_TIMEOUT_MS;
  const coordinator = new DatabaseSync(lockPath, { timeout: SETUP_LOCK_POLL_MS });
  let transactionOpen = false;
  try {
    fs.chmodSync(lockPath, 0o600);
    while (!transactionOpen) {
      try {
        coordinator.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        if (Date.now() >= deadline) throw new SetupFileLockTimeoutError(lockPath);
        Atomics.wait(SETUP_LOCK_WAIT, 0, 0, SETUP_LOCK_POLL_MS);
      }
    }
    return callback();
  } finally {
    if (transactionOpen) coordinator.exec("ROLLBACK");
    coordinator.close();
  }
}

function readSetupFile(target: string): Buffer | undefined {
  let status: fs.Stats;
  try {
    status = fs.lstatSync(target);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  if (status.isSymbolicLink()) throw new Error(`Refusing setup configuration symlink: ${target}`);
  if (!status.isFile()) throw new Error(`Cannot update setup configuration that is not a regular file: ${target}`);
  return fs.readFileSync(target);
}

function ensureSetupDirectory(directory: string): void {
  const created = fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (created !== undefined) fs.chmodSync(directory, 0o700);
}

function fsyncPath(target: string): void {
  const descriptor = fs.openSync(target, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "errcode") === 5;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && Reflect.get(error, "code") === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
