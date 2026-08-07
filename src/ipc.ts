import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { LcmConfig } from "./config.ts";

export type DaemonRequest = {
  version: 1;
  token: string;
  id: string;
  method: "health" | "tool" | "cli" | "drain" | "shutdown" | "replace";
  params: Record<string, unknown>;
};

export type DaemonResponse =
  | { version: 1; id: string; ok: true; result: unknown }
  | { version: 1; id: string; ok: false; error: string };

export function ipcAddress(config: LcmConfig): string {
  if (process.platform !== "win32") {
    if (Buffer.byteLength(config.socketPath, "utf8") <= MAX_UNIX_SOCKET_PATH_BYTES) return config.socketPath;
    return path.join(unixSocketDirectory(), `${homeHash(config.home)}.sock`);
  }
  return `\\\\.\\pipe\\agent-lcm-${homeHash(config.home)}`;
}

export function prepareIpcAddress(address: string): void {
  if (process.platform === "win32") return;
  const directory = path.dirname(address);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}

const MAX_UNIX_SOCKET_PATH_BYTES = 100;

function unixSocketDirectory(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const name = `agent-lcm-${uid}`;
  const temporaryDirectory = path.join(os.tmpdir(), name);
  const candidate = path.join(temporaryDirectory, "0000000000000000.sock");
  if (Buffer.byteLength(candidate, "utf8") <= MAX_UNIX_SOCKET_PATH_BYTES) return temporaryDirectory;
  return path.join("/tmp", name);
}

function homeHash(home: string): string {
  return crypto.createHash("sha256").update(home).digest("hex").slice(0, 16);
}

export function readOrCreateToken(config: LcmConfig): string {
  fs.mkdirSync(config.runtimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(config.runtimeDir, 0o700);
  const temporaryPath = `${config.tokenPath}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
  try {
    try {
      fs.writeFileSync(descriptor, `${crypto.randomBytes(32).toString("hex")}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      fs.linkSync(temporaryPath, config.tokenPath);
      fsyncDirectory(config.runtimeDir);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
    }
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
  fs.chmodSync(config.tokenPath, 0o600);
  const token = fs.readFileSync(config.tokenPath, "utf8").trim();
  if (!/^[0-9a-f]{64}$/u.test(token)) throw new Error("agent-lcm daemon token is invalid.");
  return token;
}

export function readToken(config: LcmConfig): string | undefined {
  try {
    const token = fs.readFileSync(config.tokenPath, "utf8").trim();
    return /^[0-9a-f]{64}$/u.test(token) ? token : undefined;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

export function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  return actualBytes.length === expectedBytes.length && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

export function sendDaemonRequest(address: string, request: DaemonRequest, timeoutMs = 1_000): Promise<DaemonResponse> {
  return new Promise<DaemonResponse>((resolve, reject) => {
    const socket = net.createConnection(address);
    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("agent-lcm daemon request timed out."));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", finishReject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        finishResolve(JSON.parse(buffer.slice(0, newline)) as DaemonResponse);
      } catch (error) {
        finishReject(error);
      }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));

    function finishResolve(response: DaemonResponse): void {
      clearTimeout(timeout);
      socket.end();
      resolve(response);
    }

    function finishReject(error: unknown): void {
      clearTimeout(timeout);
      socket.destroy();
      reject(error);
    }
  });
}

export function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && Reflect.get(error, "code") === code;
}

function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
