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
const SETUP_FILE_WORKER = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "./setup-file-worker.ts" : "./setup-file-worker.js", import.meta.url));
export class SetupFileLockTimeoutError extends Error {
    lockPath;
    constructor(lockPath) {
        super(`agent-lcm: setup file lock timeout: ${lockPath}`);
        this.name = "SetupFileLockTimeoutError";
        this.lockPath = lockPath;
    }
}
export class SetupConfigurationChangedError extends Error {
    target;
    constructor(target) {
        super(`Setup configuration changed after preflight: ${target}`);
        this.name = "SetupConfigurationChangedError";
        this.target = target;
    }
}
/**
 * Publish a non-JSON setup file using the same directory-anchored lock,
 * backup, and atomic publication as JSON setup configuration.
 */
export function mutateSetupFile(target, transform, expectedHash, backupExtension) {
    const directory = path.dirname(target);
    ensureSetupDirectory(directory);
    const directoryIdentity = fs.lstatSync(directory);
    if (!directoryIdentity.isDirectory())
        throw new Error(`Setup directory changed while updating: ${directory}`);
    return withSetupFileLock(target, directoryIdentity, () => {
        const current = readAnchoredSetupFile(target, directoryIdentity);
        if (expectedHash !== undefined && setupFileHash(current) !== expectedHash) {
            throw new SetupConfigurationChangedError(target);
        }
        const next = transform(current);
        if (next === undefined || (current !== undefined && current.equals(next)))
            return false;
        writeAnchoredSetupFile(target, directoryIdentity, current === undefined ? "missing" : setupFileHash(current), next, backupExtension);
        return true;
    });
}
export function mutateSetupConfiguration(target, transform, expectedHash) {
    const directory = path.dirname(target);
    ensureSetupDirectory(directory);
    const directoryIdentity = fs.lstatSync(directory);
    if (!directoryIdentity.isDirectory())
        throw new Error(`Setup directory changed while updating: ${directory}`);
    return withSetupFileLock(target, directoryIdentity, () => {
        const current = readAnchoredSetupFile(target, directoryIdentity);
        if (expectedHash !== undefined && setupConfigurationHash(current) !== expectedHash) {
            throw new SetupConfigurationChangedError(target);
        }
        const existing = current ? parseSetupConfiguration(current, target) : undefined;
        const next = transform(existing);
        if (next === undefined)
            return false;
        if (existing && JSON.stringify(existing) === JSON.stringify(next))
            return false;
        writeAnchoredSetupFile(target, directoryIdentity, current === undefined ? "missing" : createHash("sha256").update(current).digest("hex"), Buffer.from(`${JSON.stringify(next, null, 2)}\n`));
        return true;
    });
}
export function readSetupConfiguration(target) {
    return readSetupConfigurationSnapshot(target).configuration;
}
export function readSetupConfigurationSnapshot(target) {
    const bytes = readSetupFileBytes(target);
    return {
        configuration: bytes ? parseSetupConfiguration(bytes, target) : undefined,
        hash: setupConfigurationHash(bytes),
    };
}
function setupConfigurationHash(bytes) {
    return setupFileHash(bytes);
}
function setupFileHash(bytes) {
    return bytes === undefined ? "missing" : createHash("sha256").update(bytes).digest("hex");
}
function parseSetupConfiguration(bytes, target) {
    let value;
    try {
        value = JSON.parse(bytes.toString("utf8"));
    }
    catch {
        throw new Error(`Cannot update invalid setup configuration: ${target}`);
    }
    if (!isRecord(value))
        throw new Error(`Cannot update invalid setup configuration: ${target}`);
    return value;
}
function withSetupFileLock(target, directoryIdentity, callback) {
    const lockPath = `${target}.lock`;
    const deadline = Date.now() + SETUP_LOCK_TIMEOUT_MS;
    let acquired = false;
    let failed = false;
    // ponytail: a crashed setup leaves this empty directory; recover it manually
    // rather than guessing whether another setup process is still alive.
    try {
        while (!acquired) {
            const result = runSetupFileWorker("lock", target, directoryIdentity);
            if (result.status === 0)
                acquired = true;
            else if (result.status !== WORKER_BUSY_EXIT)
                throw setupFileWorkerError(result);
            else if (Date.now() >= deadline)
                throw new SetupFileLockTimeoutError(lockPath);
            else
                Atomics.wait(SETUP_LOCK_WAIT, 0, 0, SETUP_LOCK_POLL_MS);
        }
        return callback();
    }
    catch (error) {
        failed = true;
        throw error;
    }
    finally {
        if (acquired) {
            const result = runSetupFileWorker("unlock", target, directoryIdentity);
            if (!failed && result.status !== 0)
                throw setupFileWorkerError(result);
        }
    }
}
function readAnchoredSetupFile(target, directoryIdentity) {
    const result = runSetupFileWorker("read", target, directoryIdentity);
    if (result.status === WORKER_MISSING_EXIT)
        return undefined;
    if (result.status !== 0)
        throw setupFileWorkerError(result);
    return result.stdout;
}
function writeAnchoredSetupFile(target, directoryIdentity, expectedHash, bytes, backupExtension) {
    const result = runSetupFileWorker("write", target, directoryIdentity, [expectedHash, new Date().toISOString(), backupExtension ?? ""], bytes);
    if (result.status !== 0)
        throw setupFileWorkerError(result);
}
function runSetupFileWorker(operation, target, directoryIdentity, extraArguments = [], input) {
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
    if (result.error !== undefined)
        throw result.error;
    return result;
}
function setupFileWorkerError(result) {
    const message = result.stderr.toString("utf8").trim();
    return new Error(message || `Setup file worker failed with status ${String(result.status)}.`);
}
export function readSetupFileBytes(target) {
    let pathStatus;
    try {
        pathStatus = fs.lstatSync(target);
    }
    catch (error) {
        if (hasCode(error, "ENOENT"))
            return undefined;
        throw error;
    }
    if (pathStatus.isSymbolicLink())
        throw new Error(`Refusing setup configuration symlink: ${target}`);
    if (!pathStatus.isFile())
        throw new Error(`Cannot update setup configuration that is not a regular file: ${target}`);
    let descriptor;
    try {
        descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollowFlag());
    }
    catch (error) {
        if (hasCode(error, "ELOOP"))
            throw new Error(`Refusing setup configuration symlink: ${target}`);
        throw error;
    }
    try {
        const opened = fs.fstatSync(descriptor);
        const current = fs.lstatSync(target);
        if (!opened.isFile() || current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino) {
            throw new Error(`Setup configuration path changed while opening: ${target}`);
        }
        return fs.readFileSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
export function ensureSetupDirectory(directory) {
    assertSafeDirectoryPath(directory);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertSafeDirectoryPath(directory);
}
function noFollowFlag() {
    return process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW;
}
function assertSafeDirectoryPath(directory) {
    const resolved = path.resolve(directory);
    const root = path.parse(resolved).root;
    let current = root;
    for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        let status;
        try {
            status = fs.lstatSync(current);
        }
        catch (error) {
            if (hasCode(error, "ENOENT"))
                continue;
            throw error;
        }
        if (status.isSymbolicLink()) {
            if (isDarwinSystemAlias(current))
                continue;
            throw new Error(`Refusing setup directory symlink: ${current}`);
        }
        if (!status.isDirectory())
            throw new Error(`Cannot use setup path through a non-directory: ${current}`);
    }
}
function isDarwinSystemAlias(target) {
    return process.platform === "darwin" && (target === "/etc" || target === "/tmp" || target === "/var");
}
function hasCode(error, code) {
    return error instanceof Error && Reflect.get(error, "code") === code;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
