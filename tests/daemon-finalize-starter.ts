import fs from "node:fs";
import path from "node:path";

import { loadConfig } from "../src/config.ts";
import { LcmStorage } from "../src/storage.ts";

const config = loadConfig();
const lockWaitReady = process.env.AGENT_LCM_TEST_LOCK_WAIT_READY;
if (lockWaitReady) {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((callback: (...arguments_: unknown[]) => void, delay?: number, ...arguments_: unknown[]) => {
    if (delay === 25 && !fs.existsSync(lockWaitReady)) fs.writeFileSync(lockWaitReady, "ready\n", { mode: 0o600 });
    return Reflect.apply(originalSetTimeout, globalThis, [callback, delay, ...arguments_]);
  }) as typeof globalThis.setTimeout;
}

const closeReady = process.env.AGENT_LCM_TEST_CLOSE_READY;
const closeRelease = process.env.AGENT_LCM_TEST_CLOSE_RELEASE;
if (closeReady && closeRelease) {
  const originalClose = LcmStorage.prototype.close;
  LcmStorage.prototype.close = function closeWithBarrier(): void {
    barrier(closeReady, closeRelease);
    originalClose.call(this);
  };
}

const metadataReady = process.env.AGENT_LCM_TEST_METADATA_READY;
const metadataRelease = process.env.AGENT_LCM_TEST_METADATA_RELEASE;
if (metadataReady && metadataRelease) {
  const pidPath = path.join(config.runtimeDir, "daemon.pid");
  const originalUnlink = fs.unlinkSync;
  let paused = false;
  fs.unlinkSync = ((filePath: fs.PathLike) => {
    if (!paused && path.resolve(String(filePath)) === pidPath) {
      paused = true;
      barrier(metadataReady, metadataRelease);
    }
    return originalUnlink(filePath);
  }) as typeof fs.unlinkSync;
}

const { startDaemon } = await import("../src/daemon.ts");
await startDaemon(config);

function barrier(ready: string, release: string): void {
  fs.writeFileSync(ready, "ready\n", { mode: 0o600 });
  const wait = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  while (!fs.existsSync(release)) Atomics.wait(wait, 0, 0, 10);
}
