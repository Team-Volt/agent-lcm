import fs from "node:fs";
import path from "node:path";
import { pluginRoot } from "./config.js";
export function packageVersion() {
    const value = JSON.parse(fs.readFileSync(path.join(pluginRoot(), "package.json"), "utf8"));
    if (!isRecord(value) || typeof value.version !== "string")
        throw new Error("Invalid Agent LCM package version.");
    return value.version;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
