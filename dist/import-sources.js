import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultCodexSessionsPath } from "./codex-import.js";
export function importSources(options) {
    if (options.harness) {
        return [{
                harness: options.harness,
                paths: options.paths?.map((value) => path.resolve(value)) ?? [defaultImportPath(options.harness)],
                optional: options.harness === "vscode" || options.harness === "cursor",
            }];
    }
    const roots = options.paths?.map((value) => path.resolve(value)) ?? [os.homedir()];
    return [
        { harness: "codex", paths: roots.flatMap((root) => [path.join(root, "codex", "sessions"), path.join(root, ".codex", "sessions")]), optional: true },
        { harness: "copilot", paths: roots.flatMap((root) => [path.join(root, "copilot", "session-state"), path.join(root, ".copilot", "session-state")]), optional: true },
        { harness: "kiro", paths: roots.flatMap((root) => [path.join(root, "kiro", "sessions", "cli"), path.join(root, ".kiro", "sessions", "cli")]), optional: true },
    ];
}
export function importFiles(harness, sources) {
    return sources.flatMap(walkFiles).filter((file) => {
        const name = path.basename(file);
        if (harness === "codex")
            return name.endsWith(".jsonl");
        if (harness === "copilot")
            return name === "events.jsonl";
        if (harness === "kiro")
            return name.endsWith(".jsonl") || name === "session.json";
        if (harness === "claude")
            return name.endsWith(".jsonl") && !file.split(path.sep).includes("subagents");
        if (harness === "vscode")
            return name.endsWith(".json");
        return name.endsWith(".md");
    }).sort((left, right) => left.localeCompare(right));
}
function defaultImportPath(harness) {
    if (harness === "codex")
        return defaultCodexSessionsPath();
    if (harness === "copilot")
        return path.join(os.homedir(), ".copilot", "session-state");
    if (harness === "kiro")
        return path.join(os.homedir(), ".kiro", "sessions", "cli");
    return "";
}
function walkFiles(source) {
    if (!fs.existsSync(source))
        return [];
    const stat = fs.statSync(source);
    if (stat.isFile())
        return [source];
    const result = [];
    const stack = [source];
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current)
            break;
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const child = path.join(current, entry.name);
            if (entry.isDirectory())
                stack.push(child);
            else if (entry.isFile())
                result.push(child);
        }
    }
    return result;
}
