import fs from "node:fs";
import path from "node:path";

const home = process.env.AGENT_LCM_HOME;
if (!home) throw new Error("AGENT_LCM_HOME is required.");

const lockPath = path.join(home, "runtime", "daemon.lock");
const markerDir = path.join(home, "runtime", "stale-race-markers");
const originalUnlink = fs.unlinkSync;
let intercepted = false;

fs.unlinkSync = ((filePath: fs.PathLike) => {
  if (!intercepted && path.resolve(String(filePath)) === lockPath) {
    intercepted = true;
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, String(process.pid)), "ready\n");
    const deadline = Date.now() + 400;
    while (fs.readdirSync(markerDir).length < 2 && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    const racers = fs.readdirSync(markerDir).map(Number).sort((left, right) => left - right);
    if (racers.length >= 2 && process.pid !== racers[0]) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
  return originalUnlink(filePath);
}) as typeof fs.unlinkSync;

const { main } = await import("../src/cli.ts");

main(["daemon", "run"]).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
