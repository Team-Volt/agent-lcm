import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CaptureHarness } from "./harnesses.ts";

export const SETUP_HARNESSES: readonly CaptureHarness[] = ["codex", "cursor", "vscode", "copilot", "kiro", "claude"];

export function claudeConfigPath(configDir = path.join(os.homedir(), ".claude")): string {
  return path.join(path.resolve(configDir), "settings.json");
}

export function setupPath(harness: CaptureHarness, home?: string): string {
  if (harness === "claude") return claudeConfigPath(home);
  const harnessHome = path.resolve(home ?? defaultHarnessHome(harness, os.homedir()));
  return harness === "codex" || harness === "cursor"
    ? path.join(harnessHome, "hooks.json")
    : path.join(harnessHome, "hooks", "agent-lcm.json");
}

export function detectedHarnesses(userHome = os.homedir()): CaptureHarness[] {
  const detected: CaptureHarness[] = [];
  if (fs.existsSync(defaultHarnessHome("codex", userHome))) detected.push("codex");
  if (fs.existsSync(defaultHarnessHome("cursor", userHome))) detected.push("cursor");
  if (fs.existsSync(defaultHarnessHome("copilot", userHome))) detected.push("copilot");
  else if (vscodeHomes(userHome).some((home) => fs.existsSync(home))) detected.push("vscode");
  if (fs.existsSync(defaultHarnessHome("kiro", userHome))) detected.push("kiro");
  if (fs.existsSync(defaultHarnessHome("claude", userHome))) detected.push("claude");
  return detected;
}

function defaultHarnessHome(harness: CaptureHarness, userHome: string): string {
  switch (harness) {
    case "codex": return path.join(userHome, ".codex");
    case "cursor": return path.join(userHome, ".cursor");
    case "vscode":
    case "copilot": return path.join(userHome, ".copilot");
    case "kiro": return path.join(userHome, ".kiro");
    case "claude": return path.join(userHome, ".claude");
  }
}

function vscodeHomes(userHome: string): string[] {
  return [
    path.join(userHome, ".vscode"),
    path.join(userHome, ".config", "Code"),
    path.join(userHome, "Library", "Application Support", "Code"),
    path.join(userHome, "AppData", "Roaming", "Code"),
  ];
}
