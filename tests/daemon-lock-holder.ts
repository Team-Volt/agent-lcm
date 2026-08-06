import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { loadConfig } from "../src/config.ts";

const config = loadConfig();
const ready = requiredEnvironment("AGENT_LCM_TEST_READY");
const release = requiredEnvironment("AGENT_LCM_TEST_RELEASE");
const lockPath = path.join(config.runtimeDir, "daemon.lock.sqlite");
fs.mkdirSync(config.runtimeDir, { recursive: true, mode: 0o700 });
fs.closeSync(fs.openSync(lockPath, "a", 0o600));
const database = new DatabaseSync(lockPath, { timeout: 0 });
database.exec("BEGIN EXCLUSIVE");
fs.writeFileSync(ready, "ready\n", { mode: 0o600 });
waitFor(release);
database.exec("ROLLBACK");
database.close();

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function waitFor(filePath: string): void {
  const wait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  while (!fs.existsSync(filePath)) Atomics.wait(wait, 0, 0, 10);
}
