import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultCodexSessionsPath } from "./codex-import.js";
import { IMPORT_HARNESSES } from "./import-types.js";
export const IMPORT_DISCOVERY = {
    codex: {
        mode: "scan",
        optional: true,
        fixturePaths: [
            "tests/fixtures/import/codex/session.jsonl",
            "tests/fixtures/import/codex/rollout-2026-08-01T10-00-00-12345678-1234-4234-8234-123456789abc.jsonl",
        ],
        scanPaths: (root) => [path.join(root, "codex", "sessions"), path.join(root, ".codex", "sessions")],
        defaultPath: () => defaultCodexSessionsPath(),
    },
    cursor: { mode: "needs_export" },
    vscode: { mode: "needs_export" },
    copilot: {
        mode: "scan",
        optional: true,
        fixturePaths: ["tests/fixtures/import/copilot/events.jsonl"],
        scanPaths: (root) => [path.join(root, "copilot", "session-state"), path.join(root, ".copilot", "session-state")],
        defaultPath: () => path.join(os.homedir(), ".copilot", "session-state"),
    },
    kiro: {
        mode: "scan",
        optional: true,
        fixturePaths: ["tests/fixtures/import/kiro/session.jsonl", "tests/fixtures/import/kiro/session.json"],
        scanPaths: (root) => [path.join(root, "kiro", "sessions", "cli"), path.join(root, ".kiro", "sessions", "cli")],
        defaultPath: () => path.join(os.homedir(), ".kiro", "sessions", "cli"),
    },
    claude: {
        mode: "scan",
        optional: true,
        fixturePaths: ["tests/fixtures/import/claude/projects/example-project/11111111-1111-4111-8111-111111111111.jsonl"],
        scanPaths: (root) => [path.join(root, ".claude", "projects")],
        defaultPath: () => path.join(os.homedir(), ".claude", "projects"),
    },
};
export function needsExportHarnesses() {
    return IMPORT_HARNESSES.filter((harness) => IMPORT_DISCOVERY[harness].mode === "needs_export");
}
export function importSources(options) {
    if (options.harness) {
        return [{
                harness: options.harness,
                paths: options.paths?.map((value) => path.resolve(value)) ?? [defaultImportPath(options.harness)],
                optional: IMPORT_DISCOVERY[options.harness].mode === "needs_export",
            }];
    }
    const roots = options.paths?.map((value) => path.resolve(value)) ?? [os.homedir()];
    return IMPORT_HARNESSES.flatMap((harness) => {
        const discovery = IMPORT_DISCOVERY[harness];
        if (discovery.mode !== "scan")
            return [];
        return [{
                harness,
                paths: roots.flatMap((root) => discovery.scanPaths(root)),
                optional: discovery.optional,
            }];
    });
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
    const discovery = IMPORT_DISCOVERY[harness];
    return discovery.mode === "scan" ? discovery.defaultPath() : "";
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
