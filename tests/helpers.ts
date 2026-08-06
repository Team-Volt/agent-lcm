import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

export function tempHome(prefix = "agent-lcm-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function readJsonl(filePath: string): unknown[] {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (raw.length === 0) return [];
  return raw.split(/\r?\n/u).map((line) => JSON.parse(line));
}

export function runCli(args: string[], options: {
  input?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeout?: number;
} = {}) {
  return spawnSync(process.execPath, ["--no-warnings", "bin/agent-lcm", ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
    input: options.input,
    env: {
      ...process.env,
      ...options.env,
    },
    timeout: options.timeout ?? 10_000,
  });
}

export function assertCliOk(result: ReturnType<typeof runCli>): void {
  assert.equal(result.status, 0, result.stderr);
}

export function runMcp(requests: unknown[], env: NodeJS.ProcessEnv = {}) {
  const result = runCli(["mcp"], {
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env,
    timeout: 5_000,
  });
  assertCliOk(result);
  return result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

export function clearDerivedSummaries(home: string): void {
  const db = new DatabaseSync(path.join(home, "index.sqlite"));
  try {
    db.exec(`
      DELETE FROM summary_node_fts;
      DELETE FROM summary_nodes;
      DELETE FROM session_summary_fts;
      DELETE FROM session_summaries;
    `);
  } finally {
    db.close();
  }
}

export function rawRequest<T>(socketPath: string, request: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      socket.end();
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as { ok: boolean; result?: T; error?: string };
        if (!response.ok) reject(new Error(response.error ?? "daemon request failed"));
        else resolve(response.result as T);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
}
