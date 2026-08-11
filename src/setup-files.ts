import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SETUP_LOCK_TIMEOUT_MS = 10_000;
const SETUP_LOCK_POLL_MS = 10;
const SETUP_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const WORKER_BUSY_EXIT = 75;
const WORKER_MISSING_EXIT = 66;
const SETUP_FILE_WORKER = fileURLToPath(new URL(
  import.meta.url.endsWith(".ts") ? "./setup-file-worker.ts" : "./setup-file-worker.js",
  import.meta.url,
));

export class SetupFileLockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`agent-lcm: setup file lock timeout: ${lockPath}`);
    this.name = "SetupFileLockTimeoutError";
    this.lockPath = lockPath;
  }
}

export class SetupConfigurationChangedError extends Error {
  readonly target: string;

  constructor(target: string) {
    super(`Setup configuration changed after preflight: ${target}`);
    this.name = "SetupConfigurationChangedError";
    this.target = target;
  }
}

export type SetupConfigurationSnapshot = {
  readonly configuration: Record<string, unknown> | undefined;
  readonly hash: string;
};

export function mutateSetupConfiguration(
  target: string,
  transform: (configuration: Record<string, unknown> | undefined) => Record<string, unknown> | undefined,
  expectedHash?: string,
): boolean {
  const directory = path.dirname(target);
  ensureSetupDirectory(directory);
  const directoryIdentity = fs.lstatSync(directory);
  if (!directoryIdentity.isDirectory()) throw new Error(`Setup directory changed while updating: ${directory}`);
  return withSetupFileLock(target, directoryIdentity, () => {
    const current = readAnchoredSetupFile(target, directoryIdentity);
    if (expectedHash !== undefined && setupConfigurationHash(current) !== expectedHash) {
      throw new SetupConfigurationChangedError(target);
    }
    const existing = current ? parseSetupConfiguration(current, target) : undefined;
    const next = transform(existing);
    if (next === undefined) return false;
    if (existing && JSON.stringify(existing) === JSON.stringify(next)) return false;
    writeAnchoredSetupFile(
      target,
      directoryIdentity,
      current === undefined ? "missing" : createHash("sha256").update(current).digest("hex"),
      Buffer.from(`${JSON.stringify(next, null, 2)}\n`),
    );
    return true;
  });
}

export function readSetupConfiguration(target: string): Record<string, unknown> | undefined {
  return readSetupConfigurationSnapshot(target).configuration;
}

export function readSetupConfigurationSnapshot(target: string): SetupConfigurationSnapshot {
  const bytes = readSetupFile(target);
  return {
    configuration: bytes ? parseSetupConfiguration(bytes, target) : undefined,
    hash: setupConfigurationHash(bytes),
  };
}

function setupConfigurationHash(bytes: Buffer | undefined): string {
  return bytes === undefined ? "missing" : createHash("sha256").update(bytes).digest("hex");
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

function withSetupFileLock<T>(target: string, directoryIdentity: fs.Stats, callback: () => T): T {
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + SETUP_LOCK_TIMEOUT_MS;
  let acquired = false;
  let failed = false;
  // ponytail: a crashed setup leaves this empty directory; recover it manually
  // rather than guessing whether another setup process is still alive.
  try {
    while (!acquired) {
      const result = runSetupFileWorker("lock", target, directoryIdentity);
      if (result.status === 0) acquired = true;
      else if (result.status !== WORKER_BUSY_EXIT) throw setupFileWorkerError(result);
      else if (Date.now() >= deadline) throw new SetupFileLockTimeoutError(lockPath);
      else Atomics.wait(SETUP_LOCK_WAIT, 0, 0, SETUP_LOCK_POLL_MS);
    }
    return callback();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    if (acquired) {
      const result = runSetupFileWorker("unlock", target, directoryIdentity);
      if (!failed && result.status !== 0) throw setupFileWorkerError(result);
    }
  }
}

function readAnchoredSetupFile(target: string, directoryIdentity: fs.Stats): Buffer | undefined {
  const result = runSetupFileWorker("read", target, directoryIdentity);
  if (result.status === WORKER_MISSING_EXIT) return undefined;
  if (result.status !== 0) throw setupFileWorkerError(result);
  return result.stdout;
}

function writeAnchoredSetupFile(target: string, directoryIdentity: fs.Stats, expectedHash: string, bytes: Buffer): void {
  const result = runSetupFileWorker("write", target, directoryIdentity, [expectedHash, new Date().toISOString()], bytes);
  if (result.status !== 0) throw setupFileWorkerError(result);
}

function runSetupFileWorker(
  operation: "lock" | "unlock" | "read" | "write",
  target: string,
  directoryIdentity: fs.Stats,
  extraArguments: readonly string[] = [],
  input?: Buffer,
): childProcess.SpawnSyncReturns<Buffer> {
  const result = childProcess.spawnSync(process.execPath, [
    "--no-warnings",
    SETUP_FILE_WORKER,
    operation,
    path.basename(target),
    String(directoryIdentity.dev),
    String(directoryIdentity.ino),
    ...extraArguments,
  ], {
    cwd: path.dirname(target),
    input,
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error !== undefined) throw result.error;
  return result;
}

function setupFileWorkerError(result: childProcess.SpawnSyncReturns<Buffer>): Error {
  const message = result.stderr.toString("utf8").trim();
  return new Error(message || `Setup file worker failed with status ${String(result.status)}.`);
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

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && Reflect.get(error, "code") === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
