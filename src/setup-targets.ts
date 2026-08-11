import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CaptureHarness } from "./harnesses.ts";

export const SETUP_HARNESSES: readonly CaptureHarness[] = ["codex", "cursor", "vscode", "copilot", "kiro"];

export function setupPath(
  harness: CaptureHarness,
  home?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const harnessHome = path.resolve(home ?? defaultHarnessHome(harness, os.homedir(), environment));
  if (harness === "codex" || harness === "cursor") return path.join(harnessHome, "hooks.json");
  if (harness === "vscode" || harness === "copilot") return path.join(harnessHome, "hooks", `agent-lcm-${harness}.json`);
  return path.join(harnessHome, "hooks", "agent-lcm.json");
}

export function detectedHarnesses(
  userHome = os.homedir(),
  environment: NodeJS.ProcessEnv = process.env,
): CaptureHarness[] {
  const detected: CaptureHarness[] = [];
  if (fs.existsSync(defaultHarnessHome("codex", userHome, environment))) detected.push("codex");
  if (fs.existsSync(defaultHarnessHome("cursor", userHome, environment))) detected.push("cursor");
  const copilotHome = defaultHarnessHome("copilot", userHome, environment);
  if (fs.existsSync(copilotHome)) {
    if (!hasInstalledAgentLcmCopilotPlugin(copilotHome)) detected.push("copilot");
  } else if (vscodeHomes(userHome).some((home) => fs.existsSync(home))) {
    detected.push("vscode");
  }
  if (fs.existsSync(defaultHarnessHome("kiro", userHome, environment))) detected.push("kiro");
  return detected;
}

function defaultHarnessHome(harness: CaptureHarness, userHome: string, environment: NodeJS.ProcessEnv): string {
  switch (harness) {
    case "codex": return path.join(userHome, ".codex");
    case "cursor": return path.join(userHome, ".cursor");
    case "vscode": return path.join(userHome, ".copilot");
    case "copilot": return environment.COPILOT_HOME?.trim() || path.join(userHome, ".copilot");
    case "kiro": return environment.KIRO_HOME?.trim() || path.join(userHome, ".kiro");
  }
}

function hasInstalledAgentLcmCopilotPlugin(copilotHome: string): boolean {
  const installed = path.join(copilotHome, "installed-plugins");
  if (!fs.existsSync(installed)) return false;
  const stack: Array<{ directory: string; depth: number }> = [{ directory: installed, depth: 0 }];
  while (stack.length > 0) {
    const current = stack.pop() as { directory: string; depth: number };
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(current.directory, entry.name);
      if (entry.isDirectory() && current.depth < 4) {
        stack.push({ directory: child, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile() || entry.name !== "plugin.json") continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(child, "utf8")) as unknown;
        if (!isRecord(manifest) || manifest.name !== "agent-lcm") continue;
        const pluginRoot = path.dirname(child);
        if (fs.existsSync(path.join(pluginRoot, "hooks.json"))) return true;
      } catch {
        // Ignore unrelated or partially installed plugin manifests.
      }
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function vscodeHomes(userHome: string): string[] {
  return [
    path.join(userHome, ".vscode"),
    path.join(userHome, ".config", "Code"),
    path.join(userHome, "Library", "Application Support", "Code"),
    path.join(userHome, "AppData", "Roaming", "Code"),
  ];
}
