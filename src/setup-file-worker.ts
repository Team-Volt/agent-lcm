import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BUSY_EXIT = 75;
const MISSING_EXIT = 66;

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function main(): number {
  const operation = requiredArgument(2);
  const name = requiredArgument(3);
  const expectedDevice = requiredArgument(4);
  const expectedInode = requiredArgument(5);
  if (path.basename(name) !== name || name === "." || name === "..") throw new Error("Invalid setup file name.");
  assertDirectoryIdentity(expectedDevice, expectedInode);

  switch (operation) {
    case "lock": return acquireLock(name);
    case "unlock": fs.rmdirSync(`${name}.lock`); return 0;
    case "read": return writeCurrentFile(name);
    case "write": writeChangedFile(name, requiredArgument(6), requiredArgument(7), fs.readFileSync(0)); return 0;
    default: throw new Error(`Unknown setup file operation: ${operation}`);
  }
}

function acquireLock(name: string): number {
  const lock = `${name}.lock`;
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
    return 0;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
  }
  let status: fs.Stats;
  try {
    status = fs.lstatSync(lock);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return BUSY_EXIT;
    throw error;
  }
  if (status.isSymbolicLink()) throw new Error(`Refusing setup lock symlink: ${path.resolve(lock)}`);
  if (!status.isDirectory()) throw new Error(`Cannot use setup lock that is not a directory: ${path.resolve(lock)}`);
  return BUSY_EXIT;
}

function writeCurrentFile(name: string): number {
  const bytes = readAnchoredFile(name);
  if (bytes === undefined) return MISSING_EXIT;
  process.stdout.write(bytes);
  return 0;
}

function writeChangedFile(name: string, expectedHash: string, timestamp: string, next: Buffer): void {
  const current = readAnchoredFile(name);
  const actualHash = current === undefined ? "missing" : hash(current);
  if (actualHash !== expectedHash) throw new Error(`Setup configuration changed while updating: ${path.resolve(name)}`);
  if (current !== undefined) backupAnchoredFile(name, current, timestamp);
  writeAnchoredFile(name, next);
}

function readAnchoredFile(name: string): Buffer | undefined {
  let pathStatus: fs.Stats;
  try {
    pathStatus = fs.lstatSync(name);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
  if (pathStatus.isSymbolicLink()) throw new Error(`Refusing setup configuration symlink: ${path.resolve(name)}`);
  if (!pathStatus.isFile()) throw new Error(`Cannot update setup configuration that is not a regular file: ${path.resolve(name)}`);
  let descriptor: number;
  try {
    descriptor = fs.openSync(name, fs.constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (hasCode(error, "ELOOP")) throw new Error(`Refusing setup configuration symlink: ${path.resolve(name)}`);
    throw error;
  }
  try {
    const opened = fs.fstatSync(descriptor);
    const current = fs.lstatSync(name);
    if (!opened.isFile() || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error(`Setup configuration path changed while opening: ${path.resolve(name)}`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writeAnchoredFile(name: string, bytes: Buffer): void {
  const temporary = `${name}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, name);
    if (process.platform !== "win32") fsyncDirectory();
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

function backupAnchoredFile(name: string, bytes: Buffer, timestampValue: string): void {
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  const timestamp = timestampValue.replace(/[:.]/gu, "-");
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

function assertDirectoryIdentity(expectedDevice: string, expectedInode: string): void {
  const actual = fs.statSync(".");
  if (!actual.isDirectory() || String(actual.dev) !== expectedDevice || String(actual.ino) !== expectedInode) {
    throw new Error(`Setup directory changed while updating: ${process.cwd()}`);
  }
}

function fsyncDirectory(): void {
  const descriptor = fs.openSync(".", "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function noFollowFlag(): number {
  return process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
}

function requiredArgument(index: number): string {
  const value = process.argv[index];
  if (value === undefined) throw new Error("Missing setup file worker argument.");
  return value;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && Reflect.get(error, "code") === code;
}
