import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
export function ipcAddress(config) {
    if (process.platform !== "win32") {
        if (Buffer.byteLength(config.socketPath, "utf8") <= MAX_UNIX_SOCKET_PATH_BYTES)
            return config.socketPath;
        return path.join(unixSocketDirectory(), `${homeHash(config.home)}.sock`);
    }
    return `\\\\.\\pipe\\agent-lcm-${homeHash(config.home)}`;
}
export function prepareIpcAddress(address) {
    if (process.platform === "win32")
        return;
    const directory = path.dirname(address);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
}
const MAX_UNIX_SOCKET_PATH_BYTES = 100;
function unixSocketDirectory() {
    const uid = typeof process.getuid === "function" ? process.getuid() : "user";
    const name = `agent-lcm-${uid}`;
    const temporaryDirectory = path.join(os.tmpdir(), name);
    const candidate = path.join(temporaryDirectory, "0000000000000000.sock");
    if (Buffer.byteLength(candidate, "utf8") <= MAX_UNIX_SOCKET_PATH_BYTES)
        return temporaryDirectory;
    return path.join("/tmp", name);
}
function homeHash(home) {
    return crypto.createHash("sha256").update(home).digest("hex").slice(0, 16);
}
export function readOrCreateToken(config) {
    fs.mkdirSync(config.runtimeDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(config.runtimeDir, 0o700);
    const temporaryPath = `${config.tokenPath}.${crypto.randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    try {
        try {
            fs.writeFileSync(descriptor, `${crypto.randomBytes(32).toString("hex")}\n`);
            fs.fsyncSync(descriptor);
        }
        finally {
            fs.closeSync(descriptor);
        }
        try {
            fs.linkSync(temporaryPath, config.tokenPath);
            fsyncDirectory(config.runtimeDir);
        }
        catch (error) {
            if (!hasCode(error, "EEXIST"))
                throw error;
        }
    }
    finally {
        try {
            fs.unlinkSync(temporaryPath);
        }
        catch (error) {
            if (!hasCode(error, "ENOENT"))
                throw error;
        }
    }
    fs.chmodSync(config.tokenPath, 0o600);
    const token = fs.readFileSync(config.tokenPath, "utf8").trim();
    if (!/^[0-9a-f]{64}$/u.test(token))
        throw new Error("agent-lcm daemon token is invalid.");
    return token;
}
export function readToken(config) {
    try {
        const token = fs.readFileSync(config.tokenPath, "utf8").trim();
        return /^[0-9a-f]{64}$/u.test(token) ? token : undefined;
    }
    catch (error) {
        if (hasCode(error, "ENOENT"))
            return undefined;
        throw error;
    }
}
export function tokenMatches(actual, expected) {
    const actualBytes = Buffer.from(actual, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}
export function sendDaemonRequest(address, request, timeoutMs = 1_000, responseTimeoutMs = timeoutMs) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(address);
        let buffer = "";
        let timeout = setTimeout(onTimeout, timeoutMs);
        function onTimeout() {
            socket.destroy();
            reject(new Error("agent-lcm daemon request timed out."));
        }
        socket.setEncoding("utf8");
        socket.once("error", finishReject);
        socket.on("data", (chunk) => {
            buffer += chunk;
            const newline = buffer.indexOf("\n");
            if (newline === -1)
                return;
            try {
                finishResolve(JSON.parse(buffer.slice(0, newline)));
            }
            catch (error) {
                finishReject(error);
            }
        });
        socket.once("connect", () => {
            clearTimeout(timeout);
            timeout = setTimeout(onTimeout, responseTimeoutMs);
            socket.write(`${JSON.stringify(request)}\n`);
        });
        function finishResolve(response) {
            clearTimeout(timeout);
            socket.end();
            resolve(response);
        }
        function finishReject(error) {
            clearTimeout(timeout);
            socket.destroy();
            reject(error);
        }
    });
}
export function hasCode(error, code) {
    return error instanceof Error && Reflect.get(error, "code") === code;
}
function fsyncDirectory(directory) {
    if (process.platform === "win32")
        return;
    const descriptor = fs.openSync(directory, "r");
    try {
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
