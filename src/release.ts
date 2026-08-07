import fs from "node:fs";
import path from "node:path";

import { pluginRoot } from "./config.ts";

export function packageVersion(): string {
  const value: unknown = JSON.parse(fs.readFileSync(path.join(pluginRoot(), "package.json"), "utf8"));
  if (!isRecord(value) || typeof value.version !== "string") throw new Error("Invalid Agent LCM package version.");
  return value.version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
