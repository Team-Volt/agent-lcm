import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";

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
  if (process.platform !== "win32") return config.socketPath;
  const homeHash = crypto.createHash("sha256").update(config.home).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\agent-lcm-${homeHash}`;
}

export function readOrCreateToken(config: LcmConfig): string {
  fs.mkdirSync(config.runtimeDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(config.runtimeDir, 0o700);
  try {
    const descriptor = fs.openSync(config.tokenPath, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, `${crypto.randomBytes(32).toString("hex")}\n`);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
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
