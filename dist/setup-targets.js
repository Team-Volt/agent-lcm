import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export const SETUP_HARNESSES = ["codex", "cursor", "vscode", "copilot", "kiro", "claude", "opencode"];
export function claudeConfigPath(configDir = path.join(os.homedir(), ".claude")) {
    return path.join(path.resolve(configDir), "settings.json");
}
export function setupPath(harness, home) {
    if (harness === "claude")
        return claudeConfigPath(home);
    const harnessHome = setupHarnessHome(harness, home);
    if (harness === "opencode")
        return path.join(harnessHome, "plugins", "agent-lcm.ts");
    return harness === "codex" || harness === "cursor"
        ? path.join(harnessHome, "hooks.json")
        : path.join(harnessHome, "hooks", "agent-lcm.json");
}
export function openCodeConfigPath(home) {
    return path.join(setupHarnessHome("opencode", home), "opencode.json");
}
export function openCodeJsoncPath(home) {
    return path.join(setupHarnessHome("opencode", home), "opencode.jsonc");
}
export function openCodeStatePath(home) {
    return path.join(setupHarnessHome("opencode", home), "plugins", ".agent-lcm-opencode-plugin.state");
}
export function detectedHarnesses(userHome = os.homedir()) {
    const detected = [];
    if (fs.existsSync(defaultHarnessHome("codex", userHome)))
        detected.push("codex");
    if (fs.existsSync(defaultHarnessHome("cursor", userHome)))
        detected.push("cursor");
    if (fs.existsSync(defaultHarnessHome("copilot", userHome)))
        detected.push("copilot");
    else if (vscodeHomes(userHome).some((home) => fs.existsSync(home)))
        detected.push("vscode");
    if (fs.existsSync(defaultHarnessHome("kiro", userHome)))
        detected.push("kiro");
    if (fs.existsSync(defaultHarnessHome("claude", userHome)))
        detected.push("claude");
    if (fs.existsSync(defaultHarnessHome("opencode", userHome)))
        detected.push("opencode");
    return detected;
}
function defaultHarnessHome(harness, userHome) {
    switch (harness) {
        case "codex": return path.join(userHome, ".codex");
        case "cursor": return path.join(userHome, ".cursor");
        case "vscode":
        case "copilot": return path.join(userHome, ".copilot");
        case "kiro": return path.join(userHome, ".kiro");
        case "claude": return path.join(userHome, ".claude");
        case "opencode": return path.join(userHome, ".config", "opencode");
    }
}
function setupHarnessHome(harness, home) {
    return path.resolve(home ?? defaultHarnessHome(harness, os.homedir()));
}
function vscodeHomes(userHome) {
    return [
        path.join(userHome, ".vscode"),
        path.join(userHome, ".config", "Code"),
        path.join(userHome, "Library", "Application Support", "Code"),
        path.join(userHome, "AppData", "Roaming", "Code"),
    ];
}
