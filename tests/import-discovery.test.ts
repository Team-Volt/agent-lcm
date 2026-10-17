import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { IMPORT_HARNESSES } from "../src/import-types.ts";
import { IMPORT_DISCOVERY, importSources, needsExportHarnesses } from "../src/import-sources.ts";
import { loadConfig } from "../src/config.ts";
import { tempHome } from "./helpers.ts";

test("every import harness has a discovery row", () => {
  assert.deepEqual(Object.keys(IMPORT_DISCOVERY).sort(), [...IMPORT_HARNESSES].sort());
});

test("--all scans every scan harness and names needs_export instead of skipping it", () => {
  assert.deepEqual(needsExportHarnesses(), ["cursor", "vscode"]);
  const sources = importSources({ all: true, config: loadConfig({ home: tempHome("import-discovery-") }) });
  assert.deepEqual(sources.map((source) => source.harness), ["codex", "copilot", "kiro", "claude"]);
  assert.equal(sources.some((source) => source.harness === "cursor" || source.harness === "vscode"), false);
});

test("every scan harness has committed fixtures", () => {
  for (const harness of IMPORT_HARNESSES) {
    const discovery = IMPORT_DISCOVERY[harness];
    if (discovery.mode !== "scan") continue;
    assert.ok(discovery.fixturePaths.length > 0, harness);
    for (const fixture of discovery.fixturePaths) {
      assert.equal(fs.existsSync(fixture), true, fixture);
    }
  }
});
